import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CostModeProvider } from '@/lib/cost-mode-context';
import { TooltipProvider } from '@/components/ui/tooltip';
import { DashboardClient } from '@/components/pages/dashboard-client';
import { CostsClient } from '@/components/pages/costs-client';
import { ProjectDetailClient } from '@/components/pages/project-detail-client';
import { ProjectsClient } from '@/components/pages/projects-client';
import { SessionsClient } from '@/components/pages/sessions-client';
import type { DashboardStats, LiveSessionInfo, ProjectInfo, SessionInfo } from '@/lib/claude-data/types';

const hookState = vi.hoisted(() => ({
  stats: undefined as DashboardStats | undefined,
  statsLoading: false,
  projects: undefined as ProjectInfo[] | undefined,
  projectsLoading: false,
  sessions: undefined as SessionInfo[] | undefined,
  sessionsLoading: false,
  liveSessions: [] as LiveSessionInfo[],
  dataSource: { active: 'live', hasImportedData: false, importMeta: null },
  cacheStatus: { status: 'fresh' },
  replace: vi.fn(),
  searchParams: '',
}));

vi.mock('@/lib/hooks', () => ({
  useCacheStatus: () => ({ data: hookState.cacheStatus }),
  useDataSourceInfo: () => ({ data: hookState.dataSource }),
  useLiveSessions: () => ({ data: hookState.liveSessions }),
  useProjectSessions: (_projectId: string, fallbackData?: SessionInfo[]) => ({
    data: hookState.sessions ?? fallbackData,
    isLoading: hookState.sessionsLoading,
  }),
  useProjects: (fallbackData?: ProjectInfo[]) => ({
    data: hookState.projects ?? fallbackData,
    isLoading: hookState.projectsLoading,
  }),
  useSessions: (_limit?: number, _offset?: number, _query?: string, fallbackData?: SessionInfo[]) => ({
    data: hookState.sessions ?? fallbackData,
    isLoading: hookState.sessionsLoading,
  }),
  useStats: (fallbackData?: DashboardStats) => ({
    data: hookState.stats ?? fallbackData,
    isLoading: hookState.statsLoading,
  }),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: hookState.replace }),
  useSearchParams: () => new URLSearchParams(hookState.searchParams),
}));

vi.mock('@/components/charts/activity-heatmap', () => ({
  ActivityHeatmap: ({ data }: { data: unknown[] }) => <div data-testid="activity-chart">activity {data.length}</div>,
}));
vi.mock('@/components/charts/cost-chart', () => ({
  CostChart: ({ data }: { data: unknown[] }) => <div data-testid="cost-chart">cost {data.length}</div>,
}));
vi.mock('@/components/charts/model-breakdown', () => ({
  ModelBreakdown: ({ data }: { data: Record<string, unknown> }) => <div data-testid="model-chart">models {Object.keys(data).length}</div>,
}));
vi.mock('@/components/charts/peak-hours', () => ({
  PeakHours: ({ data }: { data: Record<string, unknown> }) => <div data-testid="peak-chart">hours {Object.keys(data).length}</div>,
}));
vi.mock('@/components/charts/usage-over-time', () => ({
  UsageOverTime: ({ data }: { data: unknown[] }) => <div data-testid="usage-chart">usage {data.length}</div>,
}));
vi.mock('@/components/session/resume-session-button', () => ({
  ResumeSessionButton: ({ sessionId }: { sessionId: string }) => <button>Resume {sessionId}</button>,
}));
vi.mock('@/components/session/live-working-indicator', () => ({
  LiveWorkingIndicator: () => <span>Working</span>,
}));

