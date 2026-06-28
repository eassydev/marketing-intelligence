import { eq, and, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import type { AppKind } from '../types/app.js';

/**
 * Tenant-isolation helper. MIL is a single trusted internal service (one DB
 * role), so isolation is enforced at the application layer rather than RLS:
 * every marketing-table query MUST be scoped by `app`. These helpers make that
 * the path of least resistance, and `app` leads every unique/hot index so the
 * scoping is also structural.
 *
 * Usage:
 *   db.select().from(conversion).where(scopedBy(conversion.app, app, eq(conversion.id, id)))
 *   db.insert(conversion).values(stampApp(app, { orderId, valueInr, ... }))
 */
export function scopedBy(
  appColumn: PgColumn,
  app: AppKind,
  ...extra: Array<SQL | undefined>
): SQL {
  const clauses = [eq(appColumn, app), ...extra].filter(
    (c): c is SQL => c !== undefined,
  );
  // `and` of a non-empty list is always defined.
  return and(...clauses) as SQL;
}

export function stampApp<T extends Record<string, unknown>>(
  app: AppKind,
  values: T,
): T & { app: AppKind } {
  return { ...values, app };
}
