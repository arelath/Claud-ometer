export type TimeRangePreset = 'all' | '1y' | '6m' | '3m' | '1m' | '1w';

export interface TimeRangeSelection {
  preset: TimeRangePreset;
  start?: string;
  end?: string;
}

export interface TimeRangeParams {
  start?: string;
  end?: string;
}

export const TIME_RANGE_OPTIONS: Array<{ value: TimeRangePreset; label: string }> = [
  { value: 'all', label: 'All history' },
  { value: '1y', label: '1 year' },
  { value: '6m', label: '6 months' },
  { value: '3m', label: '3 months' },
  { value: '1m', label: '1 month' },
  { value: '1w', label: '1 week' },
];

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RANGE_PRESETS = new Set<TimeRangePreset>(TIME_RANGE_OPTIONS.map(option => option.value));

export function isTimeRangePreset(value: unknown): value is TimeRangePreset {
  return typeof value === 'string' && TIME_RANGE_PRESETS.has(value as TimeRangePreset);
}

export function isDateOnly(value: unknown): value is string {
  return typeof value === 'string' && DATE_ONLY_PATTERN.test(value);
}

export function getTodayDateOnly(baseDate = new Date()): string {
  return formatDateOnly(baseDate);
}

export function getDefaultTimeRangeSelection(preset: TimeRangePreset, baseDate = new Date()): TimeRangeSelection {
  if (preset === 'all') return { preset };

  const end = formatDateOnly(baseDate);
  const startDate = (() => {
    if (preset === '1y') return shiftMonths(baseDate, -12);
    if (preset === '6m') return shiftMonths(baseDate, -6);
    if (preset === '3m') return shiftMonths(baseDate, -3);
    if (preset === '1m') return shiftMonths(baseDate, -1);
    return shiftDays(baseDate, -6);
  })();

  return {
    preset,
    start: formatDateOnly(startDate),
    end,
  };
}

export function shiftTimeRangeSelection(
  selection: TimeRangeSelection,
  direction: -1 | 1,
  baseDate = new Date(),
): TimeRangeSelection {
  const normalized = normalizeTimeRangeSelection(selection, baseDate);
  if (normalized.preset === 'all') return normalized;

  const startDate = parseDateOnly(normalized.start!);
  const endDate = parseDateOnly(normalized.end!);
  const shiftedStart = shiftDateByPreset(startDate, normalized.preset, direction);
  const shiftedEnd = shiftDateByPreset(endDate, normalized.preset, direction);

  if (direction > 0 && formatDateOnly(shiftedEnd) > getTodayDateOnly(baseDate)) {
    return getDefaultTimeRangeSelection(normalized.preset, baseDate);
  }

  return {
    preset: normalized.preset,
    start: formatDateOnly(shiftedStart),
    end: formatDateOnly(shiftedEnd),
  };
}

export function canShiftTimeRangeForward(selection: TimeRangeSelection, baseDate = new Date()): boolean {
  const normalized = normalizeTimeRangeSelection(selection, baseDate);
  return normalized.preset !== 'all' && Boolean(normalized.end && normalized.end < getTodayDateOnly(baseDate));
}

export function normalizeTimeRangeSelection(
  selection: Partial<TimeRangeSelection> | undefined,
  baseDate = new Date(),
): TimeRangeSelection {
  const requestedPreset = selection?.preset;
  const preset = isTimeRangePreset(requestedPreset) ? requestedPreset : 'all';
  if (preset === 'all') return { preset };

  const defaults = getDefaultTimeRangeSelection(preset, baseDate);
  const start = isDateOnly(selection?.start) ? selection.start : defaults.start!;
  let end = isDateOnly(selection?.end) ? selection.end : defaults.end!;

  if (start > end) {
    end = start;
  }

  return { preset, start, end };
}

export function parseTimeRangeSearchParams(searchParams: URLSearchParams, baseDate = new Date()): TimeRangeSelection {
  const preset = searchParams.get('range');
  return normalizeTimeRangeSelection({
    preset: isTimeRangePreset(preset) ? preset : undefined,
    start: searchParams.get('start') || undefined,
    end: searchParams.get('end') || undefined,
  }, baseDate);
}

export function writeTimeRangeSearchParams(searchParams: URLSearchParams, selection: TimeRangeSelection): void {
  searchParams.set('range', selection.preset);

  if (selection.preset === 'all') {
    searchParams.delete('start');
    searchParams.delete('end');
    return;
  }

  if (selection.start) searchParams.set('start', selection.start);
  else searchParams.delete('start');
  if (selection.end) searchParams.set('end', selection.end);
  else searchParams.delete('end');
}

export function toTimeRangeParams(selection: TimeRangeSelection): TimeRangeParams {
  if (selection.preset === 'all') return {};
  return {
    start: selection.start,
    end: selection.end,
  };
}

export function buildTimeRangeQuery(params?: TimeRangeParams): string {
  const query = new URLSearchParams();
  if (params?.start) query.set('start', params.start);
  if (params?.end) query.set('end', params.end);
  const text = query.toString();
  return text ? `?${text}` : '';
}

export function parseApiTimeRangeParams(searchParams: URLSearchParams): { range: TimeRangeParams; error?: string } {
  const start = searchParams.get('start') || undefined;
  const end = searchParams.get('end') || undefined;

  if (start && !isDateOnly(start)) return { range: {}, error: 'Invalid start date' };
  if (end && !isDateOnly(end)) return { range: {}, error: 'Invalid end date' };
  if (start && end && start > end) return { range: {}, error: 'Start date must be before or equal to end date' };

  return { range: { start, end } };
}

export function filterByTimeRange<T>(
  items: T[],
  range: TimeRangeParams,
  getTimestamp: (item: T) => string,
): T[] {
  if (!range.start && !range.end) return items;

  return items.filter((item) => {
    const date = getTimestamp(item).slice(0, 10);
    if (!isDateOnly(date)) return false;
    if (range.start && date < range.start) return false;
    if (range.end && date > range.end) return false;
    return true;
  });
}

function formatDateOnly(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function shiftMonths(date: Date, months: number): Date {
  const shiftedMonthStart = new Date(date.getFullYear(), date.getMonth() + months, 1);
  const lastDayOfTargetMonth = new Date(
    shiftedMonthStart.getFullYear(),
    shiftedMonthStart.getMonth() + 1,
    0,
  ).getDate();
  shiftedMonthStart.setDate(Math.min(date.getDate(), lastDayOfTargetMonth));
  return shiftedMonthStart;
}

function shiftDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function parseDateOnly(value: string): Date {
  const [year, month, day] = value.split('-').map(part => Number.parseInt(part, 10));
  return new Date(year, month - 1, day);
}

function shiftDateByPreset(date: Date, preset: Exclude<TimeRangePreset, 'all'>, direction: -1 | 1): Date {
  if (preset === '1y') return shiftMonths(date, 12 * direction);
  if (preset === '6m') return shiftMonths(date, 6 * direction);
  if (preset === '3m') return shiftMonths(date, 3 * direction);
  if (preset === '1m') return shiftMonths(date, direction);
  return shiftDays(date, 7 * direction);
}
