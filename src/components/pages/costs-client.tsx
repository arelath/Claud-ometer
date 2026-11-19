'use client';

import { lazy, memo, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { useCacheStatus, useStats } from '@/lib/hooks';
import type { DashboardStats, ProjectInfo } from '@/lib/claude-data/types';
import { useCostMode } from '@/lib/cost-mode-context';
import type { TimeRangeParams } from '@/lib/time-range';
import { CostModeSelector } from '@/components/cost-mode-selector';
import { StatCard } from '@/components/cards/stat-card';
import { formatCost, formatNumber, formatTokens } from '@/lib/format';
import {
  calculateCacheSavings,
  getModelCostDisplayName,
  getModelCostGroupKey,
  getModelColor,
  getPricingReferenceEntries,
  LITELLM_PRICING_SOURCE,
  OPENAI_PRICING_SOURCE,
} from '@/config/pricing';
import { Coins, TrendingUp, Zap, Database, Info, GitPullRequest } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CacheRefreshStatus } from '@/components/cache-refresh-status';
import { Separator } from '@/components/ui/separator';
import { TimeRangeControl, useAnalyticsTimeRange } from '@/components/time-range-control';

const CostChart = lazy(() => import('@/components/charts/cost-chart').then(module => ({ default: module.CostChart })));
const LinesChangedOverTime = lazy(() => import('@/components/charts/lines-changed-over-time').then(module => ({ default: module.LinesChangedOverTime })));
const ProjectCostChart = lazy(() => import('@/components/charts/project-cost-chart'));

function ChartSection({ title, children }: { title: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        setVisible(true);
        observer.disconnect();
      }
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const placeholder = (
    <Card aria-busy="true" className="border-border/50 shadow-sm">
      <CardHeader className="pb-2"><CardTitle className="text-sm font-semibold">{title}</CardTitle></CardHeader>
      <CardContent className="pt-0"><div className="h-[300px]" /></CardContent>
    </Card>
  );
  return (
    <div ref={ref}>
      <Suspense fallback={placeholder}>
        {visible || typeof IntersectionObserver === 'undefined' ? children : placeholder}
      </Suspense>
    </div>
  );
}

export function CostsClient({ initialStats, initialProjects }: { initialStats?: DashboardStats; initialProjects?: ProjectInfo[] }) {
  const timeRange = useAnalyticsTimeRange();
  const { data: stats, mutate, error } = useStats(initialStats, timeRange.apiParams);
  const { data: cacheStatus } = useCacheStatus(mutate);
  const { costMode, label: modeLabel } = useCostMode();

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Cost Analytics</h1>
          <p className="text-sm text-muted-foreground">Usage estimates and recorded credits — not actual billing</p>
        </div>
        <div className="flex flex-wrap items-center gap-2 md:justify-end">
          <TimeRangeControl value={timeRange.value} onChange={timeRange.setValue} />
          <CostModeSelector />
        </div>
      </div>
      <CacheRefreshStatus status={cacheStatus} />

      {/* Mode explainer */}
      <div className="flex items-start gap-2 rounded-lg border border-border/50 bg-muted/30 px-4 py-3">
        <Info className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
        <div className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{modeLabel.name}:</span>{' '}
          {modeLabel.description}.{' '}
          Recorded Copilot credit values stay the same across estimation modes.{' '}
          {costMode === 'api' && 'This shows what your usage would cost at published API rates — typically 5-8x higher than subscription billing.'}
          {costMode === 'conservative' && 'Cache tokens are discounted but not eliminated. This is an upper-bound estimate for subscription users.'}
          {costMode === 'subscription' && 'Cache tokens are heavily discounted to approximate subscription-style CLI billing where cache reads are not charged like fresh input tokens.'}
        </div>
      </div>

      {stats ? (
        <CostResults stats={stats} initialProjects={initialProjects} range={timeRange.apiParams} />
      ) : (
        <p role="status" className="text-sm text-muted-foreground">{error ? 'Could not load cost data.' : 'Loading cost data...'}</p>
      )}
    </div>
  );
}

