import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { makeServiceTokenGuard } from '../../shared/middleware/service-token.js';
import { loadMarketingState } from '../context/load-state.js';
import { generateInsights } from './generate.js';
import { appSchema } from '../../shared/types/app.js';

const query = z.object({
  app: appSchema,
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export async function insightsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', makeServiceTokenGuard('serving', env.MIL_SERVING_TOKEN));

  app.get('/marketing/insights', async (req: FastifyRequest) => {
    const q = query.parse(req.query);
    const today = new Date();
    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    const from = q.from ?? fmt(new Date(today.getTime() - 29 * 86_400_000));
    const to = q.to ?? fmt(today);
    const state = await loadMarketingState(q.app, from, to);
    return generateInsights(state);
  });
}
