'use client';

import { useMemo } from 'react';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
  ComposedChart, Curve, DefaultLegendContent, DefaultTooltipContent, Line, usePlotArea,
} from 'recharts';
import type { CurveProps, TooltipContentProps } from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { AnalyticsTimeBucket, BucketGranularity, DailyModelTokens } from '@/lib/claude-data/types';
import { getModelCostDisplayName, getModelCostGroupKey, getModelColor } from '@/config/pricing';
import { useCostMode } from '@/lib/cost-mode-context';
import { format, parseISO } from 'date-fns';

interface CostChartProps {
  data: DailyModelTokens[];
  buckets?: AnalyticsTimeBucket[];
  granularity?: BucketGranularity;
}

interface ModelCostGroup {
  key: string;
  name: string;
  color: string;
}

const stackTotal = Symbol('stackTotal');
type CostRow = Record<string, string | number> & { [stackTotal]: number };
const readStackTotal = (row: CostRow) => row[stackTotal];

// Scale the column totals once. Each band uses the same interpolation as the
// individual Area series, without registering a chart controller per model.
function CostBands({ points, rows, groups }: Pick<CurveProps, 'points'> & {
  rows: CostRow[]; groups: ModelCostGroup[];
}) {
  const plot = usePlotArea();
  if (!plot || points?.length !== rows.length) return null;
  const zero = plot.y + plot.height;
  let lower = points.map(point => ({ x: point.x ?? 0, y: zero }));
  const scales = points.map((point, i) => rows[i][stackTotal] ? (zero - (point.y ?? zero)) / rows[i][stackTotal] : 0);
  const bands = [];
  for (const group of groups) {
    const baseline = lower;
    lower = baseline.map(({ x, y }, i) => ({ x, y: y - Number(rows[i][group.name]) * scales[i] }));
    bands.push(
      <g key={group.key}>
        <Curve className="recharts-area-area" type="monotone" layout="horizontal" points={lower} baseLine={baseline} fill={group.color} fillOpacity={0.3} stroke="none" />
        <Curve type="monotone" layout="horizontal" points={lower} stroke={group.color} strokeWidth={2} fill="none" />
      </g>
    );
  }
  return bands;
}

function CostTooltipContent({ active, payload, ...props }: TooltipContentProps<number, string>) {
  const nonZeroPayload = payload.filter(entry => Number(entry.value) !== 0);
  if (!active || nonZeroPayload.length === 0) return null;

  return (
    <DefaultTooltipContent
      {...props}
      payload={nonZeroPayload}
      formatter={(value, name) => [`$${Number(value).toFixed(2)}`, name ?? '']}
    />
  );
}

export function CostChart({ data, buckets, granularity = 'day' }: CostChartProps) {
  const { costMode } = useCostMode();

  const { chartData, groups } = useMemo(() => {
    const modelGroups = new Map<string, ModelCostGroup>();
    const ensureModelGroup = (model: string): ModelCostGroup => {
      const key = getModelCostGroupKey(model);
      const existing = modelGroups.get(key);
      if (existing) return existing;

      const group = {
        key,
        name: getModelCostDisplayName(model),
        color: getModelColor(key),
      };
      modelGroups.set(key, group);
      return group;
    };

    const sourceRows = buckets?.length
      ? buckets.map(bucket => ({
          label: formatBucketLabel(bucket, granularity),
          tokensByModel: bucket.tokensByModel,
          costsByModel: bucket.costsByModel,
        }))
      : data.map(day => ({
          label: format(parseISO(day.date), 'MMM d'),
          tokensByModel: day.tokensByModel,
          costsByModel: day.costsByModel || {},
        }));

    sourceRows.forEach(d => {
      Object.entries(d.tokensByModel).forEach(([model, tokens]) => {
        if (tokens > 0 || (d.costsByModel?.[model]?.[costMode] ?? 0) > 0) ensureModelGroup(model);
      });
    });

    const parsedData = sourceRows.map(d => {
      const entry: CostRow = {
        date: d.label, [stackTotal]: 0,
      };
      const costsByGroup: Record<string, number> = {};

      for (const [model, tokens] of Object.entries(d.tokensByModel)) {
        if (tokens <= 0 && (d.costsByModel?.[model]?.[costMode] ?? 0) <= 0) continue;
        const group = ensureModelGroup(model);
        const costs = d.costsByModel?.[model];
        costsByGroup[group.name] = (costsByGroup[group.name] || 0) + (costs?.[costMode] ?? 0);
      }

      for (const group of modelGroups.values()) {
        const cost = parseFloat((costsByGroup[group.name] || 0).toFixed(2));
        entry[group.name] = cost;
        entry[stackTotal] += cost;
      }

      return entry;
    });

    return { chartData: parsedData, groups: Array.from(modelGroups.values()) };
  }, [data, buckets, granularity, costMode]);
  const dense = chartData.length > 1 && chartData.length * groups.length > 1500;
  const Chart = dense ? ComposedChart : AreaChart;

  return (
    <Card className="border-border/50 shadow-sm">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold">Usage Cost Over Time</CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="h-[300px]">
          <ResponsiveContainer width="100%" height="100%">
            <Chart data={chartData} margin={{ top: 5, right: 5, left: -10, bottom: 0 }}>
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
                tickFormatter={(v) => `$${v}`}
              />
              <Tooltip<number, string>
                content={dense ? props => {
                  const row = chartData[Number(props.activeIndex)];
                  const payload = row ? groups.map(group => ({ name: group.name, value: Number(row[group.name]), color: group.color })) : [];
                  return <CostTooltipContent {...props} payload={payload} />;
                } : CostTooltipContent}
                contentStyle={{
                  backgroundColor: 'var(--card)',
                  border: '1px solid var(--border)',
                  borderRadius: '8px',
                  fontSize: '12px',
                }}
              />
              <Legend
                wrapperStyle={{ fontSize: '11px' }}
                content={dense ? () => <DefaultLegendContent align="center" payload={groups.map(group => ({
                  value: group.name, color: group.color, type: 'rect',
                }))} /> : undefined}
              />
              {dense ? (
                <Line dataKey={readStackTotal} name="Total" dot={false} activeDot={false} isAnimationActive={false}
                  shape={<CostBands rows={chartData} groups={groups} />} />
              ) : groups.map(group => (
                <Area
                  key={group.key}
                  type="monotone"
                  dataKey={group.name}
                  stackId="1"
                  stroke={group.color}
                  fill={group.color}
                  fillOpacity={0.3}
                  strokeWidth={2}
                  isAnimationActive={false}
                />
              ))}
            </Chart>
          </ResponsiveContainer>
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
