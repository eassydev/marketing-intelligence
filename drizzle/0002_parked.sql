-- 0002_parked: tables for the parked modules, created now so they need no
-- migration when their jobs ship. No code writes these in Phase 0.

-- 2.5 GEO/AI-presence observations (Interpretation 1) ------------------------
CREATE TABLE marketing.geo_observation (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  app             TEXT NOT NULL CHECK (app IN ('services','society')),
  run_at          TIMESTAMPTZ NOT NULL,
  engine          TEXT NOT NULL,
  prompt_key      TEXT NOT NULL,
  prompt          TEXT NOT NULL,
  brand_mentioned BOOLEAN,
  position        INT,
  cited_url       TEXT,
  competitors     JSONB,
  raw_response    TEXT
);
CREATE INDEX idx_geo_app_prompt ON marketing.geo_observation (app, prompt_key, run_at);

-- 2.6 SEO/technical signals (Interpretation 1) -------------------------------
CREATE TABLE marketing.seo_signal (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  app          TEXT NOT NULL CHECK (app IN ('services','society')),
  checked_at   TIMESTAMPTZ NOT NULL,
  url          TEXT NOT NULL,
  raw_html_ok  BOOLEAN,
  schema_types TEXT[],
  indexable    BOOLEAN,
  lcp_ms       INT,
  notes        JSONB
);
CREATE INDEX idx_seo_app_url ON marketing.seo_signal (app, url, checked_at);

-- 2.7 Alerts (Interpretation 2 anomaly layer) --------------------------------
CREATE TABLE marketing.alert (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  app             TEXT NOT NULL CHECK (app IN ('services','society')),
  fired_at        TIMESTAMPTZ NOT NULL,
  severity        TEXT,
  rule_key        TEXT NOT NULL,
  scope           JSONB,
  metric          TEXT,
  observed        NUMERIC(14,2),
  threshold       NUMERIC(14,2),
  message         TEXT,
  acknowledged_at TIMESTAMPTZ
);
CREATE INDEX idx_alert_app_fired ON marketing.alert (app, fired_at);
