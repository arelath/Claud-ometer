import { describe, expect, it, vi } from 'vitest';
import { formatCost, formatDuration, formatNumber, formatTokens, timeAgo } from '@/lib/format';

describe('format helpers', () => {
  it('formats token counts across thresholds', () => {
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(1_500)).toBe('1.5K');
    expect(formatTokens(2_300_000)).toBe('2.3M');
  });

  it('formats costs with expected precision', () => {
    expect(formatCost(16.742)).toBe('$16.74');
    expect(formatCost(0.0456)).toBe('$0.05');
    expect(formatCost(0.0042)).toBe('$0.0042');
  });

  it('formats plain numbers with locale separators', () => {
    expect(formatNumber(1234567)).toBe('1,234,567');
  });

  it('formats durations into readable strings', () => {
    expect(formatDuration(42_000)).toBe('42s');
    expect(formatDuration(125_000)).toBe('2m 5s');
    expect(formatDuration(4_560_000)).toBe('1h 16m');
  });

  it('formats relative timestamps', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-03T12:00:00.000Z'));

    expect(timeAgo('2026-05-03T11:59:40.000Z')).toBe('just now');
    expect(timeAgo('2026-05-03T11:00:00.000Z')).toBe('1h ago');
    expect(timeAgo('2026-04-20T12:00:00.000Z')).toBe('1w ago');

    vi.useRealTimers();
  });
});
