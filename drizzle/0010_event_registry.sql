-- 0010_event_registry: event definitions registry for the events monitor.
--
-- One row per (app, source, event_name): a human description plus the expected
-- cadence, so GET /marketing/events/overview can grade every observed stream
-- ok / stale / muted / unregistered. event_name '' (empty string, the DEFAULT)
-- marks a WHOLE-STREAM row — click/lead/conversion/touch carry no per-event
-- names — and an empty string instead of NULL keeps UNIQUE (app, source,
-- event_name) airtight (NULLs never collide under UNIQUE).
--
-- 'notification' and 'web' sources register here too, but their live counters
-- are served by BackendNew's engagement overview (MySQL notifications ledger),
-- not by MIL. As with every MIL migration the CHECK (app IN (...)) list must
-- match MIL_APP_LIST when cloning for a new marketplace (see NEW_INSTANCE.md).

CREATE TABLE marketing.event_registry (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  app                TEXT NOT NULL DEFAULT 'services' CHECK (app IN ('services','society')),
  source             TEXT NOT NULL
                       CHECK (source IN ('app','click','lead','conversion','touch','notification','web')),
  event_name         TEXT NOT NULL DEFAULT '',   -- '' = whole-stream row
  description        TEXT,
  expected_frequency TEXT NOT NULL DEFAULT 'none'
                       CHECK (expected_frequency IN ('none','hourly','daily','weekly')),
  is_active          BOOLEAN NOT NULL DEFAULT true,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_event_registry UNIQUE (app, source, event_name)
);
