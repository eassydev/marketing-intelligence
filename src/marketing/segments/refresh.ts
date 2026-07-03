import { sql } from 'drizzle-orm';
import { db } from '../../shared/db/index.js';
import { env } from '../../config/env.js';
import { createChildLogger } from '../../shared/logger/index.js';
import { definitionSchema } from './dsl.js';
import { compileMembership } from './compile.js';
import { appEventAvailable } from './events-available.js';

const log = createChildLogger({ module: 'segments-refresh' });

export interface RefreshResult {
  segmentId: number;
  count: number;
  tookMs: number;
  skipped?: 'not_found' | 'inactive';
}

/**
 * Recompute one segment's membership. Loads the segment, and (unless it is not
 * active) rebuilds marketing.segment_membership in a SINGLE transaction:
 *   SET LOCAL statement_timeout → DELETE all rows → INSERT the compiled members.
 * The DELETE+INSERT is atomic so readers never see a partial rebuild. Refresh
 * bookkeeping (last_count / last_refreshed_at / last_refresh_ms / last_error) is
 * written after commit; on failure last_error is set and the error re-thrown so
 * BullMQ records the attempt and retries.
 */
export async function refreshSegment(id: number): Promise<RefreshResult> {
  const started = Date.now();

  const rows = await db.execute(
    sql`select id, app, status, definition from marketing.segment where id = ${id}`,
  );
  const seg = rows.rows[0] as
    | { id: number; app: string; status: string; definition: unknown }
    | undefined;

  if (!seg) {
    log.warn({ segmentId: id }, 'refresh skipped — segment not found');
    return { segmentId: id, count: 0, tookMs: Date.now() - started, skipped: 'not_found' };
  }
  if (seg.status !== 'active') {
    log.info({ segmentId: id, status: seg.status }, 'refresh skipped — not active');
    return { segmentId: id, count: 0, tookMs: Date.now() - started, skipped: 'inactive' };
  }

  const def = definitionSchema.parse(seg.definition);
  const eventsAvailable = await appEventAvailable();

  try {
    const membership = compileMembership(seg.app, def, eventsAvailable);
    const timeoutMs = env.MIL_SEGMENT_REFRESH_TIMEOUT_MS;

    const count = await db.transaction(async (tx) => {
      // Bound the rebuild so a pathological definition cannot hold a long lock.
      await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${timeoutMs}ms'`));
      await tx.execute(sql`delete from marketing.segment_membership where segment_id = ${id}`);
      const inserted = await tx.execute(sql`
        insert into marketing.segment_membership (segment_id, user_id, computed_at)
        select ${id}, q.user_id, now()
        from (${membership}) q
        where q.user_id is not null`);
      return inserted.rowCount ?? 0;
    });

    const tookMs = Date.now() - started;
    await db.execute(sql`
      update marketing.segment
      set last_count = ${count},
          last_refreshed_at = now(),
          last_refresh_ms = ${tookMs},
          last_error = null,
          updated_at = now()
      where id = ${id}`);

    log.info({ segmentId: id, count, tookMs }, 'segment refreshed');
    return { segmentId: id, count, tookMs };
  } catch (err) {
    const message = (err as Error).message.slice(0, 1000);
    await db
      .execute(sql`
        update marketing.segment
        set last_error = ${message}, updated_at = now()
        where id = ${id}`)
      .catch((e) => log.error({ segmentId: id, err: e }, 'failed to record last_error'));
    log.error({ segmentId: id, err }, 'segment refresh failed');
    throw err;
  }
}

/**
 * Dispatcher: find every active segment whose last successful refresh is older
 * than its refresh_interval_minutes (or never ran) and return their ids. The
 * queue enqueues one refresh-segment job per id.
 */
export async function dueSegmentIds(): Promise<number[]> {
  const res = await db.execute(sql`
    select id from marketing.segment
    where status = 'active'
      and (
        last_refreshed_at is null
        or last_refreshed_at + make_interval(mins => refresh_interval_minutes) < now()
      )
    order by last_refreshed_at asc nulls first`);
  return (res.rows as Array<{ id: number }>).map((r) => Number(r.id));
}
