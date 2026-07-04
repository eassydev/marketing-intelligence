-- 0005_segments: behavioural segmentation.
--
-- marketing.segment       — the versioned criteria DSL (`definition` JSONB) plus
--                           refresh bookkeeping (last_count / last_error / …).
-- marketing.segment_membership — materialised (segment_id, user_id) membership,
--                           fully rebuilt each refresh (DELETE + INSERT in one tx).
--
-- The status CHECK mirrors src/shared/schema/marketing/segment.ts. As with every
-- MIL migration the CHECK (app IN (...)) list must match MIL_APP_LIST when cloning
-- for a new marketplace (see NEW_INSTANCE.md).

CREATE TABLE marketing.segment (
  id                       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  app                      TEXT NOT NULL CHECK (app IN ('services','society')),
  slug                     TEXT NOT NULL,
  name                     TEXT NOT NULL,
  description              TEXT,
  definition               JSONB NOT NULL,
  refresh_interval_minutes INTEGER NOT NULL DEFAULT 360,
  status                   TEXT NOT NULL DEFAULT 'active'
                             CHECK (status IN ('active','paused','archived')),
  is_system                BOOLEAN NOT NULL DEFAULT false,
  created_by               TEXT,
  last_refreshed_at        TIMESTAMPTZ,
  last_refresh_ms          INTEGER,
  last_count               INTEGER,
  last_error               TEXT,
  meta_audience_id         TEXT,                 -- future Meta CAPI Custom Audience seam
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_segment_slug UNIQUE (app, slug)
);
CREATE INDEX idx_segment_status ON marketing.segment (app, status);

CREATE TABLE marketing.segment_membership (
  segment_id  BIGINT NOT NULL REFERENCES marketing.segment(id) ON DELETE CASCADE,
  user_id     BIGINT NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (segment_id, user_id)
);

-- Membership compilation groups conversions per (app, user_id) over time windows
-- (recency / frequency / monetary). This composite index makes the per-user
-- aggregate scans index-only-ish and keyset member pagination cheap. IF NOT
-- EXISTS is defensive: a future migration may add the same index.
CREATE INDEX IF NOT EXISTS idx_conversion_user_time
  ON marketing.conversion (app, user_id, occurred_at)
  WHERE user_id IS NOT NULL;

-- app_event lives on feat/app-events (drizzle/0004). It may be absent on an
-- instance that has not yet migrated it, so guard the index behind a regclass
-- check rather than assuming the table exists.
DO $$
BEGIN
  IF to_regclass('marketing.app_event') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_app_event_seg
      ON marketing.app_event (app, event_name, user_id, occurred_at);
  END IF;
END $$;
