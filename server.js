import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAdapter } from './src/ai/index.js';
import { initTwilio, isTwilioReady, sendWhatsApp } from './src/twilio.js';
import { initCloud, isCloudReady, sendCloudText, sendCloudTemplate } from './src/cloudwhatsapp.js';
import { store, normalizeNumber } from './src/store.js';
import { setAdapter, setSender, setOpener, handleInbound, sendFirstMessage } from './src/conversation.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '3000', 10);

// ---------------------------------------------------------------------------
// Startup: build the AI adapter (fails LOUDLY if the selected provider's key is
// missing) and initialize Twilio.
// ---------------------------------------------------------------------------
let adapter;
try {
  adapter = createAdapter();
} catch (err) {
  console.error('\n❌ AI provider startup failed:\n   ' + err.message + '\n');
  console.error('   Fix your .env (AI_PROVIDER + that provider\'s API key), then restart.\n');
  process.exit(1);
}
setAdapter(adapter);
store.setProvider({ name: adapter.name, model: adapter.model });

// ---------------------------------------------------------------------------
// Messaging channel: "twilio" (default) or "cloud" (WhatsApp Cloud API / Meta).
// ---------------------------------------------------------------------------
const CHANNEL = (process.env.CHANNEL || 'twilio').trim().toLowerCase();
let channelReady = false;
let channelLabel = '';

if (CHANNEL === 'cloud') {
  channelReady = initCloud();
  setSender(sendCloudText); // free-form replies (within 24h window)

  const template = (process.env.WHATSAPP_OPENER_TEMPLATE || '').trim();
  const lang = (process.env.WHATSAPP_OPENER_LANG || 'en').trim();
  if (template) {
    // Which body variables to send, in order. Keywords: name, interest, brand.
    // Anything else is used as a literal. Examples:
    //   name,interest        → {{1}}=name, {{2}}=interest
    //   name,brand,interest  → {{1}}=name, {{2}}=WHATSAPP_BRAND, {{3}}=interest
    //   none                 → no variables (e.g. hello_world)
    const varsSpec = (process.env.WHATSAPP_OPENER_VARS ?? 'name,interest').trim();
    const brand = (process.env.WHATSAPP_BRAND || 'us').trim();
    // Meta requires a pre-approved TEMPLATE to start a conversation.
    setOpener(async (lead) => {
      const vars = (!varsSpec || varsSpec.toLowerCase() === 'none')
        ? []
        : varsSpec.split(',').map((k) => {
            const key = k.trim();
            const lk = key.toLowerCase();
            if (lk === 'name') return lead.name || 'there';
            if (lk === 'interest') return lead.interest || 'what you reached out about';
            if (lk === 'brand') return brand;
            return key; // literal value
          });
      await sendCloudTemplate(lead.id, template, lang, vars);
      const text = vars.length ? renderOpenerText(lead) : `[template: ${template}]`;
      store.addLog({ type: 'outbound', direction: 'out', leadId: lead.id, name: lead.name, number: lead.id, text: `[template: ${template}] ${text}` });
      return text;
    });
    channelLabel = `WhatsApp Cloud API (opener template: ${template})`;
  } else {
    channelLabel = 'WhatsApp Cloud API (⚠️ no opener template set — first message will fail on a real number)';
  }
} else {
  channelReady = initTwilio();
  setSender(sendWhatsApp);
  channelLabel = 'Twilio';
}
store.setChannel(CHANNEL, channelReady);

