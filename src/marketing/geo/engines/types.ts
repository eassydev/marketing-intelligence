/** What an engine returned for one buyer question. */
export interface GeoAnswer {
  text: string;
  /** Bare hostnames (lowercased, no `www.`) the engine cited or linked. */
  citedDomains: string[];
}

/**
 * One AI answer engine (Claude, ChatGPT, Gemini, Perplexity). `engine` is the
 * value stored in marketing.geo_observation.engine — keep it stable, it is the
 * trend dimension.
 */
export interface GeoEngine {
  readonly engine: string;
  ask(question: string): Promise<GeoAnswer>;
}
