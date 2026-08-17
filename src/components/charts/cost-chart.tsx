'use client';

import { useMemo } from 'react';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
  DefaultTooltipContent,
} from 'recharts';
import type { TooltipContentProps } from 'recharts';
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
        if (tokens > 0) ensureModelGroup(model);
      });
    });

    const parsedData = sourceRows.map(d => {
      const entry: Record<string, string | number> = {
        date: d.label,
      };
      const costsByGroup: Record<string, number> = {};

      for (const [model, tokens] of Object.entries(d.tokensByModel)) {
        if (tokens <= 0) continue;
        const group = ensureModelGroup(model);
        const costs = d.costsByModel?.[model];
        costsByGroup[group.name] = (costsByGroup[group.name] || 0) + (costs?.[costMode] ?? 0);
      }

      for (const group of modelGroups.values()) {
        entry[group.name] = parseFloat((costsByGroup[group.name] || 0).toFixed(2));
      }

      return entry;
    });

    return { chartData: parsedData, groups: Array.from(modelGroups.values()) };
  }, [data, buckets, granularity, costMode]);

  return (
    <Card className="border-border/50 shadow-sm">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold">Estimated Usage Over Time</CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="h-[300px]">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData} margin={{ top: 5, right: 5, left: -10, bottom: 0 }}>
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
              <Tooltip
                content={CostTooltipContent}
                contentStyle={{
                  backgroundColor: 'var(--card)',
                  border: '1px solid var(--border)',
                  borderRadius: '8px',
                  fontSize: '12px',
                }}
              />
              <Legend
                wrapperStyle={{ fontSize: '11px' }}
              />
              {groups.map(group => (
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
            </AreaChart>
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
