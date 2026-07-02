import type { GeoAnswer, GeoEngine } from './types.js';
import { extractDomains, postJsonWithRetry } from './http.js';

export interface GeminiEngineConfig {
  apiKey: string;
  model: string; // e.g. gemini-2.0-flash
}

interface GenerateContentResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
}

/** Gemini via the generateContent REST API (plain fetch; key in header, not URL). */
export class GeminiEngine implements GeoEngine {
  readonly engine = 'gemini';

  constructor(private readonly config: GeminiEngineConfig) {}

  async ask(question: string): Promise<GeoAnswer> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.config.model}:generateContent`;
    const data = await postJsonWithRetry<GenerateContentResponse>(
      this.engine,
      url,
      { 'x-goog-api-key': this.config.apiKey },
      { contents: [{ role: 'user', parts: [{ text: question }] }] },
    );
    const text = (data.candidates?.[0]?.content?.parts ?? [])
      .map((part) => part.text ?? '')
      .join('')
      .trim();
    return { text, citedDomains: extractDomains(text) };
  }
}
