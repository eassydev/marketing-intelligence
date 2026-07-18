import type { FastifyInstance } from 'fastify';
import { env } from '../../config/env.js';
import { makeServiceTokenGuard } from '../../shared/middleware/service-token.js';
import {
  conversionIngestSchema,
  touchIngestSchema,
  eventsIngestSchema,
  leadEventIngestSchema,
} from './validators.js';
import { writeConversion } from './conversion-writer.js';
import { writeTouch } from './touch-writer.js';
import { writeEvents } from './event-writer.js';
import { writeLeadEvent } from './lead-event-writer.js';

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

  // Touches arrive both from BackendNew (VPC) and — via the Cloudflare Worker
  // beacon + tunnel — from the public web/app. All tunnel traffic shares one
  // egress IP, so the global 100/min IP-keyed limit would throttle the whole
  // beacon fleet; the edge Worker already rate-limits per client IP.
  app.post(
    '/ingest/touch',
    { config: { rateLimit: { max: 1200, timeWindow: '1 minute' } } },
    async (req) => {
      const payload = touchIngestSchema.parse(req.body);
      await writeTouch(payload);
      return { ok: true };
    },
  );

  // Qualified CTWA WhatsApp lead → Meta CAPI 'Lead' upload queue (§D CAPI).
  app.post('/ingest/lead-event', async (req) => {
    const payload = leadEventIngestSchema.parse(req.body);
    const result = await writeLeadEvent(payload);
    return { ok: true, ...result };
  });

  // Batch product-event ingest. Batches are larger and higher-frequency than
  // single touches/conversions, so this route overrides the app-wide 1MB body
  // limit (→2MB, ~200 events) and the global 100/min rate limit (→1200/min).
  app.post(
    '/ingest/events',
    {
      bodyLimit: 2_097_152, // 2MB
      config: { rateLimit: { max: 1200, timeWindow: '1 minute' } },
    },
    async (req) => {
      const payload = eventsIngestSchema.parse(req.body);
      const { received, inserted } = await writeEvents(payload);
      return { ok: true, received, inserted };
    },
  );
}
