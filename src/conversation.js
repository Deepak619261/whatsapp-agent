// The conversation orchestrator: inbound WhatsApp → debounce → AI → humanized reply.
// This is the local reimplementation of 1prompt-os's processMessages debounce +
// n8n text-engine pattern (see NOTES.md).

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { store } from './store.js';
import { sendWhatsApp } from './twilio.js';
import { sleep, typingDelayMs, splitReply } from './humanize.js';

const PROMPT_PATH = fileURLToPath(new URL('../prompt.txt', import.meta.url));
const KNOWLEDGE_PATH = fileURLToPath(new URL('../knowledge.txt', import.meta.url));

let adapter = null;
export function setAdapter(a) {
  adapter = a;
}

// The WhatsApp sender is injectable so tests can substitute a fake. Defaults to
// the real Twilio send.
let sender = sendWhatsApp;
export function setSender(fn) {
  sender = fn;
}

// Per-lead debounce/processing state.
// key -> { buffer: string[], timer: NodeJS.Timeout|null, processing: boolean }
const pending = new Map();

function stateFor(key) {
  let s = pending.get(key);
  if (!s) {
    s = { buffer: [], timer: null, processing: false };
    pending.set(key, s);
  }
  return s;
}

/** Retry a call on transient network errors (not on auth/quota errors). */
async function withRetry(fn, onRetry, { retries = 2, baseMs = 1200 } = {}) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      const msg = String(err?.message || '');
      const transient = /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang|network|ECONNREFUSED|50[234]/i.test(msg);
      if (!transient || i >= retries) throw err;
      if (onRetry) onRetry(i + 1, err);
      await sleep(baseMs * (i + 1));
    }
  }
}

/**
 * Build the effective system prompt: editable prompt.txt + knowledge base +
 * this lead's context. All files are re-read per reply, so you can edit them
 * without restarting.
 */
function buildSystemPrompt(lead) {
  let base;
  try {
    base = fs.readFileSync(PROMPT_PATH, 'utf8');
  } catch {
    base = 'You are a friendly AI setter. Keep replies short and book a call.';
  }

  // Knowledge base — business facts the setter can answer from. Optional file.
  let kb = '';
  try {
    const raw = fs.readFileSync(KNOWLEDGE_PATH, 'utf8').trim();
    if (raw) {
      kb =
        '\n\n---\nKNOWLEDGE BASE (answer questions using ONLY these facts; if something ' +
        "isn't here, say you'll check with the team and steer back to booking the call — " +
        'never invent prices, offers, or details):\n' +
        raw;
    }
  } catch {
    /* no knowledge.txt — fine */
  }

  const ctx = [
    '\n\n---\nCURRENT LEAD (you are messaging this person right now):',
    `- Name: ${lead.name || 'unknown'}`,
    `- They said they are interested in: ${lead.interest || 'unknown'}`,
    'Use their name naturally (not every message). Never re-ask something they already told you.',
  ].join('\n');
  return base + kb + ctx;
}

/**
 * Inbound message arrived (from the Twilio webhook). Buffer it and (re)arm the
 * debounce timer. A burst of messages keeps resetting the window — so we answer
 * the whole burst once, not per-message.
 */
export function handleInbound(number, text) {
  const lead = store.getOrCreateLead(number);
  const s = stateFor(lead.id);

  store.addLog({
    type: 'inbound',
    direction: 'in',
    leadId: lead.id,
    name: lead.name,
    number: lead.id,
    text,
  });

  if (lead.active === false) {
    store.appendHistory(lead.id, 'user', text);
    store.addLog({
      type: 'system',
      leadId: lead.id,
      name: lead.name,
      text: `AI response is paused for this lead. Saved message to history.`,
    });
    return;
  }

  s.buffer.push(text);

  const { debounceMs } = store.getConfig();
  store.addLog({
    type: 'debounce',
    leadId: lead.id,
    name: lead.name,
    text: `debouncing… waiting ${(debounceMs / 1000).toFixed(1)}s for more messages (buffered: ${s.buffer.length})`,
  });

  armTimer(lead.id);
}

function armTimer(key) {
  const s = stateFor(key);
  if (s.timer) clearTimeout(s.timer);
  const { debounceMs } = store.getConfig();
  s.timer = setTimeout(() => runProcess(key), debounceMs);
}

