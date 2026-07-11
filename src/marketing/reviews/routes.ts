import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { makeServiceTokenGuard } from '../../shared/middleware/service-token.js';
import { envelope } from '../serving/envelope.js';
import { appSchema } from '../../shared/types/app.js';
import { reviewsTrend, type ReviewsFilters } from './queries.js';

const querySchema = z.object({
  app: appSchema,
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  source: z.enum(['google_business', 'play_store', 'app_store']).optional(),
});

/** Default window: last 90 days (daily snapshots → a quarter's trend line). */
function parseFilters(req: FastifyRequest): ReviewsFilters {
  const q = querySchema.parse(req.query);
  const today = new Date();
  const ago = new Date(today);
  ago.setUTCDate(ago.getUTCDate() - 89);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return { app: q.app, from: q.from ?? fmt(ago), to: q.to ?? fmt(today), source: q.source };
}

/** Review-trend read API (Phase 6). Guarded by MIL_SERVING_TOKEN.
 * data = [{ source, snapshot_date, rating_avg, rating_count, new_reviews_count }]. */
export async function reviewsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', makeServiceTokenGuard('serving', env.MIL_SERVING_TOKEN));

  app.get('/marketing/metrics/reviews', async (req) => {
    const f = parseFilters(req);
    return envelope(f.app, { from: f.from, to: f.to }, {}, await reviewsTrend(f));
  });
}
