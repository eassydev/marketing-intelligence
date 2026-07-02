import { describe, it, expect } from 'vitest';
import { parseEnv } from '../src/config/env.js';
import { buildEngines } from '../src/marketing/geo/factory.js';

const base = {
  DATABASE_URL: 'postgresql://mil:mil@localhost:5432/mil',
  REDIS_URL: 'redis://localhost:6379',
  INTERNAL_INGEST_TOKEN: 'x'.repeat(16),
  MIL_SERVING_TOKEN: 'y'.repeat(16),
} as NodeJS.ProcessEnv;

describe('buildEngines', () => {
  it('returns no engines when no API key is present', () => {
    expect(buildEngines(parseEnv(base))).toEqual([]);
  });

  it('returns only the engines whose key is present', () => {
    const engines = buildEngines(parseEnv({ ...base, PERPLEXITY_API_KEY: 'pk', GEMINI_API_KEY: 'gk' }));
    expect(engines.map((e) => e.engine).sort()).toEqual(['gemini', 'perplexity']);
  });

  it('builds all four when every key is present', () => {
    const engines = buildEngines(
      parseEnv({
        ...base,
        ANTHROPIC_API_KEY: 'a',
        OPENAI_API_KEY: 'o',
        GEMINI_API_KEY: 'g',
        PERPLEXITY_API_KEY: 'p',
      }),
    );
    expect(engines.map((e) => e.engine)).toEqual(['claude', 'chatgpt', 'gemini', 'perplexity']);
  });
});
