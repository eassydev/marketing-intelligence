import type { ReviewSnapshot, ReviewSource } from './types.js';
import { fetchJson } from './http.js';
import { parseServiceAccountKey, fetchAccessToken } from './google-auth.js';

export interface PlayStoreConfig {
  packageName: string; // GOOGLE_PLAY_PACKAGE_NAME
  saKeyJson: string; // GOOGLE_PLAY_SA_KEY_JSON (full key file JSON)
}

const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';

interface PlayReviewsResponse {
  reviews?: Array<{
    comments?: Array<{ userComment?: { starRating?: number } }>;
  }>;
}

/**
 * Google Play via the Play Developer API Reviews endpoint.
 *
 * DOCUMENTED LIMITATION: the public androidpublisher API only exposes reviews
 * WITH COMMENTS from the last ~7 days — it does NOT expose the store listing's
 * lifetime aggregate rating (that lives in the Play Console UI / reporting
 * exports only). We snapshot what IS available: the average star rating and
 * count of the recent commented reviews. rating_count (lifetime aggregate) is
 * therefore always null for this source.
 */
export class PlayStoreSource implements ReviewSource {
  readonly source = 'play_store';

  constructor(private readonly config: PlayStoreConfig) {}

  async fetchSnapshot(): Promise<ReviewSnapshot> {
    const key = parseServiceAccountKey(this.config.saKeyJson);
    const token = await fetchAccessToken(key, SCOPE);
    const url =
      `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/` +
      `${encodeURIComponent(this.config.packageName)}/reviews?maxResults=100`;
    const data = await fetchJson<PlayReviewsResponse>(this.source, url, {
      headers: { authorization: `Bearer ${token}` },
    });

    const stars = (data.reviews ?? [])
      .map((r) => r.comments?.[0]?.userComment?.starRating)
      .filter((n): n is number => typeof n === 'number');
    const ratingAvg =
      stars.length > 0
        ? Math.round((stars.reduce((a, b) => a + b, 0) / stars.length) * 100) / 100
        : null;

    return {
      ratingAvg,
      ratingCount: null, // aggregate rating not exposed by this API — see above
      newReviewsCount: (data.reviews ?? []).length,
      raw: { reviews_returned: (data.reviews ?? []).length, star_ratings: stars },
    };
  }
}
