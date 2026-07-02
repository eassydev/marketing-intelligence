import Anthropic from '@anthropic-ai/sdk';
import { createChildLogger } from '../../../shared/logger/index.js';
import type { GeoAnswer, GeoEngine } from './types.js';
import { extractDomains } from './http.js';

const log = createChildLogger({ module: 'geo-engine-claude' });

export interface AnthropicEngineConfig {
  apiKey: string;
  model: string;
}

/**
 * Claude via the already-present Anthropic SDK. The SDK's own timeout/maxRetries
 * implement the module contract (30s timeout, one retry on 429/5xx).
 */
export class AnthropicEngine implements GeoEngine {
  readonly engine = 'claude';
  private readonly client: Anthropic;

  constructor(private readonly config: AnthropicEngineConfig) {
    this.client = new Anthropic({ apiKey: config.apiKey, timeout: 30_000, maxRetries: 1 });
  }

  async ask(question: string): Promise<GeoAnswer> {
    try {
      const res = await this.client.messages.create({
        model: this.config.model,
        max_tokens: 1024,
        messages: [{ role: 'user', content: question }],
      });
      const text = res.content
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('')
        .trim();
      return { text, citedDomains: extractDomains(text) };
    } catch (err) {
      log.error({ err: (err as Error).message }, 'claude ask failed');
      throw err;
    }
  }
}
