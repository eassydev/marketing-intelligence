import { createChildLogger } from '../../shared/logger/index.js';

const log = createChildLogger({ module: 'reviews-http' });

const TIMEOUT_MS = 30_000;
const RETRY_DELAY_MS = 1_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fetch JSON from a review source with the module-wide reliability contract
 * (same shape as geo/engines/http.ts): 30s timeout, exactly one retry on
 * 429/5xx, log-and-throw on hard failure. run.ts catches per source, so one
 * broken source never sinks the whole ingest run.
 */
export async function fetchJson<T>(
  source: string,
  url: string,
  init: RequestInit = {},
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      log.error({ source, err: (err as Error).message }, 'review request failed (network/timeout)');
      throw err;
    }

    if (res.ok) return (await res.json()) as T;

    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempt === 1) {
      log.warn({ source, status: res.status }, 'review request retryable — retrying once');
      await sleep(RETRY_DELAY_MS);
      continue;
    }

    const detail = await res.text().catch(() => '');
    log.error({ source, status: res.status, body: detail.slice(0, 300) }, 'review request failed');
    throw new Error(`${source} API ${res.status}`);
  }
}
