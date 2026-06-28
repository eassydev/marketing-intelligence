import { describe, it, expect } from 'vitest';
import {
  parseEntityName,
  microsToInr,
  assertInr,
  CurrencyError,
} from '../src/marketing/ingest/normalize.js';

describe('parseEntityName', () => {
  it('parses {city}_{category}_{objective}', () => {
    expect(parseEntityName('Mumbai_Home_Cleaning_Purchase')).toMatchObject({
      city: 'mumbai',
      category: 'home',
      objective: 'cleaning',
      parsedOk: true,
    });
  });
  it('parses a clean three-part name', () => {
    expect(parseEntityName('mumbai_homecleaning_purchase')).toEqual({
      city: 'mumbai',
      category: 'homecleaning',
      objective: 'purchase',
      parsedOk: true,
    });
  });
  it('flags an unparseable name', () => {
    expect(parseEntityName('BrandAwareness').parsedOk).toBe(false);
  });
  it('handles undefined', () => {
    expect(parseEntityName(undefined).parsedOk).toBe(false);
  });
});

describe('microsToInr', () => {
  it('divides micros by 1e6', () => {
    expect(microsToInr(2_000_000)).toBe(2);
    expect(microsToInr('1500000')).toBe(1.5);
  });
});

describe('assertInr', () => {
  it('passes for INR or undefined', () => {
    expect(() => assertInr('meta', 'INR')).not.toThrow();
    expect(() => assertInr('meta', undefined)).not.toThrow();
  });
  it('throws CurrencyError for non-INR', () => {
    expect(() => assertInr('meta', 'USD')).toThrow(CurrencyError);
  });
});
