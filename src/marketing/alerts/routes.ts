import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, eq, desc } from 'drizzle-orm';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { makeServiceTokenGuard } from '../../shared/middleware/service-token.js';
import { db } from '../../shared/db/index.js';
import { alert } from '../../shared/schema/index.js';
import { appSchema } from '../../shared/types/app.js';

const listQuery = z.object({
  app: appSchema,
  severity: z.enum(['info', 'warn', 'critical']).optional(),
});

export async function alertsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', makeServiceTokenGuard('serving', env.MIL_SERVING_TOKEN));

  app.get('/marketing/alerts', async (req: FastifyRequest) => {
    const q = listQuery.parse(req.query);
    const conds = [eq(alert.app, q.app)];
    if (q.severity) conds.push(eq(alert.severity, q.severity));
    const rows = await db
      .select()
      .from(alert)
      .where(and(...conds))
      .orderBy(desc(alert.firedAt))
      .limit(200);
    return { app: q.app, count: rows.length, data: rows };
  });
}
