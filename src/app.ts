import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import { env } from './config/env.js';
import { servingRoutes } from './marketing/serving/routes.js';
import { ingestRoutes } from './marketing/ingest/routes.js';
import { decisionsRoutes } from './marketing/actions/routes.js';
import { alertsRoutes } from './marketing/alerts/routes.js';
import { insightsRoutes } from './marketing/insights/routes.js';

/**
 * Build the Fastify app WITHOUT starting workers or listening. Kept separate
 * from `server.ts` so tests can drive it with `app.inject(...)`. Phase 0 wires
 * plugins, /health, and the global error handler; route modules register in
 * later phases.
 */
export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      transport:
        env.NODE_ENV === 'development'
          ? { target: 'pino-pretty', options: { colorize: true } }
          : undefined,
    },
    bodyLimit: 1_048_576, // 1MB
  });

  await app.register(cors, { origin: true });
  await app.register(helmet);
  await app.register(rateLimit, { max: 100, timeWindow: '1 minute' });

  app.get('/health', async () => ({
    status: 'ok',
    service: 'mil',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  }));

  // Readiness: liveness (/health) plus a real DB ping. 503 when the DB is
  // unreachable so we never report a false-green like the earlier SSL outage.
  app.get('/ready', async (_req, reply) => {
    try {
      const { db } = await import('./shared/db/index.js');
      const { sql } = await import('drizzle-orm');
      await db.execute(sql`select 1`);
      return { status: 'ready', db: 'ok' };
    } catch (err) {
      return reply.status(503).send({ status: 'not_ready', db: 'error', error: (err as Error).message });
    }
  });

  // Register the error handler BEFORE the route plugins so the encapsulated
  // route contexts inherit it. Set after registration, the child contexts keep
  // Fastify's default handler and thrown ZodErrors surface as 500 instead of 400.
  app.setErrorHandler(
    (error: Error & { validation?: unknown; statusCode?: number }, _request, reply) => {
      if (error.validation) {
        return reply.status(400).send({
          error: 'Validation Error',
          message: error.message,
          details: error.validation,
        });
      }
      // Zod parse failures thrown from route handlers (e.g. ingest body
      // validation). `instanceof` is the primary check; the `name` fallback
      // catches a ZodError thrown from a duplicate zod module copy where
      // `instanceof` would miss. Returns 400 with the issues so producers can
      // see exactly what failed instead of an opaque 500.
      if (error instanceof ZodError || error.name === 'ZodError') {
        return reply.status(400).send({
          error: 'Validation Error',
          message: 'Invalid request data',
          issues: (error as ZodError).issues,
        });
      }
      app.log.error(error);
      return reply.status(error.statusCode ?? 500).send({
        error: error.name ?? 'Internal Server Error',
        message:
          env.NODE_ENV === 'production' ? 'An unexpected error occurred' : error.message,
      });
    },
  );

  await app.register(servingRoutes);
  await app.register(ingestRoutes);
  await app.register(decisionsRoutes);
  await app.register(alertsRoutes);
  await app.register(insightsRoutes);

  return app;
}