async function runProcess(key) {
  const s = stateFor(key);
  s.timer = null;

  // If a reply is already being generated/sent, wait and retry shortly.
  if (s.processing) {
    armTimer(key);
    return;
  }
  if (s.buffer.length === 0) return;

  const lead = store.getLead(key);
  if (!lead || lead.active === false) {
    if (lead && lead.active === false) {
      const grouped = s.buffer.splice(0).join('\n');
      store.appendHistory(key, 'user', grouped);
      store.addLog({
        type: 'system',
        leadId: key,
        name: lead.name,
        text: `lead deactivated during debounce window; flushed messages to history.`,
      });
    }
    return;
  }

  s.processing = true;
  // Group the burst into ONE user turn, joined with newlines (mirrors 1prompt-os).
  const grouped = s.buffer.splice(0).join('\n');

  try {
    store.appendHistory(key, 'user', grouped);
    store.addLog({
      type: 'grouped',
      leadId: key,
      name: lead.name,
      text: `debounce cleared → sending ${grouped.split('\n').length} message(s) to ${adapter?.name} as one turn`,
    });

    const reply = await generateAndSend(lead);
    store.appendHistory(key, 'assistant', reply);
  } catch (err) {
    store.addLog({ type: 'error', leadId: key, name: lead.name, text: `error: ${err.message}` });
    // Never leave the lead in silence — send a soft holding line if we still can.
    try {
      await sender(key, "one sec — give me a moment and i'll get right back to you 🙂");
    } catch { /* sending itself is down; nothing more we can do */ }
  } finally {
    s.processing = false;
    // Messages that arrived while we were working get their own reply next.
    if (s.buffer.length > 0) armTimer(key);
  }
}

// The opener strategy is pluggable. Default = AI writes a free-form first
// message (works on Twilio sandbox). On WhatsApp Cloud API the server swaps this
// for a template-based opener (Meta requires a template to start a conversation).
async function aiOpener(lead) {
  const seed = [
    {
      role: 'user',
      content:
        `[A new lead just came in through the website form. Name: ${lead.name || 'unknown'}. ` +
        `They said they're interested in: ${lead.interest || 'unknown'}. ` +
        `Send your very first WhatsApp message to open the conversation — warm, short, one question.]`,
    },
  ];
  return sendReplyMessages(lead, seed, { seed: true });
}

let openerFn = aiOpener;
/** Override the first-message strategy (e.g. Cloud API template). fn(lead) -> text sent. */
export function setOpener(fn) {
  openerFn = fn;
}

/** Send the FIRST outreach message to a brand-new lead (form-initiated). */
export async function sendFirstMessage(lead) {
  const s = stateFor(lead.id);
  s.processing = true;
  try {
    const openerText = await openerFn(lead);
    // Record the assistant's opener in history so the AI has context for replies.
    store.appendHistory(lead.id, 'assistant', openerText);
  } catch (err) {
    store.addLog({ type: 'error', leadId: lead.id, name: lead.name, text: `error: ${err.message}` });
    throw err;
  } finally {
    s.processing = false;
  }
}

/** Generate a reply from the lead's full history and send it, humanized. */
async function generateAndSend(lead) {
  return sendReplyMessages(lead, lead.history, { seed: false });
}

/**
 * Core send path: run the adapter, then apply the humanization layer
 * (typing delay + optional 2-message split) and send over WhatsApp.
 * Returns the full reply text (joined) for history.
 */
async function sendReplyMessages(lead, messages, { seed }) {
  if (!adapter) throw new Error('AI adapter not initialized');

  const systemPrompt = buildSystemPrompt(lead);
  // Pass a copy so history mutations after the call can never alias the request.
  // Retry transient network blips (flaky Wi-Fi, dropped sockets) automatically.
  const reply = await withRetry(
    () => adapter.generateReply(systemPrompt, messages.slice()),
    (attempt, err) =>
      store.addLog({
        type: 'system',
        leadId: lead.id,
        name: lead.name,
        text: `network hiccup (${err.message.slice(0, 40)}…) — retrying (${attempt})`,
      })
  );
  if (!reply) throw new Error('AI returned an empty reply');

  const cfg = store.getConfig();
  const parts = splitReply(reply, cfg.splitMessages);

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const delay = typingDelayMs(part, cfg);
    store.addLog({
      type: 'typing',
      leadId: lead.id,
      name: lead.name,
      text: `typing… (${(delay / 1000).toFixed(1)}s)${parts.length > 1 ? ` [msg ${i + 1}/${parts.length}]` : ''}`,
    });
    await sleep(delay);

    await sender(lead.id, part);
    store.addLog({
      type: 'outbound',
      direction: 'out',
      leadId: lead.id,
      name: lead.name,
      number: lead.id,
      text: part,
    });
  }

  return parts.join(' ');
}
