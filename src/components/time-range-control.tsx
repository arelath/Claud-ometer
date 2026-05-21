'use client';

import { useCallback, useEffect, useId, useMemo } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { CalendarRange, ChevronLeft, ChevronRight } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { getAnalyticsGranularity, getBrowserTimeZone } from '@/lib/analytics-time';
import { cn } from '@/lib/utils';
import {
  canShiftTimeRangeForward,
  getDefaultTimeRangeSelection,
  getTodayDateOnly,
  isDateOnly,
  normalizeTimeRangeSelection,
  parseTimeRangeSearchParams,
  shiftTimeRangeSelection,
  TIME_RANGE_OPTIONS,
  toTimeRangeParams,
  writeTimeRangeSearchParams,
  type TimeRangeParams,
  type TimeRangePreset,
  type TimeRangeSelection,
} from '@/lib/time-range';

const TIME_RANGE_STORAGE_KEY = 'agentscope.analyticsTimeRange';

export function useAnalyticsTimeRange(): {
  value: TimeRangeSelection;
  apiParams: TimeRangeParams;
  setValue: (selection: TimeRangeSelection) => void;
} {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const searchText = searchParams.toString();

  const value = useMemo(() => {
    const currentSearchParams = new URLSearchParams(searchText);
    if (currentSearchParams.has('range')) {
      return parseTimeRangeSearchParams(currentSearchParams);
    }
    return readStoredTimeRangeSelection() ?? parseTimeRangeSearchParams(currentSearchParams);
  }, [searchText]);
  const apiParams = useMemo(() => ({
    ...toTimeRangeParams(value),
    timeZone: getBrowserTimeZone(),
    granularity: getAnalyticsGranularity(value),
  }), [value]);

  const setValue = useCallback((selection: TimeRangeSelection) => {
    const normalized = normalizeTimeRangeSelection(selection);
    writeStoredTimeRangeSelection(normalized);
    const nextSearchParams = new URLSearchParams(searchText);
    writeTimeRangeSearchParams(nextSearchParams, normalized);
    nextSearchParams.delete('page');
    const query = nextSearchParams.toString();
    router.replace(`${pathname}${query ? `?${query}` : ''}`, { scroll: false });
  }, [pathname, router, searchText]);

  useEffect(() => {
    writeStoredTimeRangeSelection(value);
  }, [value]);

  return { value, apiParams, setValue };
}

interface TimeRangeControlProps {
  value: TimeRangeSelection;
  onChange: (selection: TimeRangeSelection) => void;
  className?: string;
}

export function TimeRangeControl({ value, onChange, className }: TimeRangeControlProps) {
  const id = useId();
  const today = getTodayDateOnly();
  const isAllHistory = value.preset === 'all';
  const canGoForward = canShiftTimeRangeForward(value);

  const updatePreset = (preset: string) => {
    onChange(getDefaultTimeRangeSelection(preset as TimeRangePreset));
  };

  const updateStart = (nextStart: string) => {
    if (!isDateOnly(nextStart) || isAllHistory) return;
    onChange({
      ...value,
      start: nextStart,
      end: value.end && nextStart > value.end ? nextStart : value.end,
    });
  };

  const updateEnd = (nextEnd: string) => {
    if (!isDateOnly(nextEnd) || isAllHistory) return;
    onChange({
      ...value,
      start: value.start && nextEnd < value.start ? nextEnd : value.start,
      end: nextEnd,
    });
  };

  const shiftRange = (direction: -1 | 1) => {
    onChange(shiftTimeRangeSelection(value, direction));
  };

  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      <div className="flex items-center gap-1.5">
        <CalendarRange className="h-4 w-4 text-muted-foreground" />
        <Select value={value.preset} onValueChange={updatePreset}>
          <SelectTrigger aria-label="Time range" size="sm" className="h-8 min-w-[8.5rem] bg-card text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="end">
            {TIME_RANGE_OPTIONS.map(option => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {!isAllHistory && (
          <div className="flex items-center rounded-md border border-border/60 bg-card shadow-xs">
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label="Previous time range"
                  onClick={() => shiftRange(-1)}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-l-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent>Previous time range</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label="Next time range"
                  onClick={() => shiftRange(1)}
                  disabled={!canGoForward}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-r-md border-l border-border/60 text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-45"
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent>Next time range</TooltipContent>
            </Tooltip>
          </div>
        )}
      </div>

      {!isAllHistory && (
        <div className="flex flex-wrap items-center gap-1.5 rounded-lg bg-muted/50 p-0.5">
          <label htmlFor={`${id}-start`} className="px-1 text-[11px] font-medium text-muted-foreground">
            Start
          </label>
          <input
            id={`${id}-start`}
            type="date"
            value={value.start || ''}
            max={value.end || today}
            onChange={event => updateStart(event.target.value)}
            className="h-8 w-[8.75rem] rounded-md border border-input bg-background px-2 text-xs shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
          />
          <label htmlFor={`${id}-end`} className="px-1 text-[11px] font-medium text-muted-foreground">
            End
          </label>
          <input
            id={`${id}-end`}
            type="date"
            value={value.end || ''}
            min={value.start}
            max={today}
            onChange={event => updateEnd(event.target.value)}
            className="h-8 w-[8.75rem] rounded-md border border-input bg-background px-2 text-xs shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
          />
        </div>
      )}
    </div>
  );
}

function readStoredTimeRangeSelection(): TimeRangeSelection | undefined {
  if (typeof window === 'undefined') return undefined;

  try {
    const stored = window.localStorage.getItem(TIME_RANGE_STORAGE_KEY);
    if (!stored) return undefined;
    return normalizeTimeRangeSelection(JSON.parse(stored) as Partial<TimeRangeSelection>);
  } catch {
    return undefined;
  }
}

function writeStoredTimeRangeSelection(selection: TimeRangeSelection): void {
  if (typeof window === 'undefined') return;

  try {
    window.localStorage.setItem(TIME_RANGE_STORAGE_KEY, JSON.stringify(selection));
  } catch {
    // Storage can be unavailable in restricted browser contexts; URL state still works.
  }
}
