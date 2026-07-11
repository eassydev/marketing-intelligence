-- Phase 6: first-party click touches.
-- BackendNew's self-hosted redirect (`GET /r/:slug`) and lead ingest forward
-- their events as touches with touch_type='first_party_click' / 'lead', so
-- offline placements (QR posters, society banners) get a click stage in the
-- campaign funnel without any ad-platform involvement. A first-party click IS
-- a touch (link/placement/campaign ids + slug ride in `raw` JSONB) — no new
-- table. Values: 'touch' | 'first_party_click' | 'lead'; validated at ingest
-- (zod enum), plain TEXT here matching channel/action_source (no DB CHECK).
--
-- The partial index serves the campaign-funnel serving queries, which group and
-- attribute by utm_campaign over a date window; utm_campaign is sparse on
-- organic touches, hence the WHERE guard (matches the gclid/fbclid pattern).

ALTER TABLE marketing.attribution_touch
  ADD COLUMN touch_type TEXT NOT NULL DEFAULT 'touch';

CREATE INDEX idx_touch_campaign
  ON marketing.attribution_touch (app, utm_campaign, occurred_at DESC)
  WHERE utm_campaign IS NOT NULL;
