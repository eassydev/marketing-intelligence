import type { FastifyInstance, FastifyRequest } from 'fastify';
import { env } from '../../config/env.js';
import { makeServiceTokenGuard } from '../../shared/middleware/service-token.js';
import { envelope } from '../serving/envelope.js';
import { overviewQuery, recentQuery } from './validators.js';
import { streamsOverview } from './overview-queries.js';
import { recentEvents } from './recent-queries.js';

/** The overview grades streams over rolling 24h/7d counters; the envelope
 * period reports the 7d window (informational — counters are now()-relative). */
function period7d(): { from: string; to: string } {
  const today = new Date();
  const ago = new Date(today);
  ago.setUTCDate(ago.getUTCDate() - 7);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return { from: fmt(ago), to: fmt(today) };
}

/** Events monitor: stream health overview + recent-rows tail. Guarded by
 * MIL_SERVING_TOKEN (same principal as /marketing/metrics). */
export async function eventsMonitorRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', makeServiceTokenGuard('serving', env.MIL_SERVING_TOKEN));

  app.get('/marketing/events/overview', async (req: FastifyRequest) => {
    const q = overviewQuery.parse(req.query);
    return envelope(q.app, period7d(), {}, { streams: await streamsOverview(q.app) });
  });

  app.get('/marketing/events/recent', async (req: FastifyRequest) => {
    const q = recentQuery.parse(req.query);
    // event_name only narrows the 'app' stream; row-streams carry no names.
    const events = await recentEvents(q.app, q.source, q.event_name, q.limit);
    return envelope(q.app, period7d(), {}, { events });
  });
}
