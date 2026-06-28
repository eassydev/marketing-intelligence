import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, eq, desc, sql } from 'drizzle-orm';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { makeServiceTokenGuard } from '../../shared/middleware/service-token.js';
import { db } from '../../shared/db/index.js';
import { decision } from '../../shared/schema/index.js';

const listQuery = z.object({
  app: z.enum(['services', 'society']).default('services'),
  status: z.enum(['proposed', 'approved', 'executed', 'rejected']).optional(),
});

/**
 * Decision review surface. Listing + human approval are the only transitions
 * now; execution is parked with LiveAdActionPort. Approval is the gate that a
 * future live port checks.
 */
export async function decisionsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', makeServiceTokenGuard('serving', env.MIL_SERVING_TOKEN));

  app.get('/marketing/decisions', async (req: FastifyRequest) => {
    const q = listQuery.parse(req.query);
    const conds = [eq(decision.app, q.app)];
    if (q.status) conds.push(eq(decision.status, q.status));
    const rows = await db
      .select()
      .from(decision)
      .where(and(...conds))
      .orderBy(desc(decision.proposedAt))
      .limit(200);
    return { app: q.app, count: rows.length, data: rows };
  });

  app.post('/marketing/decisions/:id/approve', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) return reply.status(400).send({ error: 'invalid id' });
    const approvedBy = (req.body as { approved_by?: string } | undefined)?.approved_by ?? 'operator';
    const [row] = await db
      .update(decision)
      .set({ status: 'approved', approvedBy, approvedAt: sql`now()` })
      .where(and(eq(decision.id, id), eq(decision.status, 'proposed')))
      .returning();
    if (!row) return reply.status(404).send({ error: 'not found or not in proposed state' });
    return { ok: true, decision: row };
  });
}
