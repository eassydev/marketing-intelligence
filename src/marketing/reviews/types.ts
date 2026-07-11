/** Review-source contract (Module — reviews; mirrors geo/engines/types.ts). */

export type ReviewSourceKind = 'google_business' | 'play_store' | 'app_store';

/** One day's snapshot of a source's rating state. Fields the source's API does
 * not expose are null (documented per client). */
export interface ReviewSnapshot {
  ratingAvg: number | null;
  ratingCount: number | null;
  newReviewsCount: number | null;
  raw: unknown; // trimmed source payload for the JSONB debug column
}

export interface ReviewSource {
  readonly source: ReviewSourceKind;
  fetchSnapshot(): Promise<ReviewSnapshot>;
}
