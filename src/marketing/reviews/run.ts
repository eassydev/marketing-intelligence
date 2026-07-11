import { env } from '../../config/env.js';
import { db } from '../../shared/db/index.js';
import { reviewObservation } from '../../shared/schema/index.js';
import { createChildLogger } from '../../shared/logger/index.js';
import { buildReviewSources } from './factory.js';
import type { ReviewSource } from './types.js';

const log = createChildLogger({ module: 'reviews-run' });

export interface ReviewsIngestResult {
  sources: number;
  written: number;
  failed: number;
}

/** YYYY-MM-DD of `d` in the instance cron timezone (Asia/Kolkata by default) —
 * en-CA's date format IS the ISO date shape. */
function snapshotDate(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: env.MIL_CRON_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/**
 * mil-reviews-ingest entrypoint: snapshot every configured review source into
 * review_observation, one row per (app, source, day). A single source outage
 * skips that source (logged), never the whole run — mirrors runGeoMonitor.
 * UNIQUE(app, source, snapshot_date) + onConflictDoNothing makes retries and
 * duplicate scheduler fires idempotent (first write of the day wins).
 */
export async function runReviewsIngest(): Promise<ReviewsIngestResult> {
  const sources = buildReviewSources();
  if (sources.length === 0) {
    log.warn('No review source credentials configured — skipping reviews ingest run');
    return { sources: 0, written: 0, failed: 0 };
  }

  const observedAt = new Date();
  const date = snapshotDate(observedAt);
  let written = 0;
  let failed = 0;

  for (const source of sources) {
    const wrote = await ingestSource(source, observedAt, date);
    if (wrote === null) failed += 1;
    else written += wrote;
  }

  log.info({ sources: sources.length, date, written, failed }, 'reviews ingest run complete');
  return { sources: sources.length, written, failed };
}

/** Snapshot one source. Returns rows written (0 = deduped), null on failure. */
async function ingestSource(
  source: ReviewSource,
  observedAt: Date,
  date: string,
): Promise<number | null> {
  let snapshot;
  try {
    snapshot = await source.fetchSnapshot();
  } catch (err) {
    log.error(
      { source: source.source, err: (err as Error).message },
      'review source fetch failed — continuing with next',
    );
    return null;
  }

  const returned = await db
    .insert(reviewObservation)
    .values({
      app: env.MIL_DEFAULT_APP,
      source: source.source,
      snapshotDate: date,
      observedAt,
      ratingAvg: snapshot.ratingAvg != null ? String(snapshot.ratingAvg) : null,
      ratingCount: snapshot.ratingCount,
      newReviewsCount: snapshot.newReviewsCount,
      raw: snapshot.raw ?? null,
    })
    .onConflictDoNothing({
      target: [reviewObservation.app, reviewObservation.source, reviewObservation.snapshotDate],
    })
    .returning({ id: reviewObservation.id });

  log.info(
    { source: source.source, date, deduped: returned.length === 0 },
    'review snapshot ingested',
  );
  return returned.length;
}