const CostResults = memo(function CostResults({ stats, initialProjects, range }: {
  stats: DashboardStats; initialProjects?: ProjectInfo[]; range: TimeRangeParams;
}) {
  const { costMode, pickCost, label: modeLabel } = useCostMode();
  // Calculate cache savings
  let totalCacheReadTokens = 0;
  let totalCacheWriteTokens = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  Object.entries(stats.modelUsage).forEach(([, usage]) => {
    totalCacheReadTokens += usage.cacheReadInputTokens;
    totalCacheWriteTokens += usage.cacheCreationInputTokens;
    totalInputTokens += usage.inputTokens;
    totalOutputTokens += usage.outputTokens;
  });

  // Estimated savings on the same pricing basis as the selected usage total.
  let cacheSavings = 0;
  Object.entries(stats.modelUsage).forEach(([model, usage]) => {
    cacheSavings += calculateCacheSavings(model, usage.cacheReadInputTokens, costMode);
  });

  const totalCost = pickCost(stats.estimatedCosts, stats.estimatedCost);
  const totalPromptInputTokens = totalInputTokens + totalCacheReadTokens;
  const changeTotals = stats.changeTotals;

  // Model cost breakdown
  const modelCostGroups = new Map<string, {
    name: string;
    model: string;
    tokens: number;
    cost: number;
    color: string;
    inputTokens: number;
    outputTokens: number;
    cacheRead: number;
    cacheWrite: number;
  }>();

  Object.entries(stats.modelUsage).forEach(([model, usage]) => {
    const groupKey = getModelCostGroupKey(model);
    const group = modelCostGroups.get(groupKey) || {
      name: getModelCostDisplayName(model),
      model: groupKey,
      tokens: 0,
      cost: 0,
      color: getModelColor(groupKey),
      inputTokens: 0,
      outputTokens: 0,
      cacheRead: 0,
      cacheWrite: 0,
    };

    group.tokens += getUsageTokenTotal(usage);
    group.cost += pickCost(usage.estimatedCosts, usage.estimatedCost);
    group.inputTokens += usage.inputTokens;
    group.outputTokens += usage.outputTokens;
    group.cacheRead += usage.cacheReadInputTokens;
    group.cacheWrite += usage.cacheCreationInputTokens;
    modelCostGroups.set(groupKey, group);
  });

  const modelCosts = Array.from(modelCostGroups.values())
    .filter(item => item.tokens > 0 || item.cost > 0)
    .sort((a, b) => b.cost - a.cost);
  return (
    <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <StatCard
          title="Estimated Usage"
          value={formatCost(totalCost)}
          subtitle={modeLabel.name.toLowerCase() + ' estimate'}
          icon={Coins}
        />
        <StatCard
          title="Cache Savings"
          value={formatCost(cacheSavings)}
          subtitle={`${modeLabel.name.toLowerCase()} estimate`}
          icon={Zap}
        />
        <StatCard
          title="Input Tokens"
          value={formatTokens(totalPromptInputTokens)}
          subtitle="fresh + cache read"
          icon={TrendingUp}
        />
        <StatCard
          title="Output Tokens"
          value={formatTokens(totalOutputTokens)}
          icon={Database}
        />
        <StatCard
          title="Lines Changed"
          value={formatNumber(changeTotals.changedLines)}
          subtitle={`+${formatNumber(changeTotals.addedLines)} / -${formatNumber(changeTotals.removedLines)}`}
          icon={GitPullRequest}
        />
      </div>

      {/* Cost Over Time */}
      <ChartSection title="Usage Cost Over Time">
        <CostChart data={stats.dailyModelTokens} buckets={stats.usageBuckets} granularity={stats.bucketGranularity} />
      </ChartSection>

      <ChartSection title="Lines Changed Over Time">
        <LinesChangedOverTime data={stats.dailyChangeActivity} buckets={stats.usageBuckets} granularity={stats.bucketGranularity} />
      </ChartSection>

      <div className="grid grid-cols-2 gap-4">
        {/* Cost by Project */}
        <ChartSection title="Estimated Cost by Project">
          <ProjectCostChart range={range} initialProjects={initialProjects} />
        </ChartSection>

        {/* Model Cost Breakdown */}
        <Card className="border-border/50 shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold">Estimated Cost by Model</CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="space-y-4">
              {modelCosts.length === 0 ? (
                <div className="py-6 text-center text-sm text-muted-foreground">No token usage yet</div>
              ) : (
                modelCosts.map(item => (
                  <div key={item.model} className="space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <div
                          className="h-3 w-3 rounded-full"
                          style={{ backgroundColor: item.color }}
                        />
                        <span className="text-sm font-semibold">{item.name}</span>
                      </div>
                      <span className="text-sm font-bold">{formatCost(item.cost)}</span>
                    </div>
                    <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground pl-5">
                      <span>Input: {formatTokens(item.inputTokens)}</span>
                      <span>Output: {formatTokens(item.outputTokens)}</span>
                      <span>Cache Read: {formatTokens(item.cacheRead)}</span>
                      <span>Cache Write: {formatTokens(item.cacheWrite)}</span>
                    </div>
                    <Separator />
                  </div>
                ))
              )}
            </div>

            {/* Cache Efficiency */}
            <div className="mt-4 rounded-lg bg-accent/50 p-4">
              <h4 className="text-xs font-semibold mb-2">Cache Efficiency</h4>
              <div className="space-y-1.5">
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">Cache Read Tokens</span>
                  <span className="font-medium">{formatTokens(totalCacheReadTokens)}</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">Cache Write Tokens</span>
                  <span className="font-medium">{formatTokens(totalCacheWriteTokens)}</span>
                </div>
                <Separator />
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground font-medium">Estimated Savings</span>
                  <span className="font-bold text-green-600">{formatCost(cacheSavings)}</span>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <PricingReference />
    </>
  );
});

