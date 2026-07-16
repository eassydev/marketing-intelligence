import { describe, it, expect } from 'vitest';
import {
  registryCreateSchema,
  registryUpdateSchema,
  recentQuery,
} from '../src/marketing/events/validators.js';

describe('registryCreateSchema', () => {
  it('accepts a named app-event registration and applies defaults', () => {
    const r = registryCreateSchema.parse({ source: 'app', event_name: 'el_home_view' });
    expect(r.app).toBe('services'); // MIL_DEFAULT_APP from tests/setup.ts
    expect(r.source).toBe('app');
    expect(r.event_name).toBe('el_home_view');
    expect(r.expected_frequency).toBe('none');
    expect(r.is_active).toBe(true);
  });

  it("defaults event_name to '' — the whole-stream row", () => {
    const r = registryCreateSchema.parse({ source: 'click', expected_frequency: 'daily' });
    expect(r.event_name).toBe('');
    expect(r.expected_frequency).toBe('daily');
  });

  it('accepts every registrable source, incl. the BackendNew-served ones', () => {
    for (const source of ['app', 'click', 'lead', 'conversion', 'touch', 'notification', 'web']) {
      expect(registryCreateSchema.parse({ source }).source).toBe(source);
    }
  });

  it('rejects an unknown source and an unknown frequency', () => {
    expect(() => registryCreateSchema.parse({ source: 'pixel' })).toThrow();
    expect(() =>
      registryCreateSchema.parse({ source: 'app', expected_frequency: 'monthly' }),
    ).toThrow();
  });

  it('rejects a non-taxonomy event_name', () => {
    for (const bad of ['El_Home', 'el-home', 'el home', 'x'.repeat(65)]) {
      expect(() => registryCreateSchema.parse({ source: 'app', event_name: bad })).toThrow();
    }
  });
});

describe('registryUpdateSchema', () => {
  it('is fully partial — an empty body parses', () => {
    expect(registryUpdateSchema.parse({})).toEqual({});
  });

  it('accepts each editable field alone', () => {
    expect(registryUpdateSchema.parse({ is_active: false }).is_active).toBe(false);
    expect(registryUpdateSchema.parse({ description: null }).description).toBeNull();
    expect(registryUpdateSchema.parse({ expected_frequency: 'weekly' }).expected_frequency).toBe('weekly');
    expect(registryUpdateSchema.parse({ event_name: '' }).event_name).toBe('');
  });

  it('rejects invalid values', () => {
    expect(() => registryUpdateSchema.parse({ expected_frequency: 'always' })).toThrow();
    expect(() => registryUpdateSchema.parse({ event_name: 'Bad-Name' })).toThrow();
  });
});

describe('recentQuery', () => {
  it('requires a MIL-served source and defaults limit to 50', () => {
    const q = recentQuery.parse({ source: 'conversion' });
    expect(q.app).toBe('services');
    expect(q.limit).toBe(50);
    expect(q.event_name).toBeUndefined();
  });

  it('coerces and bounds limit to 1..200', () => {
    expect(recentQuery.parse({ source: 'app', limit: '200' }).limit).toBe(200);
    expect(() => recentQuery.parse({ source: 'app', limit: '0' })).toThrow();
    expect(() => recentQuery.parse({ source: 'app', limit: '201' })).toThrow();
  });

  it("rejects sources MIL does not serve (notification/web) and empty event_name", () => {
    expect(() => recentQuery.parse({ source: 'notification' })).toThrow();
    expect(() => recentQuery.parse({ source: 'web' })).toThrow();
    expect(() => recentQuery.parse({ source: 'app', event_name: '' })).toThrow();
  });
});