vi.mock('recharts', () => {
  const Chart = ({ children, data }: { children?: React.ReactNode; data?: unknown[] }) => (
    <div data-testid="mock-chart" data-count={data?.length ?? 0}>{children}</div>
  );
  const Primitive = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  return {
    Bar: Primitive,
    BarChart: Chart,
    CartesianGrid: Primitive,
    ResponsiveContainer: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
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

function costs(api: number, conservative = api / 2, subscription = api / 4) {
  return { api, conservative, subscription };
}

const session: SessionInfo = {
  id: 'session-1',
  projectId: 'project-1',
  projectName: 'Claudometer',
  timestamp: '2026-05-08T12:00:00.000Z',
  duration: 90_000,
  messageCount: 5,
  userMessageCount: 2,
  assistantMessageCount: 3,
  toolCallCount: 4,
  totalInputTokens: 1000,
  totalOutputTokens: 200,
  totalCacheReadTokens: 300,
  totalCacheWriteTokens: 50,
  estimatedCost: 1.25,
  estimatedCosts: costs(5, 2.5, 1.25),
  model: 'claude-opus-4',
  models: ['Opus'],
  gitBranch: 'main',
  cwd: 'D:/dev/Claudometer',
  version: '1.0.0',
  toolsUsed: { Read: 2, Edit: 1 },
  compaction: { compactions: 1, microcompactions: 0, totalTokensSaved: 100, compactionTimestamps: ['2026-05-08T12:01:00.000Z'] },
};

const project: ProjectInfo = {
  id: 'project-1',
  name: 'Claudometer',
  path: 'D:/dev/Claudometer',
  sessionCount: 1,
  totalMessages: 5,
  totalTokens: 1550,
  estimatedCost: 1.25,
  estimatedCosts: costs(5, 2.5, 1.25),
  lastActive: '2026-05-08T12:00:00.000Z',
  models: ['Opus'],
};

const stats: DashboardStats = {
  totalSessions: 1,
  totalMessages: 5,
  totalTokens: 1550,
  estimatedCost: 1.25,
  estimatedCosts: costs(5, 2.5, 1.25),
  dailyActivity: [{ date: '2026-05-08', messageCount: 5, sessionCount: 1, toolCallCount: 4 }],
  dailyModelTokens: [{
    date: '2026-05-08',
    tokensByModel: { 'claude-opus-4': 1550 },
    costsByModel: { 'claude-opus-4': costs(5, 2.5, 1.25) },
  }],
  modelUsage: {
    'claude-opus-4': {
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadInputTokens: 300,
      cacheCreationInputTokens: 50,
      costUSD: 0,
      contextWindow: 0,
      maxOutputTokens: 0,
      webSearchRequests: 0,
      estimatedCost: 1.25,
      estimatedCosts: costs(5, 2.5, 1.25),
    },
  },
  hourCounts: { '12': 1 },
  firstSessionDate: '2026-05-08',
  longestSession: { sessionId: 'session-1', duration: 90_000, messageCount: 5, timestamp: '2026-05-08T12:00:00.000Z' },
  projectCount: 1,
  recentSessions: [session],
};

describe('page client components', () => {
  it('renders dashboard stats and recent sessions', () => {
    renderWithProviders(<DashboardClient initialStats={stats} />);

    expect(screen.getByText('Overview')).toBeInTheDocument();
    expect(screen.getByText('Total Sessions')).toBeInTheDocument();
    expect(screen.getByText('Claudometer')).toBeInTheDocument();
    expect(screen.getByTestId('usage-chart')).toHaveTextContent('usage 1');
  });

  it('renders costs and pricing information', () => {
    renderWithProviders(<CostsClient initialStats={stats} initialProjects={[project]} />);

    expect(screen.getByText('Cost Analytics')).toBeInTheDocument();
    expect(screen.getByText('Cache Savings')).toBeInTheDocument();
    expect(screen.getByText('Input Tokens')).toBeInTheDocument();
    expect(screen.getByText('1.3K')).toBeInTheDocument();
    expect(screen.getByText('fresh + cache read')).toBeInTheDocument();
    expect(screen.getByText('Estimated Cost by Project')).toBeInTheDocument();
    expect(screen.getByTestId('cost-chart')).toHaveTextContent('cost 1');
  });

  it('renders projects as navigable cards', () => {
    renderWithProviders(<ProjectsClient initialProjects={[project]} />);

    expect(screen.getByText('Projects')).toBeInTheDocument();
    expect(screen.getByText('1 projects tracked')).toBeInTheDocument();
    expect(screen.getByText('Claudometer')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
  });

  it('renders project detail summary and sessions', () => {
    renderWithProviders(<ProjectDetailClient projectId="D-dev-Claudometer" initialSessions={[session]} />);

    expect(screen.getByRole('heading', { name: 'Claudometer' })).toBeInTheDocument();
    expect(screen.getByText('Top Tools Used')).toBeInTheDocument();
    expect(screen.getByText('Read')).toBeInTheDocument();
    expect(screen.getByText('session-...')).toBeInTheDocument();
  });

  it('renders session list, live status, search, and resume affordance', async () => {
    hookState.liveSessions = [{
      id: 'session-1',
      sessionId: 'session-1',
      metadataFilePath: 'live.json',
      cwd: 'D:/dev/Claudometer',
      projectName: 'Claudometer',
      startedAt: '2026-05-08T12:00:00.000Z',
      lastActivityAt: '2026-05-08T12:01:00.000Z',
      updatedAtMs: Date.now(),
      status: 'busy',
      statusReason: 'metadata status is busy',
      messageCount: 5,
      toolCallCount: 4,
      lastPreview: 'Working',
      revision: 'rev',
    }];

    renderWithProviders(<SessionsClient initialSessions={[session]} initialQuery="" />);

    expect(screen.getByText('Sessions')).toBeInTheDocument();
    expect(screen.getByText('Claudometer')).toBeInTheDocument();
    expect(screen.getByText('Working')).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('Search across all session messages...'), { target: { value: 'needle' } });
    await waitFor(() => {
      expect(hookState.replace).toHaveBeenCalledWith('/sessions?q=needle', { scroll: false });
    });
  });
});
