# mil-touch-beacon — public touch beacon Worker

Receives first-party touch beacons from the web (`MilAttributionInit` on
eassylife.in) and the Flutter app (install-referrer touch) at
`https://t.eassylife.in/t`, then forwards sanitized payloads to MIL's
`/ingest/touch` over the Cloudflare Tunnel with the ingest token injected from a
Worker secret. See the repo-root plan/NEW_INSTANCE.md for the tunnel side.

Edge responsibilities (MIL never sees raw public traffic):
- CORS allowlist (browser origins; native apps send no Origin and are allowed)
- Per-client-IP rate limit (10/min) — the tunnel collapses egress to one IP, so
  MIL cannot do per-client limiting
- Whitelist validation (`edge/touch-beacon/src/validate.ts`): UUID `session_id`,
  `touch_type ∈ {touch, first_party_click}`, utm_*/click-ids only; `app` forced
  to `services`; `user_id`/`wa_phone_hash`/`ctwa_clid`/`channel`/`raw` never
  accepted from the public
- DPDP consent gate: click-ids (gclid/fbclid/fbc/fbp/…) forwarded only when
  `consent === true`; utm-only touches always pass
- Fail-open: client gets 204 immediately; MIL forward runs in `waitUntil` with
  one retry — an MIL outage never breaks a landing page or app launch

## Deploy (Cloudflare account with the eassylife.in zone)

```bash
cd edge/touch-beacon
npx wrangler deploy                       # creates the worker + t.eassylife.in route
npx wrangler secret put INGEST_TOKEN      # paste MIL INTERNAL_INGEST_TOKEN
```

`MIL_ORIGIN` / `ALLOWED_ORIGINS` live in `wrangler.toml` [vars]. The rate-limit
binding (`TOUCH_RATE`) is declared in `wrangler.toml` [[unsafe.bindings]].

## Test

Unit tests run under the repo-root vitest (pure Node, no Workers runtime):

```bash
npx vitest run edge/touch-beacon/test/beacon.test.ts
```

Post-deploy smoke:

```bash
curl -si -X POST https://t.eassylife.in/t \
  -H 'origin: https://eassylife.in' -H 'content-type: application/json' \
  -d '{"session_id":"123e4567-e89b-42d3-a456-426614174000","utm_campaign":"cf_e2e_test","touch_type":"first_party_click"}'
# expect HTTP/2 204 — then verify the row landed in marketing.attribution_touch
```
