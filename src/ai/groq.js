// Groq adapter — Groq's OpenAI-compatible API via the official OpenAI SDK
// pointed at Groq's base URL. Groq's free tier has generous daily limits and is
// very fast, which makes it the best pick for demos.
import OpenAI from 'openai';
import { cleanKey } from './util.js';

export function createGroqAdapter() {
  const apiKey = cleanKey('GROQ_API_KEY', process.env.GROQ_API_KEY);
  if (!apiKey) {
    throw new Error(
      'AI_PROVIDER=groq but GROQ_API_KEY is missing. Get a free key at https://console.groq.com/keys and add it to your .env.'
    );
  }
  const model = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
  const client = new OpenAI({ apiKey, baseURL: 'https://api.groq.com/openai/v1' });

  return {
    name: 'groq',
    model,
    /**
     * @param {string} systemPrompt
     * @param {{role:'user'|'assistant', content:string}[]} messages
     * @returns {Promise<string>}
     */
    async generateReply(systemPrompt, messages) {
      const resp = await client.chat.completions.create({
        model,
        max_tokens: 512,
        messages: [{ role: 'system', content: systemPrompt }, ...messages],
      });
      return (resp.choices[0]?.message?.content || '').trim();
    },
  };
}
