import { sql } from 'drizzle-orm';
import { db } from '../../shared/db/index.js';
import { env } from '../../config/env.js';
import type { AppKind } from '../../shared/types/app.js';
import { type Definition } from './dsl.js';
import { compileCount, compileMembership } from './compile.js';
import { appEventAvailable } from './events-available.js';

/**
 * Read/query helpers for the segments serving API. Route handlers stay thin;
 * all SQL (and the statement-timeout dance for dry-run) lives here.
 */

export interface SegmentRow {
  id: number;
  app: string;
  slug: string;
  name: string;
  description: string | null;
  definition: Definition;
  refresh_interval_minutes: number;
  status: string;
  is_system: boolean;
  created_by: string | null;
  last_refreshed_at: string | null;
  last_refresh_ms: number | null;
  last_count: number | null;
  last_error: string | null;
  meta_audience_id: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT_COLS = sql`
  id, app, slug, name, description, definition, refresh_interval_minutes,
  status, is_system, created_by, last_refreshed_at, last_refresh_ms,
  last_count, last_error, meta_audience_id, created_at, updated_at`;

/** Postgres returns bigint (id) as a string; coerce it to a JSON number so the
 * serving contract is stable for consumers (BackendNew, dashboards). Integer
 * columns (last_count, refresh_interval_minutes, …) already arrive as numbers. */
function normalizeRow(row: Record<string, unknown>): SegmentRow {
  return { ...row, id: Number(row.id) } as unknown as SegmentRow;
}

export async function listSegments(app: AppKind, status?: string): Promise<SegmentRow[]> {
  const statusFilter = status ? sql` and status = ${status}` : sql``;
  const res = await db.execute(sql`
    select ${SELECT_COLS} from marketing.segment
    where app = ${app}${statusFilter}
    order by is_system desc, name asc`);
  return (res.rows as Array<Record<string, unknown>>).map(normalizeRow);
}

export async function getSegment(id: number): Promise<SegmentRow | undefined> {
  const res = await db.execute(sql`select ${SELECT_COLS} from marketing.segment where id = ${id}`);
  const row = res.rows[0] as Record<string, unknown> | undefined;
  return row ? normalizeRow(row) : undefined;
}

/** Slugify a name to [a-z0-9_] and ensure uniqueness within (app) by suffixing. */
export async function uniqueSlug(app: AppKind, base: string): Promise<string> {
  const root =
    base
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 48) || 'segment';
  let candidate = root;
  for (let i = 2; i < 100; i += 1) {
    const res = await db.execute(
      sql`select 1 from marketing.segment where app = ${app} and slug = ${candidate} limit 1`,
    );
    if (res.rows.length === 0) return candidate;
    candidate = `${root}_${i}`;
  }
  return `${root}_${Date.now()}`;
}

export interface MembersPage {
  segment_id: number;
  computed_at: string | null;
  user_ids: number[];
  next_cursor: number | null;
  total: number;
}

/**
 * Keyset pagination over membership by user_id. `cursor` is the last user_id
 * from the previous page (exclusive). Returns user_ids ONLY — never any PII.
 */
export async function segmentMembers(
  id: number,
  cursor: number | undefined,
  limit: number,
): Promise<MembersPage> {
  const capped = Math.min(Math.max(limit, 1), env.MIL_SEGMENT_MEMBERS_PAGE_MAX);
  const cursorFilter = cursor !== undefined ? sql` and user_id > ${cursor}` : sql``;
  const rows = await db.execute(sql`
    select user_id, computed_at from marketing.segment_membership
    where segment_id = ${id}${cursorFilter}
    order by user_id asc
    limit ${capped}`);
  const totalRes = await db.execute(
    sql`select count(*)::int as total from marketing.segment_membership where segment_id = ${id}`,
  );

  const list = rows.rows as Array<{ user_id: number; computed_at: string }>;
  const userIds = list.map((r) => Number(r.user_id));
  const nextCursor = list.length === capped && userIds.length > 0 ? userIds[userIds.length - 1]! : null;

  return {
    segment_id: id,
    computed_at: list[0]?.computed_at ?? null,
    user_ids: userIds,
    next_cursor: nextCursor,
    total: Number((totalRes.rows[0] as { total: number }).total),
  };
}

export interface DryRunResult {
  count: number;
  sample_user_ids: number[];
  took_ms: number;
}

export class DryRunTimeout extends Error {
  constructor() {
    super('dry-run exceeded statement_timeout');
    this.name = 'DryRunTimeout';
  }
}

/**
 * Evaluate a definition WITHOUT persisting a segment: a bounded COUNT plus a
 * ≤10 user_id sample, under a short statement_timeout so a pathological
 * definition cannot hang the API. Throws DryRunTimeout on a query-canceled
 * error (Postgres SQLSTATE 57014).
 */
export async function dryRun(app: AppKind, def: Definition): Promise<DryRunResult> {
  const eventsAvailable = await appEventAvailable();
  const started = Date.now();
  const timeoutMs = env.MIL_SEGMENT_DRYRUN_TIMEOUT_MS;
  const countSql = compileCount(app, def, eventsAvailable);
  const membershipSql = compileMembership(app, def, eventsAvailable);

  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${timeoutMs}ms'`));
      const countRes = await tx.execute(countSql);
      const count = Number((countRes.rows[0] as { count: number }).count);
      const sampleRes = await tx.execute(sql`select user_id from (${membershipSql}) s limit 10`);
      const sample = (sampleRes.rows as Array<{ user_id: number }>).map((r) => Number(r.user_id));
      return { count, sample_user_ids: sample, took_ms: Date.now() - started };
    });
  } catch (err) {
    if ((err as { code?: string }).code === '57014') throw new DryRunTimeout();
    throw err;
  }
}
