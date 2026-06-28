import { describe, it, expect, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';

// buildApp wires plugins + /health only; it does not open DB/Redis connections,
// so this runs without any external service.
let app: FastifyInstance | undefined;

describe('GET /health', () => {
  afterAll(async () => {
    if (app) await app.close();
  });

  it('returns ok with the service name', async () => {
    app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.service).toBe('mil');
    expect(typeof body.uptime).toBe('number');
  });
});
