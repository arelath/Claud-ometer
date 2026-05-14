import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CostModeProvider } from '@/lib/cost-mode-context';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ActivityHeatmap } from '@/components/charts/activity-heatmap';
import { CostChart } from '@/components/charts/cost-chart';
import { ModelBreakdown } from '@/components/charts/model-breakdown';
import { PeakHours } from '@/components/charts/peak-hours';
import { UsageOverTime } from '@/components/charts/usage-over-time';

vi.mock('recharts', () => {
  const Chart = ({ children, data }: { children?: React.ReactNode; data?: unknown[] }) => (
    <div data-testid="mock-chart" data-count={data?.length ?? 0}>{children}</div>
  );
  const Primitive = ({ children, dataKey, fill, stroke }: {
    children?: React.ReactNode;
    dataKey?: string;
    fill?: string;
    stroke?: string;
  }) => (
    <div data-testid="mock-recharts-part" data-key={dataKey} data-fill={fill} data-stroke={stroke}>
      {children}
    </div>
  );

  return {
    Area: Primitive,
    AreaChart: Chart,
    Bar: Primitive,
    BarChart: Chart,
    CartesianGrid: Primitive,
    Cell: Primitive,
    Legend: Primitive,
    Pie: Primitive,
    PieChart: Chart,
    ResponsiveContainer: ({ children }: { children?: React.ReactNode }) => <div data-testid="responsive">{children}</div>,
    Tooltip: Primitive,
    XAxis: Primitive,
    YAxis: Primitive,
  };
});

function renderWithProviders(ui: React.ReactElement) {
  return render(
    <CostModeProvider>
      <TooltipProvider>
        {ui}
      </TooltipProvider>
    </CostModeProvider>,
  );
}

const dailyActivity = [
  { date: '2026-05-06', messageCount: 2, sessionCount: 1, toolCallCount: 3 },
  { date: '2026-05-07', messageCount: 8, sessionCount: 2, toolCallCount: 12 },
];

const dailyModelTokens = [
  {
    date: '2026-05-06',
    tokensByModel: { 'claude-opus-4': 1200, unknown: 0 },
    costsByModel: {
      'claude-opus-4': { api: 1.2, conservative: 0.8, subscription: 0.4 },
      unknown: { api: 0, conservative: 0, subscription: 0 },
    },
  },
  {
    date: '2026-05-07',
    tokensByModel: { 'claude-opus-4': 2400, 'claude-sonnet-4': 900, '<synthetic>': 0 },
    costsByModel: {
      'claude-opus-4': { api: 2.4, conservative: 1.5, subscription: 0.9 },
      'claude-sonnet-4': { api: 0.4, conservative: 0.3, subscription: 0.2 },
      '<synthetic>': { api: 0, conservative: 0, subscription: 0 },
    },
  },
];

describe('chart components', () => {
  it('renders usage over time and switches metrics', () => {
    renderWithProviders(<UsageOverTime data={dailyActivity} />);

    expect(screen.getByText('Usage Over Time')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Sessions' }));
    expect(screen.getByText('Tool Calls')).toBeInTheDocument();
    expect(screen.getAllByTestId('mock-chart').length).toBeGreaterThan(0);
  });

  it('renders activity heatmap with legend labels', () => {
    renderWithProviders(<ActivityHeatmap data={dailyActivity} />);

    expect(screen.getByText('Activity')).toBeInTheDocument();
    expect(screen.getByText('Less')).toBeInTheDocument();
    expect(screen.getByText('More')).toBeInTheDocument();
  });

  it('renders peak hours from sparse hourly data', () => {
    renderWithProviders(<PeakHours data={{ '0': 1, '12': 3, '23': 2 }} />);

    expect(screen.getByText('Peak Hours')).toBeInTheDocument();
    expect(screen.getByTestId('mock-chart')).toHaveAttribute('data-count', '24');
  });

  it('renders cost over time using precomputed model costs', () => {
    renderWithProviders(<CostChart data={dailyModelTokens} />);

    expect(screen.getByText('Estimated Usage Over Time')).toBeInTheDocument();
    const areaKeys = screen.getAllByTestId('mock-recharts-part').map(node => node.getAttribute('data-key'));
    expect(areaKeys).toContain('Opus');
    expect(areaKeys).not.toContain('unknown');
    expect(areaKeys).not.toContain('Synthetic');
  });

  it('renders model usage rows and percentages', () => {
    renderWithProviders(
      <ModelBreakdown
        data={{
          'claude-opus-4': {
            inputTokens: 1000,
            outputTokens: 200,
            cacheReadInputTokens: 300,
            cacheCreationInputTokens: 100,
            costUSD: 0,
            contextWindow: 0,
            maxOutputTokens: 0,
            webSearchRequests: 0,
            estimatedCost: 1,
            estimatedCosts: { api: 2, conservative: 1.4, subscription: 1 },
          },
          'claude-sonnet-4': {
            inputTokens: 300,
            outputTokens: 50,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            costUSD: 0,
            contextWindow: 0,
            maxOutputTokens: 0,
            webSearchRequests: 0,
            estimatedCost: 0.25,
            estimatedCosts: { api: 0.5, conservative: 0.35, subscription: 0.25 },
          },
          unknown: {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            costUSD: 0,
            contextWindow: 0,
            maxOutputTokens: 0,
            webSearchRequests: 0,
            estimatedCost: 0,
            estimatedCosts: { api: 0, conservative: 0, subscription: 0 },
          },
          '<synthetic>': {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            costUSD: 0,
            contextWindow: 0,
            maxOutputTokens: 0,
            webSearchRequests: 0,
            estimatedCost: 0,
            estimatedCosts: { api: 0, conservative: 0, subscription: 0 },
          },
        }}
      />,
    );

    expect(screen.getByText('Model Usage')).toBeInTheDocument();
    expect(screen.getByText('Opus')).toBeInTheDocument();
    expect(screen.getByText('Sonnet')).toBeInTheDocument();
    expect(screen.queryByText('unknown')).not.toBeInTheDocument();
    expect(screen.queryByText('Synthetic')).not.toBeInTheDocument();
    expect(screen.getByText('$1.00')).toBeInTheDocument();
  });
});
