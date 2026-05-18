import { describe, expect, it } from 'vitest';
import {
  getBucketKey,
  getLocalTimeParts,
  listBucketKeys,
} from '@/lib/analytics-time';

describe('analytics local time buckets', () => {
  it('uses the requested local date instead of the UTC date', () => {
    const timestamp = '2026-05-08T06:30:00.000Z';

    expect(getLocalTimeParts(timestamp, 'America/Los_Angeles')).toEqual({
      date: '2026-05-07',
      hour: 23,
    });
    expect(getLocalTimeParts(timestamp, 'UTC')).toEqual({
      date: '2026-05-08',
      hour: 6,
    });
  });

  it('builds local four-hour bucket keys', () => {
    expect(getBucketKey('2026-05-08T15:30:00.000Z', 'America/Los_Angeles', '4h')).toBe('2026-05-08T08:00');
  });

  it('zero-fills one-week four-hour ranges', () => {
    const keys = listBucketKeys({ start: '2026-05-01', end: '2026-05-07' }, '4h');

    expect(keys).toHaveLength(42);
    expect(keys[0]).toBe('2026-05-01T00:00');
    expect(keys.at(-1)).toBe('2026-05-07T20:00');
  });
});
