// The humanization layer — makes the setter feel like a person, not a bot.
//
// Two behaviors, both mirroring 1prompt-os:
//   1) A realistic "typing" pause before sending, scaled to the reply length so
//      it never feels instant/robotic.
//   2) Optionally splitting a longer reply into 2 short sequential WhatsApp
//      messages (their n8n engine returns Message_1..Message_5 the same way).

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * How long to "type" before sending, based on reply length.
 * @param {string} text
 * @param {{typingMinMs:number, typingPerCharMs:number, typingMaxMs:number}} cfg
 */
export function typingDelayMs(text, cfg) {
  const len = (text || '').length;
  const raw = cfg.typingMinMs + len * cfg.typingPerCharMs;
  return Math.min(cfg.typingMaxMs, Math.max(cfg.typingMinMs, Math.round(raw)));
}

/**
 * Split a reply into 1 or 2 short messages. Only splits when enabled AND the
 * reply is long enough to be worth breaking up. Splits on a sentence/line
 * boundary near the middle so each half reads naturally.
 * @param {string} text
 * @param {boolean} enabled
 * @returns {string[]}
 */
export function splitReply(text, enabled) {
  const clean = (text || '').trim();
  if (!enabled || clean.length < 100) return [clean].filter(Boolean);

  // Prefer an explicit line break the model may have produced.
  const byLine = clean.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  if (byLine.length >= 2) {
    const mid = Math.ceil(byLine.length / 2);
    return [byLine.slice(0, mid).join(' '), byLine.slice(mid).join(' ')];
  }

  // Otherwise split on sentence boundaries near the midpoint.
  const parts = clean.match(/[^.!?]+[.!?]*\s*/g);
  if (!parts || parts.length < 2) return [clean];

  const target = clean.length / 2;
  let acc = 0;
  let cut = 1;
  for (let i = 0; i < parts.length; i++) {
    acc += parts[i].length;
    if (acc >= target) {
      cut = i + 1;
      break;
    }
  }
  const first = parts.slice(0, cut).join('').trim();
  const second = parts.slice(cut).join('').trim();
  return [first, second].filter(Boolean);
}
