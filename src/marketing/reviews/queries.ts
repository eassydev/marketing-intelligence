import { sql, type SQL } from 'drizzle-orm';
import { db } from '../../shared/db/index.js';
import type { AppKind } from '../../shared/types/app.js';
import type { ReviewSourceKind } from './types.js';

export interface ReviewsFilters {
  app: AppKind;
  from: string; // YYYY-MM-DD inclusive
  to: string; // YYYY-MM-DD inclusive
  source?: ReviewSourceKind;
}

export interface ReviewTrendRow {
  source: string;
  snapshot_date: string;
  rating_avg: number | null;
  rating_count: number | null;
  new_reviews_count: number | null;
}

/** Daily review snapshots in-window, ordered by date (then source for stable
 * multi-source rows per day). */
export async function reviewsTrend(f: ReviewsFilters): Promise<ReviewTrendRow[]> {
  const parts: SQL[] = [
    sql`r.app = ${f.app}`,
    sql`r.snapshot_date between ${f.from} and ${f.to}`,
  ];
  if (f.source) parts.push(sql`r.source = ${f.source}`);

  const res = await db.execute(sql`
    select r.source,
           r.snapshot_date::text as snapshot_date,
           r.rating_avg::float8 as rating_avg,
           r.rating_count::int as rating_count,
           r.new_reviews_count::int as new_reviews_count
    from marketing.review_observation r
    where ${sql.join(parts, sql` and `)}
    order by r.snapshot_date, r.source`);
  return res.rows as unknown as ReviewTrendRow[];
}
