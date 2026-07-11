import crypto from 'node:crypto';
import { fetchJson } from './http.js';

/**
 * Minimal Google service-account OAuth (JWT-bearer grant) with node:crypto —
 * both Google review sources (Play Developer API, Business Profile API) need
 * only "sign a JWT, swap it for an access token", so pulling in googleapis
 * (~10MB) for two GET endpoints is not warranted. RS256 = RSA-SHA256, which
 * crypto.createSign supports natively.
 */

export interface ServiceAccountKey {
  client_email: string;
  private_key: string;
}

const TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** Parse a service-account key JSON (the full downloaded file) from env. */
export function parseServiceAccountKey(json: string): ServiceAccountKey {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('service-account key is not valid JSON');
  }
  const key = parsed as Partial<ServiceAccountKey>;
  if (!key.client_email || !key.private_key) {
    throw new Error('service-account key JSON must contain client_email and private_key');
  }
  return { client_email: key.client_email, private_key: key.private_key };
}

const b64url = (input: Buffer | string): string =>
  Buffer.from(input).toString('base64url');

/** Build the signed RS256 JWT assertion for the given OAuth scope. */
export function buildJwtAssertion(
  key: ServiceAccountKey,
  scope: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): string {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(
    JSON.stringify({
      iss: key.client_email,
      scope,
      aud: TOKEN_URL,
      iat: nowSeconds,
      exp: nowSeconds + 3600,
    }),
  );
  const input = `${header}.${claims}`;
  const signature = crypto.createSign('RSA-SHA256').update(input).sign(key.private_key);
  return `${input}.${b64url(signature)}`;
}

/** Exchange the JWT assertion for a bearer access token. Tokens are short-lived
 * and the job runs once a day, so no caching. */
export async function fetchAccessToken(key: ServiceAccountKey, scope: string): Promise<string> {
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: buildJwtAssertion(key, scope),
  });
  const data = await fetchJson<{ access_token?: string }>('google-oauth', TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!data.access_token) throw new Error('google token exchange returned no access_token');
  return data.access_token;
}
