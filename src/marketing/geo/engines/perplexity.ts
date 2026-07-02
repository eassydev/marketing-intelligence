import type { GeoAnswer, GeoEngine } from './types.js';
import { extractDomains, postJsonWithRetry, toDomain } from './http.js';

export interface PerplexityEngineConfig {
  apiKey: string;
  model: string; // e.g. sonar
}

interface PerplexityResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
  /** Perplexity returns the URLs it grounded the answer on. */
  citations?: string[];
}

/**
 * Perplexity via its chat-completions API (plain fetch). Unlike the other
 * engines its `citations` array is native — union it with any URLs inlined in
 * the answer text so nothing is dropped.
 */
export class PerplexityEngine implements GeoEngine {
  readonly engine = 'perplexity';

  constructor(private readonly config: PerplexityEngineConfig) {}

  async ask(question: string): Promise<GeoAnswer> {
    const data = await postJsonWithRetry<PerplexityResponse>(
      this.engine,
      'https://api.perplexity.ai/chat/completions',
      { authorization: `Bearer ${this.config.apiKey}` },
      {
        model: this.config.model,
        max_tokens: 1024,
        messages: [{ role: 'user', content: question }],
      },
    );
    const text = data.choices?.[0]?.message?.content?.trim() ?? '';
    const fromCitations = (data.citations ?? [])
      .map(toDomain)
      .filter((domain): domain is string => domain !== null);
    const citedDomains = [...new Set([...fromCitations, ...extractDomains(text)])];
    return { text, citedDomains };
  }
}