const PricingReference = memo(function PricingReference() {
  const pricingRows = getPricingReferenceEntries();
  const pricingUpdatedAt = new Date(LITELLM_PRICING_SOURCE.updatedAt).toLocaleDateString();

  return (
    <Card className="border-border/50 shadow-sm [content-visibility:auto] [contain-intrinsic-size:auto_540px]">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold">Pricing Reference (per 1M tokens, API rates)</CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="max-h-[460px] overflow-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border/50">
                <th className="sticky top-0 bg-card text-left py-2 font-medium text-muted-foreground">Provider</th>
                <th className="sticky top-0 bg-card text-left py-2 font-medium text-muted-foreground">Model</th>
                <th className="sticky top-0 bg-card text-right py-2 font-medium text-muted-foreground">Input</th>
                <th className="sticky top-0 bg-card text-right py-2 font-medium text-muted-foreground">Output</th>
                <th className="sticky top-0 bg-card text-right py-2 font-medium text-muted-foreground">Cache Write</th>
                <th className="sticky top-0 bg-card text-right py-2 font-medium text-muted-foreground">Cache Read</th>
              </tr>
            </thead>
            <tbody>
              {pricingRows.map(({ model, pricing }) => (
                <tr key={model} className="border-b border-border/30">
                  <td className="py-2 pr-3 font-medium text-muted-foreground">{formatProvider(pricing.provider)}</td>
                  <td className="py-2 pr-3 font-mono font-medium">{model}</td>
                  <td className="py-2 text-right">{formatRate(pricing.inputPerMillion)}</td>
                  <td className="py-2 text-right">{formatRate(pricing.outputPerMillion)}</td>
                  <td className="py-2 text-right">{formatRate(pricing.cacheWritePerMillion)}</td>
                  <td className="py-2 text-right">{formatRate(pricing.cacheReadPerMillion)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[10px] text-muted-foreground">
          LiteLLM rates were refreshed {pricingUpdatedAt}. GPT-6 and GPT-6.1 rates were verified against{' '}
          <a href={OPENAI_PRICING_SOURCE.source} target="_blank" rel="noreferrer" className="underline">OpenAI pricing</a>{' '}
          on {OPENAI_PRICING_SOURCE.verifiedAt} and use Standard short-context rates. Requests above 272K input tokens, other service tiers, and regional premiums are not reflected in these estimates. CLI subscription billing can differ significantly from API rates, especially for cached tokens.
        </p>
      </CardContent>
    </Card>
  );
});


function formatProvider(provider: string | undefined): string {
  if (provider === 'anthropic') return 'Anthropic';
  if (provider === 'openai') return 'OpenAI';
  return provider ?? 'Unknown';
}

function getUsageTokenTotal(usage: DashboardStats['modelUsage'][string]): number {
  return usage.inputTokens
    + usage.outputTokens
    + usage.cacheReadInputTokens
    + usage.cacheCreationInputTokens;
}

function formatRate(rate: number): string {
  return `$${Number.isInteger(rate) ? rate.toString() : rate.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}`;
}
