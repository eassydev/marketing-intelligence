-- Phase F: Meta Conversions API (CAPI) upload tracking.
-- Records when a resolved Purchase conversion was pushed to Meta's dataset
-- /events endpoint so the mil-capi-meta job never double-sends. The partial
-- index is the job's work queue: resolved purchases not yet uploaded.

ALTER TABLE marketing.conversion ADD COLUMN capi_uploaded_at TIMESTAMPTZ;

CREATE INDEX idx_conversion_capi_pending
  ON marketing.conversion (app, occurred_at)
  WHERE capi_uploaded_at IS NULL AND resolved_at IS NOT NULL;
