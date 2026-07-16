import { sql } from 'drizzle-orm';
import { db } from '../../shared/db/index.js';
import type { AppKind } from '../../shared/types/app.js';
import type { RegistryCreate, RegistryUpdate } from './validators.js';

/**
 * Read/write helpers for the event definitions registry. Route handlers stay
 * thin; all SQL lives here. Unique-violation errors (Postgres 23505) propagate
 * to the caller, which maps them to 409.
 */

export interface RegistryRow {
  id: number;
  app: string;
  source: string;
  event_name: string; // '' = whole-stream row
  description: string | null;
  expected_frequency: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

const SELECT_COLS = sql`
  id, app, source, event_name, description, expected_frequency, is_active, created_at, updated_at`;

/** Postgres returns bigint (id) as a string; coerce it to a JSON number so the
 * serving contract is stable for consumers (same pattern as segments). */
function normalizeRow(row: Record<string, unknown>): RegistryRow {
  return { ...row, id: Number(row.id) } as unknown as RegistryRow;
}

export async function listRegistry(app: AppKind): Promise<RegistryRow[]> {
  const res = await db.execute(sql`
    select ${SELECT_COLS} from marketing.event_registry
    where app = ${app}
    order by source asc, event_name asc`);
  return (res.rows as Array<Record<string, unknown>>).map(normalizeRow);
}

export async function insertRegistryRow(b: RegistryCreate): Promise<RegistryRow> {
  const res = await db.execute(sql`
    insert into marketing.event_registry
      (app, source, event_name, description, expected_frequency, is_active)
    values (${b.app}, ${b.source}, ${b.event_name}, ${b.description ?? null},
            ${b.expected_frequency}, ${b.is_active})
    returning ${SELECT_COLS}`);
  return normalizeRow(res.rows[0] as Record<string, unknown>);
}

export async function updateRegistryRow(
  id: number,
  b: RegistryUpdate,
): Promise<RegistryRow | undefined> {
  const sets = [sql`updated_at = now()`];
  if (b.event_name !== undefined) sets.push(sql`event_name = ${b.event_name}`);
  if (b.description !== undefined) sets.push(sql`description = ${b.description}`);
  if (b.expected_frequency !== undefined) sets.push(sql`expected_frequency = ${b.expected_frequency}`);
  if (b.is_active !== undefined) sets.push(sql`is_active = ${b.is_active}`);
  const res = await db.execute(sql`
    update marketing.event_registry set ${sql.join(sets, sql`, `)}
    where id = ${id}
    returning ${SELECT_COLS}`);
  const row = res.rows[0] as Record<string, unknown> | undefined;
  return row ? normalizeRow(row) : undefined;
}

export async function deleteRegistryRow(id: number): Promise<boolean> {
  const res = await db.execute(
    sql`delete from marketing.event_registry where id = ${id} returning id`,
  );
  return res.rows.length > 0;
}
