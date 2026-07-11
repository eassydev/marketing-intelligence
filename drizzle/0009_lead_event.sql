-- Phase 6 (§D CAPI): CTWA Lead events for Meta CAPI upload.
-- BackendNew fires a lead event when a WhatsApp conversation qualifies (agent
-- QUOTE stage / lead capture). UNIQUE(app, ctwa_clid) is the idempotency key —
-- one Lead per click — and event_id 'lead-<ctwa_clid>' dedups server-side
-- retries at Meta too. Uploaded as action_source='business_messaging' with the
-- RAW ctwa_clid (Meta requirement for CTWA attribution) by the existing
-- mil-capi-meta job, gated by META_CAPI_ENABLED.
-- As with every MIL migration the CHECK (app IN (...)) list must match
-- MIL_APP_LIST when cloning for a new marketplace (see NEW_INSTANCE.md).

CREATE TABLE marketing.lead_event (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  app              TEXT NOT NULL CHECK (app IN ('services','society')),
  ctwa_clid        TEXT NOT NULL,
  wa_phone_hash    TEXT,            -- sha256 hex of digits-only phone incl. country code (Meta ph form; never raw — DPDP)
  lead_ref         TEXT,            -- producer's lead reference (b2c lead number)
  occurred_at      TIMESTAMPTZ NOT NULL,
  capi_uploaded_at TIMESTAMPTZ,     -- set once pushed to Meta's /events API
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_lead_event UNIQUE (app, ctwa_clid)
);

-- Upload-job work queue: leads not yet pushed to Meta.
CREATE INDEX idx_lead_event_capi_pending
  ON marketing.lead_event (app, occurred_at)
  WHERE capi_uploaded_at IS NULL;
