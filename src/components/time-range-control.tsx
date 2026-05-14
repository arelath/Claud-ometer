'use client';

import { useCallback, useId, useMemo } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { CalendarRange } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import {
  getDefaultTimeRangeSelection,
  getTodayDateOnly,
  isDateOnly,
  parseTimeRangeSearchParams,
  TIME_RANGE_OPTIONS,
  toTimeRangeParams,
  writeTimeRangeSearchParams,
  type TimeRangeParams,
  type TimeRangePreset,
  type TimeRangeSelection,
} from '@/lib/time-range';

export function useAnalyticsTimeRange(): {
  value: TimeRangeSelection;
  apiParams: TimeRangeParams;
  setValue: (selection: TimeRangeSelection) => void;
} {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const searchText = searchParams.toString();

  const value = useMemo(() => parseTimeRangeSearchParams(new URLSearchParams(searchText)), [searchText]);
  const apiParams = useMemo(() => toTimeRangeParams(value), [value]);

  const setValue = useCallback((selection: TimeRangeSelection) => {
    const nextSearchParams = new URLSearchParams(searchText);
    writeTimeRangeSearchParams(nextSearchParams, selection);
    const query = nextSearchParams.toString();
    router.replace(`${pathname}${query ? `?${query}` : ''}`, { scroll: false });
  }, [pathname, router, searchText]);

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
