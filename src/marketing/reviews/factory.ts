import { env, type Env } from '../../config/env.js';
import { createChildLogger } from '../../shared/logger/index.js';
import type { ReviewSource } from './types.js';
import { PlayStoreSource } from './play-store.js';
import { AppStoreSource } from './app-store.js';
import { GoogleBusinessSource } from './google-business.js';

const log = createChildLogger({ module: 'reviews-factory' });

type ReviewsEnv = Pick<
  Env,
  | 'GOOGLE_PLAY_PACKAGE_NAME'
  | 'GOOGLE_PLAY_SA_KEY_JSON'
  | 'APP_STORE_APP_ID'
  | 'APP_STORE_COUNTRY'
  | 'GBP_ACCOUNT_ID'
  | 'GBP_LOCATION_ID'
  | 'GBP_SA_KEY_JSON'
>;

/**
 * Build the review sources whose env creds are present (mirrors geo's
 * buildEngines): a source with missing creds is skipped WITH A LOG LINE and
 * never throws, so the service runs fine before any store account is wired.
 */
export function buildReviewSources(source: ReviewsEnv = env): ReviewSource[] {
  const sources: ReviewSource[] = [];

  if (source.GOOGLE_PLAY_PACKAGE_NAME && source.GOOGLE_PLAY_SA_KEY_JSON) {
    sources.push(
      new PlayStoreSource({
        packageName: source.GOOGLE_PLAY_PACKAGE_NAME,
        saKeyJson: source.GOOGLE_PLAY_SA_KEY_JSON,
      }),
    );
  } else {
    log.info(
      'play_store review source skipped — GOOGLE_PLAY_PACKAGE_NAME / GOOGLE_PLAY_SA_KEY_JSON not set',
    );
  }

  if (source.APP_STORE_APP_ID) {
    sources.push(
      new AppStoreSource({ appId: source.APP_STORE_APP_ID, country: source.APP_STORE_COUNTRY }),
    );
  } else {
    log.info('app_store review source skipped — APP_STORE_APP_ID not set');
  }

  if (source.GBP_ACCOUNT_ID && source.GBP_LOCATION_ID && source.GBP_SA_KEY_JSON) {
    sources.push(
      new GoogleBusinessSource({
        accountId: source.GBP_ACCOUNT_ID,
        locationId: source.GBP_LOCATION_ID,
        saKeyJson: source.GBP_SA_KEY_JSON,
      }),
    );
  } else {
    log.info(
      'google_business review source skipped — GBP_ACCOUNT_ID / GBP_LOCATION_ID / GBP_SA_KEY_JSON not set',
    );
  }

  return sources;
}
