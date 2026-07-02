import { createChildLogger } from '../../../shared/logger/index.js';

const log = createChildLogger({ module: 'geo-engine' });

const TIMEOUT_MS = 30_000;
const RETRY_DELAY_MS = 1_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * POST JSON to an engine API with the module-wide reliability contract:
 * 30s timeout, exactly one retry on 429/5xx, log-and-throw on hard failure.
 */
export async function postJsonWithRetry<T>(
  engine: string,
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<T> {
  const init: RequestInit = {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  };

  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      log.error({ engine, url, err: (err as Error).message }, 'engine request failed (network/timeout)');
      throw err;
    }

    if (res.ok) return (await res.json()) as T;

    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempt === 1) {
      log.warn({ engine, status: res.status }, 'engine request retryable — retrying once');
      await sleep(RETRY_DELAY_MS);
      continue;
    }

    const detail = await res.text().catch(() => '');
    log.error({ engine, status: res.status, body: detail.slice(0, 300) }, 'engine request failed');
    throw new Error(`${engine} API ${res.status}`);
  }
}

const URL_RE = /https?:\/\/[^\s"'<>()[\]{}]+/gi;

/** Normalize a URL (or bare domain) to a hostname; null when unparseable. */
export function toDomain(urlish: string): string | null {
  for (const candidate of [urlish, `https://${urlish}`]) {
    try {
      const host = new URL(candidate).hostname.toLowerCase().replace(/^www\./, '');
      if (host.includes('.')) return host;
    } catch {
      // not a parseable URL in this form — try the prefixed form / give up
    }
  }
  return null;
}

/**
 * Extract cited domains from URLs embedded in an answer's text. Used for
 * engines without a native citations array (all but Perplexity).
 */
export function extractDomains(text: string): string[] {
  const out = new Set<string>();
  for (const match of text.match(URL_RE) ?? []) {
    // Strip trailing punctuation that commonly clings to inline links.
    const domain = toDomain(match.replace(/[.,;:!?]+$/, ''));
    if (domain) out.add(domain);
  }
  return [...out];
}
