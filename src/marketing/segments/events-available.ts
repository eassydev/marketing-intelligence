import { sql } from 'drizzle-orm';
import { db } from '../../shared/db/index.js';

/**
 * Whether marketing.app_event exists on this instance. app_event ships on the
 * feat/app-events base branch, but an instance cloned before it migrated would
 * lack the table; segment criteria that reference events must then be rejected
 * (or seeded paused) rather than fail with a hard "relation does not exist".
 *
 * Cached after the first check — the table's existence does not change at runtime.
 */
let cached: boolean | undefined;

export async function appEventAvailable(): Promise<boolean> {
  if (cached !== undefined) return cached;
  const res = await db.execute(
    sql`select to_regclass('marketing.app_event') is not null as present`,
  );
  cached = Boolean((res.rows[0] as { present: boolean } | undefined)?.present);
  return cached;
}

/** Test seam: force the cached value (or clear it with undefined). */
export function __setAppEventAvailable(value: boolean | undefined): void {
  cached = value;
}
