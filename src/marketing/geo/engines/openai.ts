import type { GeoAnswer, GeoEngine } from './types.js';
import { extractDomains, postJsonWithRetry } from './http.js';

export interface OpenAiEngineConfig {
  apiKey: string;
  model: string; // e.g. gpt-4o-mini
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
}

/** ChatGPT via the OpenAI chat-completions REST API (plain fetch, no SDK). */
export class OpenAiEngine implements GeoEngine {
  readonly engine = 'chatgpt';

  constructor(private readonly config: OpenAiEngineConfig) {}

  async ask(question: string): Promise<GeoAnswer> {
    const data = await postJsonWithRetry<ChatCompletionResponse>(
      this.engine,
      'https://api.openai.com/v1/chat/completions',
      { authorization: `Bearer ${this.config.apiKey}` },
      {
        model: this.config.model,
        max_tokens: 1024,
        messages: [{ role: 'user', content: question }],
      },
    );
    const text = data.choices?.[0]?.message?.content?.trim() ?? '';
    return { text, citedDomains: extractDomains(text) };
  }
}
