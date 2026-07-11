-- Phase 2: Click-to-WhatsApp (CTWA) attribution.
-- BackendNew forwards WhatsApp webhook referrals as touches (channel='ctwa',
-- session_id='wa-<wamid>') carrying Meta's ctwa_clid plus a SHA-256 hex hash
-- of the sender's E.164 phone (never the raw number — DPDP). WhatsApp-originated
-- bookings later enrich the conversion with the same ctwa_clid so the resolver
-- can join without a web session. ctwa_clid is sparse → partial index, matching
-- the gclid/fbclid pattern. `action_source` has no DB CHECK (plain TEXT), so
-- 'business_messaging' needs no constraint change here.

ALTER TABLE marketing.attribution_touch
  ADD COLUMN ctwa_clid     TEXT,
  ADD COLUMN wa_phone_hash TEXT;

CREATE INDEX idx_touch_ctwa_clid
  ON marketing.attribution_touch (app, ctwa_clid)
  WHERE ctwa_clid IS NOT NULL;

ALTER TABLE marketing.conversion
  ADD COLUMN ctwa_clid         TEXT,
  ADD COLUMN messaging_channel TEXT;
