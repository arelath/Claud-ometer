import { describe, expect, it } from 'vitest';
import {
  filterByTimeRange,
  getDefaultTimeRangeSelection,
  parseApiTimeRangeParams,
} from '@/lib/time-range';

describe('analytics time ranges', () => {
  it('builds rolling preset defaults from a base date', () => {
    const baseDate = new Date(2026, 4, 12);

    expect(getDefaultTimeRangeSelection('all', baseDate)).toEqual({ preset: 'all' });
    expect(getDefaultTimeRangeSelection('1m', baseDate)).toEqual({
      preset: '1m',
      start: '2026-04-12',
      end: '2026-05-12',
    });
    expect(getDefaultTimeRangeSelection('1w', baseDate)).toEqual({
      preset: '1w',
      start: '2026-05-06',
      end: '2026-05-12',
    });
  });

  it('filters items by inclusive date-only bounds', () => {
    const items = [
      { createdAt: '2026-05-07T23:00:00.000Z' },
      { createdAt: '2026-05-08T10:00:00.000Z' },
      { createdAt: '2026-05-09T01:00:00.000Z' },
    ];

    expect(filterByTimeRange(items, {
      start: '2026-05-08',
      end: '2026-05-08',
    }, item => item.createdAt)).toEqual([
      { createdAt: '2026-05-08T10:00:00.000Z' },
    ]);
  });

  it('validates API date parameters', () => {
    expect(parseApiTimeRangeParams(new URLSearchParams('start=2026-05-01&end=2026-05-31'))).toEqual({
      range: { start: '2026-05-01', end: '2026-05-31' },
    });
    expect(parseApiTimeRangeParams(new URLSearchParams('start=2026-05-31&end=2026-05-01')).error).toBe('Start date must be before or equal to end date');
    expect(parseApiTimeRangeParams(new URLSearchParams('start=bad-date')).error).toBe('Invalid start date');
  });
});
