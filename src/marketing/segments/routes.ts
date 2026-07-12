import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { makeServiceTokenGuard } from '../../shared/middleware/service-token.js';
import { db } from '../../shared/db/index.js';
import { appSchema } from '../../shared/types/app.js';
import { definitionSchema, type Definition } from './dsl.js';
import { compileCount } from './compile.js';
import { appEventAvailable } from './events-available.js';
import { segmentsRefreshQueue } from '../../shared/queue/index.js';
import {
  listSegments,
  getSegment,
  uniqueSlug,
  segmentMembers,
  dryRun,
  DryRunTimeout,
  type SegmentRow,
} from './queries.js';

const SLUG_RE = /^[a-z][a-z0-9_]{1,63}$/;

const listQuery = z.object({
  app: appSchema,
  status: z.enum(['active', 'paused', 'archived']).optional(),
});

const createBody = z.object({
  app: appSchema,
  name: z.string().min(1).max(120),
  slug: z.string().regex(SLUG_RE).optional(),
  description: z.string().max(500).optional(),
  definition: definitionSchema,
  refresh_interval_minutes: z.number().int().min(5).max(10_080).optional(),
  created_by: z.string().max(120).optional(),
});

const updateBody = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(500).nullable().optional(),
  definition: definitionSchema.optional(),
  refresh_interval_minutes: z.number().int().min(5).max(10_080).optional(),
  status: z.enum(['active', 'paused']).optional(),
});

const idParam = z.object({ id: z.coerce.number().int().positive() });

const membersQuery = z.object({
  cursor: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().positive().max(env.MIL_SEGMENT_MEMBERS_PAGE_MAX).default(1000),
});

const dryRunBody = z.object({ app: appSchema, definition: definitionSchema });

/** Enqueue a refresh for a segment; jobId dedups a still-queued refresh. */
async function enqueueRefresh(id: number): Promise<void> {
  await segmentsRefreshQueue.add(
    'refresh-segment',
    { segmentId: id },
    {
      jobId: `refresh-${id}`,
      attempts: 2,
      backoff: { type: 'exponential', delay: 120_000 },
      // Must not retain finished jobs: BullMQ ignores add() while a job with the
      // same id exists in ANY state, so a retained completed/failed job would
      // starve future refreshes. Failures live in segment.last_error instead.
      removeOnComplete: true,
      removeOnFail: true,
    },
  );
}

/**
 * Compile smoke-test: reject a definition that cannot compile (e.g. references
 * app_event on an instance without it) BEFORE persisting. compileCount throws a
 * clean Error which the caller turns into a 422.
 */
async function assertCompiles(app: string, def: Definition): Promise<void> {
  const eventsAvailable = await appEventAvailable();
  // Executed with LIMIT 0 so it validates SQL shape without a full scan.
  const countSql = compileCount(app, def, eventsAvailable);
  await db.execute(sql`select * from (${countSql}) c limit 0`);
}

