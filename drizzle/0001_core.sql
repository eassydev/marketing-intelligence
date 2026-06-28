-- 0001_core: spine tables (services live, society schema-ready).
-- Money is NUMERIC INR rupees (no paise). `app` is in every UNIQUE key + hot index.

-- 2.1 Ad entities ------------------------------------------------------------
CREATE TABLE marketing.ad_entity (
  id                       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  app                      TEXT NOT NULL CHECK (app IN ('services','society')),
  channel                  TEXT NOT NULL,
  level                    TEXT NOT NULL,
  external_id              TEXT NOT NULL,
  parent_external_id       TEXT,
  name                     TEXT,
  city                     TEXT,
  category                 TEXT,
  objective                TEXT,
  status                   TEXT,
  current_daily_budget_inr NUMERIC(14,2),
  currency                 TEXT,
  raw                      JSONB,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_ad_entity UNIQUE (app, channel, level, external_id)
);
CREATE INDEX idx_ad_entity_channel_level ON marketing.ad_entity (app, channel, level);
CREATE INDEX idx_ad_entity_city_cat      ON marketing.ad_entity (app, city, category);

-- 2.2 Daily performance facts ------------------------------------------------
CREATE TABLE marketing.ad_performance_daily (
  app             TEXT   NOT NULL CHECK (app IN ('services','society')),
  ad_entity_id    BIGINT NOT NULL REFERENCES marketing.ad_entity(id),
  stat_date       DATE   NOT NULL,
  channel         TEXT   NOT NULL,
  spend_inr       NUMERIC(14,2) NOT NULL DEFAULT 0,
  impressions     BIGINT  NOT NULL DEFAULT 0,
  clicks          BIGINT  NOT NULL DEFAULT 0,
  conversions     NUMERIC(14,2) NOT NULL DEFAULT 0,
  conv_value_inr  NUMERIC(14,2) NOT NULL DEFAULT 0,
  ingested_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (app, ad_entity_id, stat_date)
);
CREATE INDEX idx_perf_app_date ON marketing.ad_performance_daily (app, stat_date);

-- 2.3 Attribution touches (sparse click-ids → partial indexes) ---------------
CREATE TABLE marketing.attribution_touch (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  app           TEXT NOT NULL CHECK (app IN ('services','society')),
  occurred_at   TIMESTAMPTZ NOT NULL,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  channel       TEXT,
  fbclid TEXT, gclid TEXT, gbraid TEXT, wbraid TEXT,
  fbc TEXT, fbp TEXT,
  utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, utm_content TEXT, utm_term TEXT,
  session_id    TEXT,
  user_id       BIGINT,
  landing_url   TEXT,
  referrer      TEXT,
  consent       BOOLEAN NOT NULL DEFAULT false,
  raw           JSONB
);
CREATE INDEX idx_touch_gclid   ON marketing.attribution_touch (app, gclid)  WHERE gclid IS NOT NULL;
CREATE INDEX idx_touch_fbclid  ON marketing.attribution_touch (app, fbclid) WHERE fbclid IS NOT NULL;
CREATE INDEX idx_touch_session ON marketing.attribution_touch (app, session_id, occurred_at DESC) WHERE session_id IS NOT NULL;
CREATE INDEX idx_touch_user    ON marketing.attribution_touch (app, user_id, occurred_at DESC)    WHERE user_id IS NOT NULL;

-- 2.4 Conversions = first-party TRUTH ----------------------------------------
CREATE TABLE marketing.conversion (
  id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  app                   TEXT NOT NULL CHECK (app IN ('services','society')),
  order_id              TEXT NOT NULL,
  user_id               BIGINT,
  occurred_at           TIMESTAMPTZ NOT NULL,
  received_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  value_inr             NUMERIC(10,2) NOT NULL,
  is_first_order        BOOLEAN NOT NULL,
  city                  TEXT,
  category              TEXT,
  action_source         TEXT,
  session_id            TEXT,
  attributed_channel    TEXT,
  attributed_entity_id  BIGINT REFERENCES marketing.ad_entity(id),
  attribution_model     TEXT,
  attribution_outcome   TEXT,
  resolved_at           TIMESTAMPTZ,
  CONSTRAINT uq_conversion_order UNIQUE (app, order_id)
);
CREATE INDEX idx_conversion_unresolved ON marketing.conversion (app, received_at) WHERE resolved_at IS NULL;
CREATE INDEX idx_conversion_user       ON marketing.conversion (app, user_id);
CREATE INDEX idx_conversion_entity     ON marketing.conversion (app, attributed_entity_id) WHERE attributed_entity_id IS NOT NULL;

-- 2.5 Identity link (session → user stitch) ----------------------------------
CREATE TABLE marketing.identity_link (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  app         TEXT NOT NULL CHECK (app IN ('services','society')),
  session_id  TEXT NOT NULL,
  user_id     BIGINT NOT NULL,
  linked_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_identity_link UNIQUE (app, session_id, user_id)
);
CREATE INDEX idx_identity_user ON marketing.identity_link (app, user_id);

-- 2.8 Decisions / actions (dry-run now, live later) --------------------------
CREATE TABLE marketing.decision (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  app             TEXT NOT NULL CHECK (app IN ('services','society')),
  proposed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  source          TEXT,
  channel         TEXT,
  entity_level    TEXT,
  external_id     TEXT,
  state_snapshot  JSONB,
  action_type     TEXT,
  action_params   JSONB,
  mode            TEXT NOT NULL DEFAULT 'dry_run' CHECK (mode IN ('dry_run','live')),
  status          TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','approved','executed','rejected')),
  reason          TEXT,
  correlation_id  TEXT,
  approved_by     TEXT,
  approved_at     TIMESTAMPTZ,
  executed_at     TIMESTAMPTZ,
  result          JSONB
);
CREATE INDEX idx_decision_status ON marketing.decision (app, status, proposed_at);
