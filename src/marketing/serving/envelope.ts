import type { AppKind } from '../../shared/types/app.js';
import { env } from '../../config/env.js';

export interface Envelope<T> {
  app: AppKind;
  period: { from: string; to: string };
  filters: { city: string | null; category: string | null };
  currency: string; // MIL_CURRENCY (default INR)
  data: T;
  generatedAt: string;
}

export function envelope<T>(
  app: AppKind,
  period: { from: string; to: string },
  filters: { city?: string | null; category?: string | null },
  data: T,
): Envelope<T> {
  return {
    app,
    period,
    filters: { city: filters.city ?? null, category: filters.category ?? null },
    currency: env.MIL_CURRENCY,
    data,
    generatedAt: new Date().toISOString(),
  };
}
