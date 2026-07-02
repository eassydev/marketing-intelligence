import { env, type Env } from '../../config/env.js';
import type { GeoEngine } from './engines/types.js';
import { AnthropicEngine } from './engines/anthropic.js';
import { OpenAiEngine } from './engines/openai.js';
import { GeminiEngine } from './engines/gemini.js';
import { PerplexityEngine } from './engines/perplexity.js';

type EngineEnv = Pick<
  Env,
  | 'ANTHROPIC_API_KEY'
  | 'ANTHROPIC_MODEL'
  | 'OPENAI_API_KEY'
  | 'OPENAI_MODEL'
  | 'GEMINI_API_KEY'
  | 'GEMINI_MODEL'
  | 'PERPLEXITY_API_KEY'
  | 'PERPLEXITY_MODEL'
>;

/**
 * Build the engines whose API key is present (mirrors buildConnectors): a
 * missing key means the engine is simply absent and the geo job logs-and-skips,
 * so the service runs fine before any engine account is wired.
 */
export function buildEngines(source: EngineEnv = env): GeoEngine[] {
  const engines: GeoEngine[] = [];

  if (source.ANTHROPIC_API_KEY) {
    engines.push(
      new AnthropicEngine({ apiKey: source.ANTHROPIC_API_KEY, model: source.ANTHROPIC_MODEL }),
    );
  }
  if (source.OPENAI_API_KEY) {
    engines.push(new OpenAiEngine({ apiKey: source.OPENAI_API_KEY, model: source.OPENAI_MODEL }));
  }
  if (source.GEMINI_API_KEY) {
    engines.push(new GeminiEngine({ apiKey: source.GEMINI_API_KEY, model: source.GEMINI_MODEL }));
  }
  if (source.PERPLEXITY_API_KEY) {
    engines.push(
      new PerplexityEngine({ apiKey: source.PERPLEXITY_API_KEY, model: source.PERPLEXITY_MODEL }),
    );
  }

  return engines;
}
