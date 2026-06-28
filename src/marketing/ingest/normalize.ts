/**
 * The one place the `{city}_{category}_{objective}` campaign-naming convention
 * lives. Tolerant: missing segments return undefined, the raw name is preserved
 * by the caller. Unparseable names are surfaced via `parsedOk` so a lint/report
 * can flag campaigns that won't join in the hero metric.
 */
export interface ParsedName {
  city?: string;
  category?: string;
  objective?: string;
  parsedOk: boolean;
}

export function parseEntityName(name: string | undefined): ParsedName {
  if (!name) return { parsedOk: false };
  const parts = name.split('_').map((p) => p.trim().toLowerCase());
  const [city, category, objective] = parts;
  return {
    city: city || undefined,
    category: category || undefined,
    objective: objective || undefined,
    parsedOk: parts.length >= 3 && Boolean(city && category && objective),
  };
}

/** Meta returns account-currency major units; Google is cost_micros/1e6. */
export function microsToInr(micros: number | string): number {
  return Number(micros) / 1_000_000;
}

export class CurrencyError extends Error {
  constructor(channel: string, got: string) {
    super(`${channel} account currency is ${got}, expected INR`);
    this.name = 'CurrencyError';
  }
}

export function assertInr(channel: string, currency: string | undefined): void {
  if (currency && currency.toUpperCase() !== 'INR') {
    throw new CurrencyError(channel, currency);
  }
}