/** Best-effort text of the opener (for the log + AI history) — matches your template body. */
function renderOpenerText(lead) {
  const tmpl = process.env.WHATSAPP_OPENER_TEXT
    || 'Hi {{name}}! thanks for reaching out about {{interest}} 👋 mind if I ask you a couple quick questions here?';
  return tmpl
    .replace(/\{\{name\}\}/g, lead.name || 'there')
    .replace(/\{\{interest\}\}/g, lead.interest || 'what you reached out about')
    .replace(/\{\{brand\}\}/g, (process.env.WHATSAPP_BRAND || 'us').trim());
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
const app = express();
app.use('/webhook', express.urlencoded({ extended: false })); // Twilio posts form-encoded
app.use(express.json());

// --- Admin auth (HTTP Basic) — protects the control panel + all /api routes.
// The Meta webhook stays public (below) so WhatsApp can reach it.
// Credentials come from env ONLY (no hardcoded secret in the repo). Set
// ADMIN_EMAIL / ADMIN_PASSWORD in .env locally and as secrets on the host.
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').trim();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
  console.warn('⚠️  ADMIN_EMAIL / ADMIN_PASSWORD not set — control panel is LOCKED (all non-webhook requests denied). Set them in .env / host env.');
}
app.use((req, res, next) => {
  if (req.path.startsWith('/webhook') || req.path === '/health') return next(); // webhook + health check stay open
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    return res.status(401).send('Admin auth not configured');
  }
  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const i = decoded.indexOf(':');
    if (decoded.slice(0, i) === ADMIN_EMAIL && decoded.slice(i + 1) === ADMIN_PASSWORD) {
      return next();
    }
  }
  res.set('WWW-Authenticate', 'Basic realm="1prompt Setter"').status(401).send('Authentication required');
});

app.use(express.static(path.join(__dirname, 'public')));

// Public health check — for the host's health probe + uptime monitors (no auth).
app.get('/health', (req, res) => res.status(200).json({ ok: true }));

