// OpenAI adapter — native OpenAI Chat Completions API via the official SDK.
import OpenAI from 'openai';
import { cleanKey } from './util.js';

export function createOpenAIAdapter() {
  const apiKey = cleanKey('OPENAI_API_KEY', process.env.OPENAI_API_KEY);
  if (!apiKey) {
    throw new Error(
      'AI_PROVIDER=openai but OPENAI_API_KEY is missing. Add it to your .env.'
    );
  }
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const client = new OpenAI({ apiKey });

  return {
    name: 'openai',
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
