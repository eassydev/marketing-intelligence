import { describe, it, expect } from 'vitest';
import { partitionSpecFor, retainedMonthSuffixes } from '../src/marketing/jobs/event-partitions.js';

describe('partitionSpecFor', () => {
  it('builds the current-month spec with IST bounds', () => {
    expect(partitionSpecFor(2026, 7, 0)).toEqual({
      name: 'app_event_2026_07',
      from: '2026-07-01 00:00:00+05:30',
      to: '2026-08-01 00:00:00+05:30',
    });
  });

  it('rolls the year over on a December→January offset', () => {
    expect(partitionSpecFor(2026, 12, 1)).toEqual({
      name: 'app_event_2027_01',
      from: '2027-01-01 00:00:00+05:30',
      to: '2027-02-01 00:00:00+05:30',
    });
  });

  it('handles multi-month offsets crossing a year boundary', () => {
    // Nov 2026 + 3 = Feb 2027
    expect(partitionSpecFor(2026, 11, 3).name).toBe('app_event_2027_02');
  });

  it('handles negative offsets (retention lookback)', () => {
    // Jan 2026 - 1 = Dec 2025
    expect(partitionSpecFor(2026, 1, -1).name).toBe('app_event_2025_12');
  });
});

describe('retainedMonthSuffixes', () => {
  it('retains [now-(N-1) .. now+2] inclusive', () => {
    const now = new Date('2026-07-15T00:00:00Z');
    const s = retainedMonthSuffixes(now, 13);
    // Oldest retained = 12 months back from July 2026 = July 2025.
    expect(s.has('app_event_2025_07')).toBe(true);
    // A month older is a drop candidate.
    expect(s.has('app_event_2025_06')).toBe(false);
    // Two months ahead pre-created.
    expect(s.has('app_event_2026_09')).toBe(true);
    // Three months ahead not in the retained set (not created by this job run).
    expect(s.has('app_event_2026_10')).toBe(false);
    // Count = (N-1) back + current + 2 ahead = 13 + 2 = 15.
    expect(s.size).toBe(15);
  });
});
