import { describe, it, expect } from 'vitest';
import { parseEnv } from '../src/config/env.js';

const base = {
  DATABASE_URL: 'postgresql://mil:mil@localhost:5432/mil',
  REDIS_URL: 'redis://localhost:6379',
  INTERNAL_INGEST_TOKEN: 'x'.repeat(16),
  MIL_SERVING_TOKEN: 'y'.repeat(16),
} as NodeJS.ProcessEnv;

describe('parseEnv', () => {
  it('applies defaults for optional keys', () => {
    const env = parseEnv(base);
    expect(env.PORT).toBe(5100);
    expect(env.MIL_ACTION_MODE).toBe('dry_run');
    expect(env.MIL_DEFAULT_APP).toBe('services');
    expect(env.MIL_CLICK_LOOKBACK_DAYS).toBe(7);
    expect(env.MIL_ENABLED_APPS).toEqual(['services']);
  });

  it('parses MIL_ENABLED_APPS as a comma list', () => {
    const env = parseEnv({ ...base, MIL_ENABLED_APPS: 'services, society' });
    expect(env.MIL_ENABLED_APPS).toEqual(['services', 'society']);
  });

  it('fails fast when a required key is missing', () => {
    const { DATABASE_URL: _omit, ...without } = base;
    expect(() => parseEnv(without)).toThrowError(/DATABASE_URL/);
  });

  it('rejects a too-short ingest token', () => {
    expect(() => parseEnv({ ...base, INTERNAL_INGEST_TOKEN: 'short' })).toThrowError(
      /INTERNAL_INGEST_TOKEN/,
    );
  });

  it('rejects an invalid app in the enabled list', () => {
    expect(() => parseEnv({ ...base, MIL_ENABLED_APPS: 'services,bogus' })).toThrow();
  });

  it('derives app defaults from MIL_APP_LIST when unset', () => {
    const env = parseEnv({ ...base, MIL_APP_LIST: 'demo,beta' });
    expect(env.MIL_APP_LIST).toEqual(['demo', 'beta']);
    expect(env.MIL_DEFAULT_APP).toBe('demo'); // first app
    expect(env.MIL_ENABLED_APPS).toEqual(['demo']); // [first app]
  });

  it('rejects MIL_DEFAULT_APP not in MIL_APP_LIST', () => {
    expect(() =>
      parseEnv({ ...base, MIL_APP_LIST: 'demo', MIL_DEFAULT_APP: 'services' }),
    ).toThrow(/MIL_DEFAULT_APP/);
  });

  it('applies queue-prefix / currency / timezone defaults', () => {
    const env = parseEnv(base);
    expect(env.MIL_QUEUE_PREFIX).toBe('mil');
    expect(env.MIL_CURRENCY).toBe('INR');
    expect(env.MIL_CRON_TIMEZONE).toBe('Asia/Kolkata');
  });
});
