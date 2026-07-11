-- Phase 6: store / Google-Business review snapshots (brand health trend).
-- One row per (app, source, snapshot_date) written by the daily
-- mil-reviews-ingest job. Store APIs expose no reviewer↔booking identity, so
-- these are brand-level trend lines, not per-campaign attribution.
-- snapshot_date is the ingest day in MIL_CRON_TIMEZONE; the UNIQUE key makes
-- job retries/backfills idempotent (first write of the day wins).
-- As with every MIL migration the CHECK (app IN (...)) list must match
-- MIL_APP_LIST when cloning for a new marketplace (see NEW_INSTANCE.md).

CREATE TABLE marketing.review_observation (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  app               TEXT NOT NULL CHECK (app IN ('services','society')),
  source            TEXT NOT NULL
                      CHECK (source IN ('google_business','play_store','app_store')),
  snapshot_date     DATE NOT NULL,
  observed_at       TIMESTAMPTZ NOT NULL,
  rating_avg        NUMERIC(3,2),      -- e.g. 4.58; NULL when the API exposes none
  rating_count      INTEGER,           -- lifetime aggregate count where available
  new_reviews_count INTEGER,           -- reviews seen in the source's recency window
  raw               JSONB,             -- trimmed source payload for debugging
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_review_obs UNIQUE (app, source, snapshot_date)
);
