import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { makeServiceTokenGuard } from '../../shared/middleware/service-token.js';
import { envelope } from '../serving/envelope.js';
import {
  geoTotals,
  latestRun,
  mentionRateByCategory,
  mentionRateByCity,
  mentionRateByEngine,
  type GeoFilters,
} from './queries.js';
import { appSchema } from '../../shared/types/app.js';

const querySchema = z.object({
  app: appSchema,
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

/** Default window: last 90 days (weekly runs → ~13 data points per trend). */
function parseFilters(req: FastifyRequest): GeoFilters {
  const q = querySchema.parse(req.query);
  const today = new Date();
  const ago = new Date(today);
  ago.setUTCDate(ago.getUTCDate() - 89);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return { app: q.app, from: q.from ?? fmt(ago), to: q.to ?? fmt(today) };
}

/** GEO/AI-presence read API (Module A). Guarded by MIL_SERVING_TOKEN. */
export async function geoRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', makeServiceTokenGuard('serving', env.MIL_SERVING_TOKEN));

  app.get('/marketing/geo/summary', async (req) => {
    const f = parseFilters(req);
    const [totals, byEngine, byCity, byCategory, latest] = await Promise.all([
      geoTotals(f),
      mentionRateByEngine(f),
      mentionRateByCity(f),
      mentionRateByCategory(f),
      latestRun(f.app),
    ]);
    return envelope(f.app, { from: f.from, to: f.to }, {}, {
      totals,
      byEngine,
      byCity,
      byCategory,
      latestRun: latest,
    });
  });
}
