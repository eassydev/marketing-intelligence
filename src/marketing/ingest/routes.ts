import type { FastifyInstance } from 'fastify';
import { env } from '../../config/env.js';
import { makeServiceTokenGuard } from '../../shared/middleware/service-token.js';
import { conversionIngestSchema, touchIngestSchema } from './validators.js';
import { writeConversion } from './conversion-writer.js';
import { writeTouch } from './touch-writer.js';

/**
 * Internal ingest endpoints (BackendNew → MIL). Token-gated for now; when the
 * public web touch beacon ships (Phase 3 + public exposure), /ingest/touch
 * moves to a public, rate-limited, CORS-restricted route.
 */
export async function ingestRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', makeServiceTokenGuard('ingest', env.INTERNAL_INGEST_TOKEN));

  app.post('/ingest/conversion', async (req) => {
    const payload = conversionIngestSchema.parse(req.body);
    const result = await writeConversion(payload);
    return { ok: true, ...result };
  });

  app.post('/ingest/touch', async (req) => {
    const payload = touchIngestSchema.parse(req.body);
    await writeTouch(payload);
    return { ok: true };
  });
}
