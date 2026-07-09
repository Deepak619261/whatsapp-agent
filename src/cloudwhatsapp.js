// WhatsApp Cloud API (Meta) channel — official, safe, free-tier friendly.
// Used when CHANNEL=cloud. Sends via graph.facebook.com; inbound arrives on the
// webhook handled in server.js.
import { normalizeNumber } from './store.js';

const GRAPH = 'https://graph.facebook.com/v22.0';

let token = null;
let phoneNumberId = null;

/** Initialize from env. Returns false if not configured. */
export function initCloud() {
  token = (process.env.WHATSAPP_TOKEN || '').trim();
  phoneNumberId = (process.env.WHATSAPP_PHONE_NUMBER_ID || '').trim();
  return isCloudReady();
}

export function isCloudReady() {
  return !!(token && phoneNumberId);
}

/** Cloud API wants the bare international number, digits only (no + / no whatsapp:). */
function toWaId(num) {
  return normalizeNumber(num).replace(/\D/g, '');
}

async function post(payload) {
  if (!isCloudReady()) {
    throw new Error('WhatsApp Cloud API not configured. Set WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID in .env.');
  }
  const r = await fetch(`${GRAPH}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`WhatsApp Cloud API ${r.status}: ${text.slice(0, 300)}`);
  }
  return r.json();
}

/** Free-form text message (only allowed within 24h of the lead's last message). */
export async function sendCloudText(to, body) {
  return post({
    messaging_product: 'whatsapp',
    to: toWaId(to),
    type: 'text',
    text: { preview_url: false, body },
  });
}

/**
 * Template message (required to START a conversation).
 * @param {string} to
 * @param {string} name  template name
 * @param {string} lang  language code, e.g. "en"
 * @param {string[]} vars  ordered body variables → {{1}}, {{2}}, ...
 */
export async function sendCloudTemplate(to, name, lang, vars = []) {
  const parameters = vars.map((v) => ({ type: 'text', text: String(v) }));
  return post({
    messaging_product: 'whatsapp',
    to: toWaId(to),
    type: 'template',
    template: {
      name,
      language: { code: lang || 'en' },
      ...(parameters.length ? { components: [{ type: 'body', parameters }] } : {}),
    },
  });
}