/** Segment management + serving API. Guarded by MIL_SERVING_TOKEN. */
export async function segmentsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', makeServiceTokenGuard('serving', env.MIL_SERVING_TOKEN));

  // ── List ──────────────────────────────────────────────────────────────────
  app.get('/marketing/segments', async (req: FastifyRequest) => {
    const q = listQuery.parse(req.query);
    const rows = await listSegments(q.app, q.status);
    return { app: q.app, count: rows.length, data: rows };
  });

  // ── Create ────────────────────────────────────────────────────────────────
  app.post('/marketing/segments', async (req: FastifyRequest, reply: FastifyReply) => {
    const b = createBody.parse(req.body);
    try {
      await assertCompiles(b.app, b.definition);
    } catch (err) {
      return reply.status(422).send({ error: 'Invalid definition', message: (err as Error).message });
    }
    const slug = b.slug ?? (await uniqueSlug(b.app, b.name));

    let inserted: SegmentRow;
    try {
      const res = await db.execute(sql`
        insert into marketing.segment
          (app, slug, name, description, definition, refresh_interval_minutes, status, is_system, created_by)
        values (
          ${b.app}, ${slug}, ${b.name}, ${b.description ?? null},
          ${JSON.stringify(b.definition)}::jsonb, ${b.refresh_interval_minutes ?? 360},
          'active', false, ${b.created_by ?? null}
        )
        returning id`);
      const id = Number((res.rows[0] as { id: number }).id);
      inserted = (await getSegment(id))!;
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        return reply.status(409).send({ error: 'Conflict', message: `slug '${slug}' already exists for app '${b.app}'` });
      }
      throw err;
    }

    await enqueueRefresh(inserted.id);
    return reply.status(201).send({ data: inserted });
  });

  // ── Get one ───────────────────────────────────────────────────────────────
  app.get('/marketing/segments/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = idParam.parse(req.params);
    const row = await getSegment(id);
    if (!row) return reply.status(404).send({ error: 'Not found' });
    return { data: row };
  });

  // ── Update ────────────────────────────────────────────────────────────────
  app.put('/marketing/segments/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = idParam.parse(req.params);
    const b = updateBody.parse(req.body);
    const existing = await getSegment(id);
    if (!existing) return reply.status(404).send({ error: 'Not found' });

    // System segments: only status + interval are editable (definition/name are
    // owned by the seed script). Silently ignore locked fields on a system row.
    const editingLocked = b.name !== undefined || b.description !== undefined || b.definition !== undefined;
    if (existing.is_system && editingLocked) {
      return reply.status(422).send({
        error: 'Immutable',
        message: 'system segments allow only status and refresh_interval_minutes edits',
      });
    }

    let definitionChanged = false;
    if (b.definition) {
      try {
        await assertCompiles(existing.app, b.definition);
      } catch (err) {
        return reply.status(422).send({ error: 'Invalid definition', message: (err as Error).message });
      }
      definitionChanged = true;
    }

    const sets = [sql`updated_at = now()`];
    if (b.name !== undefined) sets.push(sql`name = ${b.name}`);
    if (b.description !== undefined) sets.push(sql`description = ${b.description}`);
    if (b.refresh_interval_minutes !== undefined) sets.push(sql`refresh_interval_minutes = ${b.refresh_interval_minutes}`);
    if (b.status !== undefined) sets.push(sql`status = ${b.status}`);
    if (b.definition) {
      sets.push(sql`definition = ${JSON.stringify(b.definition)}::jsonb`);
      // Force a re-refresh: null the timestamp so the dispatcher treats it as due.
      sets.push(sql`last_refreshed_at = null`);
    }

    await db.execute(sql`update marketing.segment set ${sql.join(sets, sql`, `)} where id = ${id}`);
    if (definitionChanged) await enqueueRefresh(id);

    return { data: (await getSegment(id))! };
  });

  // ── Delete (soft archive) ───────────────────────────────────────────────────
  app.delete('/marketing/segments/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = idParam.parse(req.params);
    const existing = await getSegment(id);
    if (!existing) return reply.status(404).send({ error: 'Not found' });
    await db.transaction(async (tx) => {
      await tx.execute(sql`delete from marketing.segment_membership where segment_id = ${id}`);
      await tx.execute(sql`update marketing.segment set status = 'archived', updated_at = now() where id = ${id}`);
    });
    return { data: { id, status: 'archived' } };
  });

  // ── Members (keyset pagination; user_ids only, no PII) ──────────────────────
  app.get('/marketing/segments/:id/members', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = idParam.parse(req.params);
    const q = membersQuery.parse(req.query);
    const existing = await getSegment(id);
    if (!existing) return reply.status(404).send({ error: 'Not found' });
    const page = await segmentMembers(id, q.cursor, q.limit);
    return { data: page };
  });

  // ── Manual refresh ──────────────────────────────────────────────────────────
  app.post('/marketing/segments/:id/refresh', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = idParam.parse(req.params);
    const existing = await getSegment(id);
    if (!existing) return reply.status(404).send({ error: 'Not found' });
    await enqueueRefresh(id);
    return reply.status(202).send({ data: { segment_id: id, enqueued: true } });
  });

  // ── Dry-run (evaluate without persisting) ───────────────────────────────────
  app.post('/marketing/segments/dry-run', async (req: FastifyRequest, reply: FastifyReply) => {
    const b = dryRunBody.parse(req.body);
    try {
      const result = await dryRun(b.app, b.definition);
      return { data: result };
    } catch (err) {
      if (err instanceof DryRunTimeout) {
        return reply.status(422).send({ error: 'Timeout', message: err.message });
      }
      // A compile error (e.g. app_event absent) is a bad request, not a 500.
      return reply.status(422).send({ error: 'Invalid definition', message: (err as Error).message });
    }
  });
}
