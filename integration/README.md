# MIL Integration Patches (review before applying)

These are drop-in starting points for the changes that live OUTSIDE the MIL repo —
in the Express/MySQL backend (`BackendNew`), the customer web, and Flutter. They
are **not** applied automatically because they touch the live payments flow and
the mobile release pipeline. Review, adapt to current code, and ship behind the
`MIL_PRODUCER_ENABLED` flag (shadow → reconcile → enable).

Target MIL endpoint (internal VPC): `$MIL_INGEST_URL` (this instance's private host,
e.g. `http://10.x.x.x:5100`).
Auth: `Authorization: Bearer $MIL_INGEST_TOKEN` (the `INTERNAL_INGEST_TOKEN` value).

## 1. BackendNew — conversion producer
Files here:
- `backend/milClient.js` — outbound poster (axios + exponential retry), CommonJS.
- `backend/conversionProducer.js` — payload builder + emit, with the exact choke points.

Emit on **every transition into `payment_status='paid'`**, AFTER `transaction.commit()`,
inside a `try/catch` that never throws back to Razorpay/booking:
- `controllers/admin/bookingController.js` → `handlePaymentSuccess` (Razorpay webhook; status→paid commit ~line 1581; WACRM `is_wa` branch → `action_source:'system_generated'`).
- `version/customer/v3.0.0/controllers/bookingController.js` → `createBooking` (~line 239), `bookingCheckAndUpdatePartiallyPaid` (~line 2625), `getBookingUpdateAdditionalCost` (~line 2804).

Idempotency = MIL `UNIQUE(app, order_id)` + (recommended) a BullMQ `jobId=conv-<bookingId>`
if you route through the existing queue (`jobs/notificationProducer.js` pattern) instead
of the inline poster. **Verify line anchors against current code** — they drift.

Encryption: `Booking.id`/`user_id` getters re-encrypt; `decrypt()` them
(`middleware/encryption.js`) before sending canonical numeric ids.

First-order: count prior PAID bookings for the user (`deleted_at IS NULL`), pattern in
`controllers/admin/b2bCustomerAnalyticsController.js`. City/category: the booking-item
include tree the webhook already eager-loads.

## 2. Customer web — first-party touch beacon (public, consent-gated)
Capture click-ids/utm at landing, mint a first-party `mil_sid`, POST to `/ingest/touch`.
Deterministic ids only; NO fingerprinting. Fire only with marketing consent.

```html
<script>
(function () {
  try {
    var consent = /(^|;)\s*marketing_consent=1/.test(document.cookie);
    var q = new URLSearchParams(location.search);
    var sid = localStorage.getItem('mil_sid');
    if (!sid) { sid = (crypto.randomUUID && crypto.randomUUID()) || String(Date.now()) + Math.random();
                localStorage.setItem('mil_sid', sid); }
    var read = function (k) { return q.get(k) || null; };
    var fbc = (document.cookie.match(/(^|;)\s*_fbc=([^;]+)/) || [])[2] || null;
    var fbp = (document.cookie.match(/(^|;)\s*_fbp=([^;]+)/) || [])[2] || null;
    var body = {
      app: '<YOUR_APP>', /* this instance's MIL_DEFAULT_APP (e.g. 'services') */ session_id: sid, consent: consent,
      landing_url: location.href, referrer: document.referrer || null,
      gclid: consent ? read('gclid') : null, fbclid: consent ? read('fbclid') : null,
      gbraid: consent ? read('gbraid') : null, wbraid: consent ? read('wbraid') : null,
      fbc: consent ? fbc : null, fbp: consent ? fbp : null,
      utm_source: read('utm_source'), utm_medium: read('utm_medium'),
      utm_campaign: read('utm_campaign'), utm_content: read('utm_content'), utm_term: read('utm_term')
    };
    // NOTE: /ingest/touch is token-gated today (internal-only). When the public
    // beacon ships, expose a public, rate-limited, CORS-restricted touch route on
    // a public MIL hostname and point this at it.
    navigator.sendBeacon('https://MIL_PUBLIC_HOST/ingest/touch', JSON.stringify(body));
  } catch (e) { /* never break the page */ }
})();
</script>
```
Pass the same `mil_sid` to BackendNew on signup + booking so the server can forward a
server-side touch (binding `user_id`) and stamp `session_id` on the conversion — that is
what stitches anonymous touches to the user (resolver tiers user_id → session_id).

## 3. Flutter — install-referrer / deferred deep link (best-effort)
- Android: Play Install Referrer API yields `utm_*`/`gclid` for Google-driven installs →
  parse and POST one touch at first launch with the app's install/session uuid as `session_id`.
- iOS: no install referrer; rely on the link provider's deferred deep-link payload, else
  fall back to first-authenticated-touch. Document the coverage gap.

## 4. BackendNew env
```
MIL_INGEST_URL=http://<MIL_PRIVATE_HOST>:5100   # this instance's internal VPC host
MIL_INGEST_TOKEN=<the MIL INTERNAL_INGEST_TOKEN>
MIL_PRODUCER_ENABLED=false   # shadow first; flip true after reconciling counts
```
