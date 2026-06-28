// Drop into BackendNew at e.g. helper/milClient.js (CommonJS).
// Outbound poster to the Marketing Intelligence Layer. Mirrors the Woloo webhook
// retry pattern (integrations/organizations/woloo/services/webhookService.js):
// axios POST with exponential backoff. Failures are logged, never thrown back to
// the payment flow. MIL's UNIQUE(app, order_id) makes duplicate sends harmless.

const axios = require('axios');

const MIL_URL = process.env.MIL_INGEST_URL; // http://10.11.156.8:5100
const MIL_TOKEN = process.env.MIL_INGEST_TOKEN;
const ENABLED = process.env.MIL_PRODUCER_ENABLED === 'true';
const BACKOFFS_MS = [30000, 120000, 600000]; // 30s, 2m, 10m

async function post(path, payload, attempt = 0) {
  if (!ENABLED) return; // shadow mode: no-op
  if (!MIL_URL || !MIL_TOKEN) {
    console.warn('[mil] MIL_INGEST_URL / MIL_INGEST_TOKEN not set — skipping', path);
    return;
  }
  try {
    await axios.post(`${MIL_URL}${path}`, payload, {
      headers: { Authorization: `Bearer ${MIL_TOKEN}`, 'Content-Type': 'application/json' },
      timeout: 15000,
    });
  } catch (err) {
    if (attempt < BACKOFFS_MS.length) {
      setTimeout(() => post(path, payload, attempt + 1), BACKOFFS_MS[attempt]);
    } else {
      console.error('[mil] post failed permanently', path, err && err.message);
    }
  }
}

module.exports = {
  emitConversion: (payload) => post('/ingest/conversion', payload),
  emitTouch: (payload) => post('/ingest/touch', payload),
};
