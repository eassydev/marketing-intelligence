import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { makeServiceTokenGuard } from '../../shared/middleware/service-token.js';
import { envelope } from './envelope.js';
import {
  spendSummary,
  spendBreakdown,
  cacSummary,
  costPerFirstOrder,
  repeatRate,
  cohortRevenue,
  ltvCac,
  type SpendFilters,
  type Dimension,
} from './queries.js';

const querySchema = z.object({
  app: z.enum(['services', 'society']).default('services'),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  city: z.string().optional(),
  category: z.string().optional(),
});

function parseFilters(req: FastifyRequest): SpendFilters {
  const q = querySchema.parse(req.query);
  const today = new Date();
  const ago = new Date(today);
  ago.setUTCDate(ago.getUTCDate() - 29);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return {
    app: q.app,
    from: q.from ?? fmt(ago),
    to: q.to ?? fmt(today),
    city: q.city,
    category: q.category,
  };
}

/** Read-only serving API for Looker / dashboards. Guarded by MIL_SERVING_TOKEN. */
export async function servingRoutes(app: FastifyInstance): Promise<void> {
  const guard = makeServiceTokenGuard('serving', env.MIL_SERVING_TOKEN);
  app.addHook('preHandler', guard);

  app.get('/marketing/metrics/spend', async (req) => {
    const f = parseFilters(req);
    return envelope(f.app, { from: f.from, to: f.to }, f, await spendSummary(f));
  });

  const breakdown = (dimension: Dimension) => async (req: FastifyRequest) => {
    const f = parseFilters(req);
    return envelope(f.app, { from: f.from, to: f.to }, f, await spendBreakdown(f, dimension));
  };

  app.get('/marketing/metrics/spend-by-city', breakdown('city'));
  app.get('/marketing/metrics/spend-by-category', breakdown('category'));
  app.get('/marketing/metrics/spend-by-campaign', breakdown('campaign'));

  app.get('/marketing/metrics/cac', async (req) => {
    const f = parseFilters(req);
    return envelope(f.app, { from: f.from, to: f.to }, f, await cacSummary(f));
  });

  app.get('/marketing/metrics/cost-per-first-order', async (req) => {
    const f = parseFilters(req);
    return envelope(f.app, { from: f.from, to: f.to }, f, await costPerFirstOrder(f));
  });

  app.get('/marketing/metrics/ltv', async (req) => {
    const f = parseFilters(req);
    const [repeat, byChannel, cohorts] = await Promise.all([
      repeatRate(f),
      ltvCac(f),
      cohortRevenue(f),
    ]);
    return envelope(f.app, { from: f.from, to: f.to }, f, {
      repeat,
      by_channel: byChannel,
      cohorts,
    });
  });
}