// --- Cloud API webhook verification (Meta sends a GET challenge) ------------
app.get('/webhook/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const verifyToken = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && verifyToken === process.env.WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Dedupe Meta's webhook retries — it can deliver the same message id 2-3 times.
const seenMessageIds = new Set();
function alreadyHandled(id) {
  if (!id) return false;
  if (seenMessageIds.has(id)) return true;
  seenMessageIds.add(id);
  // Cap memory: keep the most recent ~2000 ids.
  if (seenMessageIds.size > 2000) {
    seenMessageIds.delete(seenMessageIds.values().next().value);
  }
  return false;
}

// --- Inbound WhatsApp webhook (Twilio OR Cloud API → us) -------------------
app.post('/webhook/whatsapp', (req, res) => {
  if (CHANNEL === 'cloud') {
    try {
      // A Cloud API payload can carry messages OR status updates (sent/delivered/
      // read) OR nothing relevant. Only text messages drive the conversation;
      // everything else is safely ignored.
      const value = req.body?.entry?.[0]?.changes?.[0]?.value;
      const msg = value?.messages?.[0];
      if (msg && !alreadyHandled(msg.id)) {
        const from = normalizeNumber(msg.from); // Meta gives digits, no '+'
        const name = value?.contacts?.[0]?.profile?.name || '';
        if (msg.type === 'text') {
          const body = (msg.text?.body || '').trim();
          if (from && body) {
            store.getOrCreateLead(from, { name });
            handleInbound(from, body);
          }
        } else if (from) {
          // Non-text (image, audio, sticker, location…): don't crash, nudge to text.
          store.getOrCreateLead(from, { name });
          store.addLog({ type: 'inbound', direction: 'in', leadId: from, name, number: from, text: `[${msg.type} message]` });
          handleInbound(from, `[the lead sent a ${msg.type} message — you can only read text; gently ask them to type their question]`);
        }
      }
    } catch (err) {
      store.addLog({ type: 'error', text: `inbound webhook parse error: ${err.message}` });
    }
    return res.sendStatus(200); // Meta needs a fast 200
  }

  // Twilio: form-encoded body; reply is sent later after debounce via REST API.
  const from = req.body.From || req.body.from || '';
  const body = (req.body.Body || req.body.body || '').trim();
  if (from && body) {
    handleInbound(normalizeNumber(from), body);
  }
  res.set('Content-Type', 'text/xml').send('<Response></Response>');
});

// --- Lead form (control panel → us): create lead + AI sends first message ---
app.post('/api/lead', async (req, res) => {
  const { name = '', number = '', interest = '' } = req.body || {};
  const normalized = normalizeNumber(number);
  if (!normalized || normalized.length < 8) {
    return res.status(400).json({ error: 'A valid WhatsApp number (E.164, e.g. +15551234567) is required.' });
  }
  if (!channelReady) {
    const msg = CHANNEL === 'cloud'
      ? 'WhatsApp Cloud API is not configured. Set WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID in .env and restart.'
      : 'Twilio is not configured. Set TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_WHATSAPP_FROM in .env and restart.';
    return res.status(400).json({ error: msg });
  }

  const lead = store.getOrCreateLead(normalized, { name, interest });
  store.addLog({ type: 'system', leadId: lead.id, name: lead.name, text: `new lead via form: ${lead.name || lead.id} (${lead.interest || 'no interest given'})` });

  try {
    await sendFirstMessage(lead);
    res.json({ ok: true, lead: { id: lead.id, name: lead.name, interest: lead.interest } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- State + config (control panel) ----------------------------------------
app.get('/api/state', (req, res) => {
  res.json(store.snapshot());
});

app.post('/api/config', (req, res) => {
  res.json(store.setConfig(req.body || {}));
});

app.post('/api/lead/toggle', (req, res) => {
  const { number, active } = req.body || {};
  if (!number) {
    return res.status(400).json({ error: 'Number is required' });
  }
  const lead = store.toggleLeadActive(number, active);
  if (!lead) {
    return res.status(404).json({ error: 'Lead not found' });
  }
  res.json({ ok: true, lead: { id: lead.id, number: lead.number, active: lead.active } });
});

// --- Live log stream (SSE) --------------------------------------------------
app.get('/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();

  const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  send('snapshot', store.snapshot());

  const onLog = (e) => send('log', e);
  const onLeads = (l) => send('leads', l);
  const onConfig = (c) => send('config', c);
  store.on('log', onLog);
  store.on('leads', onLeads);
  store.on('config', onConfig);

  const ping = setInterval(() => res.write(': ping\n\n'), 25000);

  req.on('close', () => {
    clearInterval(ping);
    store.off('log', onLog);
    store.off('leads', onLeads);
    store.off('config', onConfig);
  });
});

// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  const line = '─'.repeat(60);
  console.log('\n' + line);
  console.log('  1prompt Setter Demo is running');
  console.log(line);
  console.log(`  Control panel:   http://localhost:${PORT}`);
  console.log(`  AI provider:     ${adapter.name}  (model: ${adapter.model})`);
  console.log(`  Debounce:        ${store.getConfig().debounceMs} ms   Split: ${store.getConfig().splitMessages}`);
  console.log(`  Channel:         ${channelLabel}  ${channelReady ? '✅' : '⚠️  NOT configured'}`);
  console.log(line);
  console.log('  NEXT: expose this server so WhatsApp can reach the webhook:');
  console.log(`     1) In another terminal:  ngrok http ${PORT}`);
  console.log('     2) Copy the https URL ngrok prints.');
  if (CHANNEL === 'cloud') {
    console.log('     3) Meta app → WhatsApp → Configuration → Webhooks → Edit:');
    console.log('           Callback URL:  https://<your-ngrok>/webhook/whatsapp');
    console.log(`           Verify token:  ${process.env.WHATSAPP_VERIFY_TOKEN || '(set WHATSAPP_VERIFY_TOKEN in .env)'}`);
    console.log('           then subscribe to the "messages" field.');
  } else {
    console.log('     3) Twilio Console → WhatsApp Sandbox → "When a message comes in":');
    console.log('           https://<your-ngrok>.ngrok-free.app/webhook/whatsapp   (POST)');
  }
  console.log(line + '\n');
});
