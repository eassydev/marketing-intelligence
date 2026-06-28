/**
 * The tenant dimension carried by every top-level table, API filter, and index.
 * `services` is live now; `society` (communityOS) is schema-ready and parked.
 */
export const APPS = ['services', 'society'] as const;

export type AppKind = (typeof APPS)[number];

export function isAppKind(value: unknown): value is AppKind {
  return typeof value === 'string' && (APPS as readonly string[]).includes(value);
}
