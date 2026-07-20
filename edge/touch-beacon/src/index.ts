/**
 * Public touch beacon — Cloudflare Worker at t.eassylife.in.
 *
 * POST /t : validate + sanitize a first-party touch and forward it to MIL's
 * /ingest/touch over the Cloudflare Tunnel, injecting the ingest bearer token
 * from a Worker secret. Fail-open: the client always gets a fast 2xx once the
 * payload is plausible — a MIL outage must never break a landing page or app
 * launch. Per-client-IP rate limiting happens HERE (the tunnel collapses all
 * beacons onto one egress IP, so MIL can't do it).
 */
import { sanitizeTouch } from './validate.js';

interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  INGEST_TOKEN: string; // secret — MIL INTERNAL_INGEST_TOKEN
  MIL_ORIGIN: string; // e.g. https://mil-ingest.eassylife.in
  ALLOWED_ORIGINS: string; // csv of browser origins
  TOUCH_RATE: RateLimiter;
}

interface Ctx {
  waitUntil(promise: Promise<unknown>): void;
}

const MAX_BODY_BYTES = 4096;

function corsHeaders(origin: string | null, env: Env): Record<string, string> {
  const allowed = env.ALLOWED_ORIGINS.split(',').map((s) => s.trim());
  const headers: Record<string, string> = { vary: 'origin' };
  if (origin && allowed.includes(origin)) {
    headers['access-control-allow-origin'] = origin;
    headers['access-control-allow-methods'] = 'POST, OPTIONS';
    headers['access-control-allow-headers'] = 'content-type';
    headers['access-control-max-age'] = '86400';
  }
  return headers;
}

/** Browser requests must carry an allowed Origin; native apps send none. */
function originAllowed(origin: string | null, env: Env): boolean {
  if (origin === null) return true;
  return env.ALLOWED_ORIGINS.split(',')
    .map((s) => s.trim())
    .includes(origin);
}

async function forwardToMil(payload: unknown, env: Env): Promise<void> {
  const url = `${env.MIL_ORIGIN}/ingest/touch`;
  const init: RequestInit = {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // Cloudflare STRIPS Authorization from a Worker subrequest to a hostname
      // on the same zone (which mil-ingest.eassylife.in is), so the bearer alone
      // arrives as an unauthenticated 401. X-Service-Token survives the hop and
      // MIL's guard accepts either. Authorization is kept for any future
      // off-zone origin.
      authorization: `Bearer ${env.INGEST_TOKEN}`,
      'x-service-token': env.INGEST_TOKEN,
    },
    body: JSON.stringify(payload),
  };
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(url, init);
      if (res.ok) return;
      // The client already got its 204, so a failure here is invisible unless we
      // log it — without this the whole pipeline fails silently.
      const detail = await res.text().catch(() => '');
      console.error(
        `mil forward failed status=${res.status} attempt=${attempt} url=${url} body=${detail.slice(0, 200)}`,
      );
      if (res.status < 500) return; // 4xx won't improve on retry
    } catch (err) {
      console.error(
        `mil forward threw attempt=${attempt} url=${url} err=${(err as Error).message}`,
      );
    }
  }
}

export async function handleRequest(request: Request, env: Env, ctx: Ctx): Promise<Response> {
  const url = new URL(request.url);
  const origin = request.headers.get('origin');
  const cors = corsHeaders(origin, env);

  if (url.pathname !== '/t') return new Response(null, { status: 404, headers: cors });

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }
  if (request.method !== 'POST') {
    return new Response(null, { status: 405, headers: cors });
  }
  if (!originAllowed(origin, env)) {
    return new Response(null, { status: 403, headers: cors });
  }

  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
  const { success } = await env.TOUCH_RATE.limit({ key: ip });
  if (!success) return new Response(null, { status: 429, headers: cors });

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return new Response(null, { status: 413, headers: cors });

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return new Response(null, { status: 400, headers: cors });
  }

  const payload = sanitizeTouch(body);
  if (!payload) return new Response(null, { status: 400, headers: cors });

  // Respond immediately; forward in the background (fail-open).
  ctx.waitUntil(forwardToMil(payload, env));
  return new Response(null, { status: 204, headers: cors });
}

export default {
  fetch: handleRequest,
};
