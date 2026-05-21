'use client';

import { useMemo } from 'react';
import {
  Bar, BarChart, CartesianGrid, Legend, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { format, parseISO } from 'date-fns';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { AnalyticsTimeBucket, BucketGranularity, DailyChangeActivity } from '@/lib/claude-data/types';
import { formatNumber } from '@/lib/format';

interface LinesChangedOverTimeProps {
  data: DailyChangeActivity[];
  buckets?: AnalyticsTimeBucket[];
  granularity?: BucketGranularity;
}

interface ChartRow {
  date: string;
  addedLines: number;
  removedLines: number;
  netLineDelta: number;
  changedLines: number;
  fileCount: number;
  editCount: number;
  sessionCount: number;
}

export function LinesChangedOverTime({ data, buckets, granularity = 'day' }: LinesChangedOverTimeProps) {
  const chartData: ChartRow[] = useMemo(() => (
    buckets?.length
      ? buckets.map(bucket => ({
          date: formatBucketLabel(bucket, granularity),
          addedLines: bucket.changeTotals.addedLines,
          removedLines: -bucket.changeTotals.removedLines,
          netLineDelta: bucket.changeTotals.netLineDelta,
          changedLines: bucket.changeTotals.changedLines,
          fileCount: bucket.changeTotals.fileCount,
          editCount: bucket.changeTotals.editCount,
          sessionCount: bucket.activeSessionCount,
        }))
      : data.map(day => ({
          date: format(parseISO(day.date), 'MMM d'),
          addedLines: day.addedLines,
          removedLines: -day.removedLines,
          netLineDelta: day.netLineDelta,
          changedLines: day.changedLines,
          fileCount: day.fileCount,
          editCount: day.editCount,
          sessionCount: day.sessionCount,
        }))
  ), [data, buckets, granularity]);
  const hasTrackedChanges = useMemo(
    () => chartData.some(day => day.changedLines > 0),
    [chartData],
  );

  return (
    <Card className="border-border/50 shadow-sm">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold">Lines Changed Over Time</CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="h-[300px]">
          {hasTrackedChanges ? (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} margin={{ top: 5, right: 5, left: -10, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={(value) => formatSignedLines(Number(value))}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: 'var(--card)',
                    border: '1px solid var(--border)',
                    borderRadius: '8px',
                    fontSize: '12px',
                  }}
                  formatter={(value, name) => formatTooltipValue(Number(value), String(name))}
                  labelFormatter={(label, payload) => {
                    const row = payload?.[0]?.payload as ChartRow | undefined;
                    if (!row) return label;
                    return `${label} - ${formatNumber(row.changedLines)} changed, ${formatNumber(row.fileCount)} files`;
                  }}
                />
                <Legend wrapperStyle={{ fontSize: '11px' }} />
                <ReferenceLine y={0} stroke="var(--border)" />
                <Bar dataKey="addedLines" name="Added" fill="#3fa66b" radius={[4, 4, 0, 0]} isAnimationActive={false} />
                <Bar dataKey="removedLines" name="Removed" fill="#d85a5a" radius={[0, 0, 4, 4]} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              No tracked line changes yet
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function formatBucketLabel(bucket: AnalyticsTimeBucket, granularity: BucketGranularity): string {
  const date = parseISO(bucket.startLocal);
  if (granularity === 'day') return format(date, 'MMM d');
  return format(date, 'MMM d ha');
}

function formatSignedLines(value: number): string {
  if (value === 0) return '0';
  const prefix = value > 0 ? '+' : '-';
  return `${prefix}${formatNumber(Math.abs(value))}`;
}

function formatTooltipValue(value: number, name: string): [string, string] {
  if (name === 'Removed') return [`-${formatNumber(Math.abs(value))}`, name];
  if (name === 'Added') return [`+${formatNumber(Math.abs(value))}`, name];
  return [formatNumber(value), name];
}
