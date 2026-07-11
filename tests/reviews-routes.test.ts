import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';

const TOKEN = process.env.MIL_SERVING_TOKEN as string; // set in tests/setup.ts

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
});

afterAll(async () => {
  await app.close();
});

describe('GET /marketing/metrics/reviews auth + validation', () => {
  it('returns 401 without a bearer token', async () => {
    const res = await app.inject({ method: 'GET', url: '/marketing/metrics/reviews' });
    expect(res.statusCode).toBe(401);
  });

  it('returns 403 on a wrong token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/marketing/metrics/reviews',
      headers: { authorization: 'Bearer wrong-token-0123456789' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects a malformed date with 400 before touching the DB', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/marketing/metrics/reviews?from=last-week',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('Validation Error');
  });

  it('rejects an unknown source with 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/marketing/metrics/reviews?source=trustpilot',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /marketing/metrics/campaign-funnel auth + validation', () => {
  it('returns 401 without a bearer token', async () => {
    const res = await app.inject({ method: 'GET', url: '/marketing/metrics/campaign-funnel' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects an unknown channel with 400 before touching the DB', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/marketing/metrics/campaign-funnel?channel=tiktok',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('Validation Error');
  });
});
