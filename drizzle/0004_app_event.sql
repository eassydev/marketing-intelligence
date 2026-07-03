-- 0004_app_event: first-party product-event store (el_* taxonomy).
--
-- RANGE-partitioned monthly on occurred_at. Partitioning is a physical concern
-- the app layer never sees — Drizzle models this as one plain table.
--
-- DIVERGENCE FROM idCol(): the house PK is a BIGINT identity. Here the PK is the
-- COMPOSITE (event_id, occurred_at). Two reasons:
--   1. Postgres requires the partition key (occurred_at) to be part of every
--      unique/PK constraint on a partitioned table.
--   2. event_id is CLIENT-MINTED (a UUID the app generates before send), so it
--      doubles as the idempotency key: ON CONFLICT (event_id, occurred_at) DO
--      NOTHING makes batch re-POSTs (offline retry, at-least-once delivery) safe.
--
-- Partition bounds are half-open [lower, upper) in IST (+05:30) to match the
-- MIL_CRON_TIMEZONE (Asia/Kolkata) convention used across the codebase, so a
-- "month" lines up with the local calendar month the rest of the analytics use.
-- received_at (server clock, default now()) preserves ingest truth regardless of
-- how occurred_at is clamped upstream.

CREATE TABLE marketing.app_event (
  event_id     UUID        NOT NULL,   -- client-minted; idempotency key
  app          TEXT        NOT NULL CHECK (app IN ('services','society')),
  event_name   TEXT        NOT NULL,   -- el_* taxonomy, stored verbatim
  occurred_at  TIMESTAMPTZ NOT NULL,   -- partition key (client event time)
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  session_id   TEXT,                   -- mil_sid
  user_id      BIGINT,
  platform     TEXT,
  app_version  TEXT,
  props        JSONB,
  PRIMARY KEY (event_id, occurred_at)
) PARTITION BY RANGE (occurred_at);

-- Query indexes (created on the parent → propagated to every partition).
CREATE INDEX idx_app_event_name
  ON marketing.app_event (app, event_name, occurred_at);
CREATE INDEX idx_app_event_user
  ON marketing.app_event (app, user_id, occurred_at)
  WHERE user_id IS NOT NULL;
CREATE INDEX idx_app_event_session
  ON marketing.app_event (app, session_id, occurred_at)
  WHERE session_id IS NOT NULL;
-- No GIN on props: props is a debugging/enrichment bag, not a query surface.

-- Catch-all for events outside the seeded range (e.g. a clock-skewed client, or
-- if the maintenance job ever falls behind). Guarantees inserts never fail on a
-- missing partition; the job later reconciles by creating explicit partitions.
CREATE TABLE marketing.app_event_default PARTITION OF marketing.app_event DEFAULT;

-- Seed current + next 3 monthly partitions. Bounds are IST midnight on the 1st.
-- app_event_YYYY_MM covers [YYYY-MM-01 00:00 +05:30, next-month-01 00:00 +05:30).
CREATE TABLE marketing.app_event_2026_07 PARTITION OF marketing.app_event
  FOR VALUES FROM ('2026-07-01 00:00:00+05:30') TO ('2026-08-01 00:00:00+05:30');
CREATE TABLE marketing.app_event_2026_08 PARTITION OF marketing.app_event
  FOR VALUES FROM ('2026-08-01 00:00:00+05:30') TO ('2026-09-01 00:00:00+05:30');
CREATE TABLE marketing.app_event_2026_09 PARTITION OF marketing.app_event
  FOR VALUES FROM ('2026-09-01 00:00:00+05:30') TO ('2026-10-01 00:00:00+05:30');
CREATE TABLE marketing.app_event_2026_10 PARTITION OF marketing.app_event
  FOR VALUES FROM ('2026-10-01 00:00:00+05:30') TO ('2026-11-01 00:00:00+05:30');
