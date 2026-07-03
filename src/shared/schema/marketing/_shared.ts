import { sql } from 'drizzle-orm';
import { pgSchema, bigint, text, timestamp, check, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { env } from '../../../config/env.js';

/**
 * All MIL tables live under the `marketing` Postgres schema. Declaring tables
 * via this object means Drizzle emits fully-qualified `marketing.<table>` names,
 * so queries never depend on search_path (keeps Supabase↔E2E portable).
 */
export const marketing = pgSchema('marketing');

/**
 * Tenant CHECK constraint, driven by MIL_APP_LIST so the Drizzle model tracks
 * the instance's app set automatically.
 *
 * NOTE — mirrors the hand-authored `CHECK (app IN (...))` lists in
 * drizzle/0001_core.sql and drizzle/0002_parked.sql. Those SQL files (NOT
 * drizzle-kit) migrate the LIVE database, so when cloning MIL for a new
 * marketplace you MUST edit the CHECK lists in both files to match MIL_APP_LIST
 * (see NEW_INSTANCE.md). This helper only keeps the TypeScript schema honest.
 */
export function appCheck(name: string, appColumn: AnyPgColumn) {
  const list = sql.join(
    env.MIL_APP_LIST.map((a) => sql`${a}`),
    sql`, `,
  );
  return check(name, sql`${appColumn} in (${list})`);
}

/** BIGINT identity PK, per the build spec. Drizzle omits it on insert. */
export const idCol = () =>
  bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity();

/** The tenant dimension carried by every top-level table. */
export const appCol = () => text('app').notNull();

export const createdAtCol = () =>
  timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const updatedAtCol = () =>
  timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();
