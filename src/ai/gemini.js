// Google Gemini adapter — native Gemini API via the official SDK.
import { GoogleGenerativeAI } from '@google/generative-ai';
import { cleanKey } from './util.js';

export function createGeminiAdapter() {
  const apiKey = cleanKey('GEMINI_API_KEY', process.env.GEMINI_API_KEY);
  if (!apiKey) {
    throw new Error(
      'AI_PROVIDER=gemini but GEMINI_API_KEY is missing. Add it to your .env.'
    );
  }
  const modelName = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const genAI = new GoogleGenerativeAI(apiKey);

  return {
    name: 'gemini',
    model: modelName,
    /**
     * @param {string} systemPrompt
     * @param {{role:'user'|'assistant', content:string}[]} messages
     * @returns {Promise<string>}
     */
    async generateReply(systemPrompt, messages) {
      const model = genAI.getGenerativeModel({
        model: modelName,
        systemInstruction: systemPrompt,
      });
      // Gemini uses role 'user' | 'model' and a parts[] shape.
      const contents = messages.map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));
      const result = await model.generateContent({ contents });
      return (result.response.text() || '').trim();
    },
  };
}
