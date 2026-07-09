// AI provider factory + fallback chain.
//
// The adapter interface is tiny:
//     generateReply(systemPrompt, messages) -> Promise<string>
//
// Primary provider = AI_PROVIDER. If it hits a rate limit / quota / error, the
// request is automatically retried on the fallback provider(s) — with the SAME
// systemPrompt + messages, so the conversation context is fully preserved.
//
// Fallbacks: AI_FALLBACK=groq,gemini,... (comma list). If unset, every OTHER
// provider that has a valid key is used as a fallback, in a sensible order.
import { store } from '../store.js';
import { createClaudeAdapter } from './claude.js';
import { createOpenAIAdapter } from './openai.js';
import { createGeminiAdapter } from './gemini.js';
import { createGroqAdapter } from './groq.js';

const FACTORIES = {
  claude: createClaudeAdapter,
  openai: createOpenAIAdapter,
  gemini: createGeminiAdapter,
  groq: createGroqAdapter,
};

// Default fallback order (excluding whichever is primary).
const DEFAULT_ORDER = ['gemini', 'groq', 'openai', 'claude'];

/** Wrap an ordered list of adapters so a failure falls through to the next one. */
export function createChain(adapters) {
  return {
    name: adapters.map((a) => a.name).join(' → '),
    model: adapters[0].model,
    providers: adapters,
    async generateReply(systemPrompt, messages) {
      let lastErr;
      for (let i = 0; i < adapters.length; i++) {
        const a = adapters[i];
        try {
          const reply = await a.generateReply(systemPrompt, messages);
          if (!reply || !reply.trim()) throw new Error('empty reply');
          if (i > 0) {
            store.addLog({ type: 'system', text: `✅ recovered on fallback provider: ${a.name}` });
          }
          return reply;
        } catch (err) {
          lastErr = err;
          const next = adapters[i + 1];
          if (next) {
            store.addLog({
              type: 'system',
              text: `⚠️ ${a.name} failed (${short(err.message)}) → falling back to ${next.name}`,
            });
          }
        }
      }
      throw lastErr;
    },
  };
}

function short(msg) {
  const m = String(msg || '');
  if (/429|rate limit|quota|RESOURCE_EXHAUSTED|exceeded/i.test(m)) return 'rate limit / quota';
  return m.slice(0, 50);
}

/**
 * Build the adapter for AI_PROVIDER, plus any available fallbacks.
 * Fails loudly if the primary provider is unknown or its key is missing.
 */
export function createAdapter() {
  const provider = (process.env.AI_PROVIDER || '').trim().toLowerCase();
  if (!provider) {
    throw new Error('AI_PROVIDER is not set. Set it to one of: claude | openai | gemini | groq.');
  }
  const factory = FACTORIES[provider];
  if (!factory) {
    throw new Error(`AI_PROVIDER="${provider}" is not supported. Use one of: ${Object.keys(FACTORIES).join(' | ')}.`);
  }
  const primary = factory(); // throws if the primary key is missing → fail loud at startup

  // Decide the fallback list.
  const spec = (process.env.AI_FALLBACK || '').trim();
  let names = spec
    ? spec.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    : DEFAULT_ORDER;
  names = names.filter((n) => n !== provider && FACTORIES[n]);

  // Build each fallback whose key is present; silently skip the rest.
  const fallbacks = [];
  for (const n of names) {
    try {
      fallbacks.push(FACTORIES[n]());
    } catch {
      /* key missing for this provider — skip it */
    }
  }

  if (fallbacks.length === 0) return primary;
  return createChain([primary, ...fallbacks]);
}
