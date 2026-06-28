import type { AppKind } from '../../shared/types/app.js';

export interface Envelope<T> {
  app: AppKind;
  period: { from: string; to: string };
  filters: { city: string | null; category: string | null };
  currency: 'INR';
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
    currency: 'INR',
    data,
    generatedAt: new Date().toISOString(),
  };
}
