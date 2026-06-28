import { describe, it, expect } from 'vitest';
import { rollingWindow } from '../src/marketing/jobs/ingest.js';

describe('rollingWindow', () => {
  it('returns an inclusive N-day window ending today', () => {
    const now = new Date('2026-06-28T10:00:00Z');
    expect(rollingWindow(8, now)).toEqual({ since: '2026-06-21', until: '2026-06-28' });
  });
  it('defaults to 8 days', () => {
    const now = new Date('2026-01-10T00:00:00Z');
    expect(rollingWindow(undefined, now)).toEqual({ since: '2026-01-03', until: '2026-01-10' });
  });
});
