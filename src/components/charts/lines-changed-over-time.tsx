'use client';

import { useMemo } from 'react';
import {
  Bar, BarChart, CartesianGrid, ComposedChart, Legend, Line, ReferenceLine, ResponsiveContainer,
  Tooltip, usePlotArea, XAxis, YAxis, type CurveProps,
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

// A dense history needs just two SVG paths. Recharts supplies the scaled
// points and keeps its usual axes, legend, keyboard navigation and tooltips.
function ChangeBarSeries({ points, stroke, domain, removed }: Pick<CurveProps, 'points' | 'stroke'> & {
  domain: [number, number];
  removed?: boolean;
}) {
  const plot = usePlotArea();
  if (!plot || !points?.length || domain[1] === domain[0]) return null;
  const baseline = plot.y + plot.height * domain[1] / (domain[1] - domain[0]);
  const barWidth = plot.width / points.length * 0.4;
  const path = points.map(({ x, y }) => x === null || y === null ? '' :
    `M${removed ? x : x - barWidth},${baseline}V${y}h${barWidth}V${baseline}Z`,
  ).join('');
  return <path d={path} fill={stroke} />;
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
  const dense = chartData.length > 64;
  const Chart = dense ? ComposedChart : BarChart;
  const domain = useMemo(() => chartData.reduce<[number, number]>((bounds, row) => [
    Math.min(bounds[0], row.removedLines), Math.max(bounds[1], row.addedLines),
  ], [0, 0]), [chartData]);

  return (
    <Card className="border-border/50 shadow-sm">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold">Lines Changed Over Time</CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="h-[300px]">
          {hasTrackedChanges ? (
            <ResponsiveContainer width="100%" height="100%">
              <Chart data={chartData} margin={{ top: 5, right: 5, left: -10, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                <XAxis
                  scale={dense ? 'band' : 'auto'}
                  dataKey="date"
                  tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  domain={dense ? domain : undefined}
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
                {dense ? (
                  <>
                    <Line dataKey="addedLines" name="Added" stroke="#3fa66b" legendType="rect" shape={<ChangeBarSeries domain={domain} />} dot={false} activeDot={false} isAnimationActive={false} />
                    <Line dataKey="removedLines" name="Removed" stroke="#d85a5a" legendType="rect" shape={<ChangeBarSeries domain={domain} removed />} dot={false} activeDot={false} isAnimationActive={false} />
                  </>
                ) : (
                  <>
                    <Bar dataKey="addedLines" name="Added" fill="#3fa66b" radius={[4, 4, 0, 0]} isAnimationActive={false} />
                    <Bar dataKey="removedLines" name="Removed" fill="#d85a5a" radius={[0, 0, 4, 4]} isAnimationActive={false} />
                  </>
                )}
              </Chart>
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
