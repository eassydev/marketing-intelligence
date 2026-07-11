import type { ReviewSnapshot, ReviewSource } from './types.js';
import { fetchJson } from './http.js';

export interface AppStoreConfig {
  appId: string; // APP_STORE_APP_ID (numeric Apple id)
  country: string; // APP_STORE_COUNTRY (storefront, default 'in')
}

interface ItunesLookupResponse {
  results?: Array<{
    averageUserRating?: number;
    userRatingCount?: number;
    averageUserRatingForCurrentVersion?: number;
    userRatingCountForCurrentVersion?: number;
  }>;
}

/**
 * App Store via the public iTunes lookup endpoint — the zero-config default:
 * no App Store Connect key needed, and it DOES return the storefront's
 * aggregate averageUserRating + userRatingCount. It has no "reviews in window"
 * concept, so new_reviews_count is null (the daily rating_count delta serves
 * the same trend need).
 */
export class AppStoreSource implements ReviewSource {
  readonly source = 'app_store';

  constructor(private readonly config: AppStoreConfig) {}

  async fetchSnapshot(): Promise<ReviewSnapshot> {
    const url =
      `https://itunes.apple.com/lookup?id=${encodeURIComponent(this.config.appId)}` +
      `&country=${encodeURIComponent(this.config.country)}`;
    const data = await fetchJson<ItunesLookupResponse>(this.source, url);
    const app = data.results?.[0];
    if (!app) throw new Error(`app_store lookup returned no app for id ${this.config.appId}`);

    return {
      ratingAvg:
        typeof app.averageUserRating === 'number'
          ? Math.round(app.averageUserRating * 100) / 100
          : null,
      ratingCount: typeof app.userRatingCount === 'number' ? app.userRatingCount : null,
      newReviewsCount: null, // lookup exposes aggregates only — see above
      raw: {
        averageUserRating: app.averageUserRating,
        userRatingCount: app.userRatingCount,
        averageUserRatingForCurrentVersion: app.averageUserRatingForCurrentVersion,
        userRatingCountForCurrentVersion: app.userRatingCountForCurrentVersion,
      },
    };
  }
}
