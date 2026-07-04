import { sql } from 'drizzle-orm';
import { db } from '../../shared/db/index.js';
import { env } from '../../config/env.js';
import { createChildLogger } from '../../shared/logger/index.js';

const log = createChildLogger({ module: 'event-partitions' });

/**
 * Monthly RANGE partition descriptor for marketing.app_event. Bounds are IST
 * (+05:30) half-open [lower, upper), matching drizzle/0004_app_event.sql so the
 * job-created partitions align exactly with the seeded ones.
 */
export interface PartitionSpec {
  /** Suffix: app_event_YYYY_MM. */
  name: string;
  /** Inclusive lower bound, e.g. '2026-07-01 00:00:00+05:30'. */
  from: string;
  /** Exclusive upper bound (first instant of the next month). */
  to: string;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** IST midnight on the 1st of the given year/month (1-based month). */
function istMonthStart(year: number, month: number): string {
  return `${year}-${pad(month)}-01 00:00:00+05:30`;
}

/**
 * Build the partition spec for the month `offset` months after `year`/`month`
 * (1-based). Pure — the single source of truth for partition naming + bounds,
 * unit-tested independently of any DB.
 */
export function partitionSpecFor(year: number, month: number, offset = 0): PartitionSpec {
  // Normalize (year, month) + offset into a canonical (y, m0) with m0 in 0..11.
  const zeroBased = month - 1 + offset;
  const y = year + Math.floor(zeroBased / 12);
  const m0 = ((zeroBased % 12) + 12) % 12;
  const nextZero = zeroBased + 1;
  const ny = year + Math.floor(nextZero / 12);
  const nm0 = ((nextZero % 12) + 12) % 12;
  return {
    name: `app_event_${y}_${pad(m0 + 1)}`,
    from: istMonthStart(y, m0 + 1),
    to: istMonthStart(ny, nm0 + 1),
  };
}

/**
 * The set of month suffixes (YYYY_MM) that must be RETAINED as of `now`, i.e.
 * from `retentionMonths - 1` months ago through the two months we pre-create.
 * A partition whose suffix is NOT in this set (and is not the default) is a drop
 * candidate. Pure so the retention boundary is unit-testable.
 */
export function retainedMonthSuffixes(now: Date, retentionMonths: number): Set<string> {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + 1; // 1-based
  const suffixes = new Set<string>();
  // Keep [now - (retentionMonths - 1), now + 2] inclusive.
  for (let offset = -(retentionMonths - 1); offset <= 2; offset += 1) {
    suffixes.add(partitionSpecFor(y, m, offset).name);
  }
  return suffixes;
}

/**
 * Ensure the current + next 2 monthly partitions exist, then drop partitions
 * older than MIL_EVENTS_RETENTION_MONTHS. Idempotent (IF NOT EXISTS on create,
 * membership check on drop). Runs monthly on a scheduler; concurrency 1.
 */
export async function maintainEventPartitions(
  now: Date = new Date(),
): Promise<{ created: string[]; dropped: string[] }> {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;

  // Create current + next 2 (offsets 0..2). Seed migration already made 0..3,
  // so on a fresh DB these are all no-ops; a month later they fill the gap.
  const created: string[] = [];
  for (let offset = 0; offset <= 2; offset += 1) {
    const spec = partitionSpecFor(year, month, offset);
    // DDL (CREATE TABLE) cannot use bind parameters — partition bounds must be
    // SQL literals. spec.from/to are code-generated (never user input), so
    // inlining them as quoted literals via sql.raw is safe from injection.
    await db.execute(
      sql.raw(
        `CREATE TABLE IF NOT EXISTS marketing.${spec.name} ` +
          `PARTITION OF marketing.app_event ` +
          `FOR VALUES FROM ('${spec.from}') TO ('${spec.to}')`,
      ),
    );
    created.push(spec.name);
  }

  // Drop partitions older than the retention window. Enumerate real child
  // partitions via the catalog and drop any month-suffixed one not retained.
  const retained = retainedMonthSuffixes(now, env.MIL_EVENTS_RETENTION_MONTHS);
  const children = await db.execute<{ relname: string }>(sql`
    SELECT c.relname
    FROM pg_inherits i
    JOIN pg_class c   ON c.oid = i.inhrelid
    JOIN pg_class p   ON p.oid = i.inhparent
    JOIN pg_namespace n ON n.oid = p.relnamespace
    WHERE n.nspname = 'marketing' AND p.relname = 'app_event'`);

  const dropped: string[] = [];
  for (const row of children.rows as Array<{ relname: string }>) {
    const name = row.relname;
    // Never touch the default partition or anything not matching the monthly
    // naming (defensive — only manage what this job owns).
    if (!/^app_event_\d{4}_\d{2}$/.test(name)) continue;
    if (retained.has(name)) continue;
    await db.execute(sql`DROP TABLE IF EXISTS ${sql.raw(`marketing.${name}`)}`);
    dropped.push(name);
  }

  log.info({ created, dropped, retentionMonths: env.MIL_EVENTS_RETENTION_MONTHS }, 'partitions maintained');
  return { created, dropped };
}
