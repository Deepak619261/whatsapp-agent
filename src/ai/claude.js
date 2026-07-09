// Claude (Anthropic) adapter — native Anthropic Messages API via the official SDK.
import Anthropic from '@anthropic-ai/sdk';
import { cleanKey } from './util.js';

export function createClaudeAdapter() {
  const apiKey = cleanKey('ANTHROPIC_API_KEY', process.env.ANTHROPIC_API_KEY);
  if (!apiKey) {
    throw new Error(
      'AI_PROVIDER=claude but ANTHROPIC_API_KEY is missing. Add it to your .env.'
    );
  }
  const model = process.env.CLAUDE_MODEL || 'claude-sonnet-5';
  const client = new Anthropic({ apiKey });

  return {
    name: 'claude',
    model,
    /**
     * @param {string} systemPrompt
     * @param {{role:'user'|'assistant', content:string}[]} messages
     * @returns {Promise<string>}
     */
    async generateReply(systemPrompt, messages) {
      const resp = await client.messages.create({
        model,
        max_tokens: 512,
        system: systemPrompt,
        messages, // Anthropic accepts [{role:'user'|'assistant', content:string}]
      });
      // content is an array of blocks; concatenate the text blocks.
      return resp.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim();
    },
  };
}
