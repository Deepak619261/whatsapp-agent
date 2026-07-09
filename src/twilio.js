// Twilio WhatsApp — outbound sending via the official Twilio Node SDK.
import twilio from 'twilio';
import { normalizeNumber } from './store.js';

let client = null;
let from = null;

/** Initialize the Twilio client from env. Returns false if not configured. */
export function initTwilio() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  from = process.env.TWILIO_WHATSAPP_FROM;

  if (!sid || !token || !from) {
    return false;
  }
  client = twilio(sid, token);
  // Ensure the from address carries the whatsapp: channel prefix.
  if (!/^whatsapp:/i.test(from)) from = 'whatsapp:' + normalizeNumber(from);
  return true;
}

export function isTwilioReady() {
  return client !== null;
}

/**
 * Send one WhatsApp message.
 * @param {string} toNumber E.164 (with or without the whatsapp: prefix)
 * @param {string} body
 */
export async function sendWhatsApp(toNumber, body) {
  if (!client) {
    throw new Error(
      'Twilio is not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_WHATSAPP_FROM in .env.'
    );
  }
  const to = 'whatsapp:' + normalizeNumber(toNumber);
  return client.messages.create({ from, to, body });
}
