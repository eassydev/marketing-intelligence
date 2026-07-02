import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

// Mock the writers so the valid-body path doesn't touch a live DB — this test
// is about the error-handling contract, not persistence.
vi.mock('../src/marketing/ingest/conversion-writer.js', () => ({
  writeConversion: vi.fn().mockResolvedValue({ inserted: true }),
}));
vi.mock('../src/marketing/ingest/touch-writer.js', () => ({
  writeTouch: vi.fn().mockResolvedValue(undefined),
  inferChannel: vi.fn().mockReturnValue(null),
}));

import { buildApp } from '../src/app.js';

const TOKEN = process.env.INTERNAL_INGEST_TOKEN as string; // set in tests/setup.ts
const auth = { authorization: `Bearer ${TOKEN}` };

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
});

afterAll(async () => {
  await app.close();
});

describe('POST /ingest/conversion error handling', () => {
  it('returns 400 (not 500) on an invalid body, with the validation issues', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/ingest/conversion',
      headers: auth,
      payload: {}, // missing order_id, value_inr, is_first_order, occurred_at
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe('Validation Error');
    expect(Array.isArray(body.issues)).toBe(true);
    expect(body.issues.length).toBeGreaterThan(0);
  });

  it('accepts a valid body (writer mocked)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/ingest/conversion',
      headers: auth,
      payload: {
        order_id: 'ORD-TEST-1',
        value_inr: 499,
        is_first_order: true,
        occurred_at: new Date('2026-06-29T00:00:00.000Z').toISOString(),
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });

  it('leaves the auth guard unchanged: 401 without a token', async () => {
    const res = await app.inject({ method: 'POST', url: '/ingest/conversion', payload: {} });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /ingest/touch error handling', () => {
  it('returns 400 (not 500) on an invalid body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/ingest/touch',
      headers: auth,
      payload: {}, // missing session_id
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('Validation Error');
  });
});
