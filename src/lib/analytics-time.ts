import type { BucketGranularity } from '@/lib/claude-data/types';
import { isDateOnly, type TimeRangeParams, type TimeRangeSelection } from '@/lib/time-range';

export const DEFAULT_BUCKET_GRANULARITY: BucketGranularity = 'day';

export function getAnalyticsGranularity(selection: TimeRangeSelection): BucketGranularity {
  if (selection.preset === '1w') return '4h';
  return DEFAULT_BUCKET_GRANULARITY;
}

export function isBucketGranularity(value: unknown): value is BucketGranularity {
  return value === 'day' || value === '4h' || value === 'hour';
}

export function normalizeBucketGranularity(value: unknown): BucketGranularity {
  return isBucketGranularity(value) ? value : DEFAULT_BUCKET_GRANULARITY;
}

export function getBrowserTimeZone(): string {
  if (typeof Intl === 'undefined') return 'UTC';
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function normalizeTimeZone(value: unknown): string {
  const requested = typeof value === 'string' && value.trim() ? value.trim() : getBrowserTimeZone();
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: requested }).format(new Date());
    return requested;
  } catch {
    return 'UTC';
  }
}

export interface LocalTimeParts {
  date: string;
  hour: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  });
  formatterCache.set(timeZone, formatter);
  return formatter;
}

export function getLocalTimeParts(timestamp: string, timeZone: string): LocalTimeParts | null {
  if (timeZone === 'UTC' && timestamp.length >= 19 && timestamp[10] === 'T') {
    const hour = Number.parseInt(timestamp.slice(11, 13), 10);
    if (Number.isFinite(hour)) {
      return {
        date: timestamp.slice(0, 10),
        hour,
      };
    }
  }

  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return null;

  const parts = getFormatter(timeZone).formatToParts(date);

  const values = new Map(parts.map(part => [part.type, part.value]));
  const year = values.get('year');
  const month = values.get('month');
  const day = values.get('day');
  const hour = Number.parseInt(values.get('hour') || '', 10);
  if (!year || !month || !day || !Number.isFinite(hour)) return null;

  return {
    date: `${year}-${month}-${day}`,
    hour,
  };
}

export function bucketKeyFromLocalTimeParts(
  parts: LocalTimeParts,
  granularity: BucketGranularity,
): string {
  if (granularity === 'day') return parts.date;

  const hour = granularity === '4h'
    ? Math.floor(parts.hour / 4) * 4
    : parts.hour;
  return `${parts.date}T${String(hour).padStart(2, '0')}:00`;
}

export function getBucketKey(
  timestamp: string,
  timeZone: string,
  granularity: BucketGranularity,
): string | null {
  const parts = getLocalTimeParts(timestamp, timeZone);
  if (!parts) return null;
  return bucketKeyFromLocalTimeParts(parts, granularity);
}

export function getEventLocalDate(timestamp: string, timeZone: string): string | null {
  return getLocalTimeParts(timestamp, timeZone)?.date ?? null;
}

export function isDateInRange(date: string, range: TimeRangeParams): boolean {
  if (!isDateOnly(date)) return false;
  if (range.start && date < range.start) return false;
  if (range.end && date > range.end) return false;
  return true;
}

export function isTimestampInLocalDateRange(timestamp: string, timeZone: string, range: TimeRangeParams): boolean {
  const localDate = getEventLocalDate(timestamp, timeZone);
  return Boolean(localDate && isDateInRange(localDate, range));
}

export function listBucketKeys(range: TimeRangeParams, granularity: BucketGranularity): string[] {
  if (!range.start || !range.end) return [];

  const keys: string[] = [];
  for (let cursor = parseDateOnly(range.start); formatDateOnly(cursor) <= range.end; cursor = addDays(cursor, 1)) {
    const date = formatDateOnly(cursor);
    if (granularity === 'day') {
      keys.push(date);
      continue;
    }

    const step = granularity === '4h' ? 4 : 1;
    for (let hour = 0; hour < 24; hour += step) {
      keys.push(`${date}T${String(hour).padStart(2, '0')}:00`);
    }
  }

  return keys;
}

export function bucketKeyToDate(key: string): string {
  return key.slice(0, 10);
}

function parseDateOnly(value: string): Date {
  const [year, month, day] = value.split('-').map(part => Number.parseInt(part, 10));
  return new Date(year, month - 1, day);
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function formatDateOnly(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
