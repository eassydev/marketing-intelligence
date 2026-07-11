import type { ReviewSnapshot, ReviewSource } from './types.js';
import { fetchJson } from './http.js';
import { parseServiceAccountKey, fetchAccessToken } from './google-auth.js';

export interface GoogleBusinessConfig {
  accountId: string; // GBP_ACCOUNT_ID
  locationId: string; // GBP_LOCATION_ID
  saKeyJson: string; // GBP_SA_KEY_JSON (full key file JSON)
}

const SCOPE = 'https://www.googleapis.com/auth/business.manage';

interface GbpReviewsResponse {
  averageRating?: number;
  totalReviewCount?: number;
  reviews?: unknown[];
}

/**
 * Google Business Profile via the (v4) reviews endpoint, which returns the
 * location's aggregate averageRating + totalReviewCount alongside the review
 * page. pageSize=1 keeps the payload minimal — we only want the aggregates.
 * new_reviews_count is null; the daily totalReviewCount delta carries the trend.
 * NOTE: the GBP API requires an approved API-access request on the Google
 * business account before the service account can call it (ops precondition).
 */
export class GoogleBusinessSource implements ReviewSource {
  readonly source = 'google_business';

  constructor(private readonly config: GoogleBusinessConfig) {}

  async fetchSnapshot(): Promise<ReviewSnapshot> {
    const key = parseServiceAccountKey(this.config.saKeyJson);
    const token = await fetchAccessToken(key, SCOPE);
    const url =
      `https://mybusiness.googleapis.com/v4/accounts/${encodeURIComponent(this.config.accountId)}` +
      `/locations/${encodeURIComponent(this.config.locationId)}/reviews?pageSize=1`;
    const data = await fetchJson<GbpReviewsResponse>(this.source, url, {
      headers: { authorization: `Bearer ${token}` },
    });

    return {
      ratingAvg:
        typeof data.averageRating === 'number'
          ? Math.round(data.averageRating * 100) / 100
          : null,
      ratingCount: typeof data.totalReviewCount === 'number' ? data.totalReviewCount : null,
      newReviewsCount: null, // aggregate endpoint — count delta carries the trend
      raw: { averageRating: data.averageRating, totalReviewCount: data.totalReviewCount },
    };
  }
}
