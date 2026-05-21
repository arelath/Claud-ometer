import React from 'react';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DashboardStats, ProjectInfo, SessionInfo } from '@/lib/claude-data/types';

const readerState = vi.hoisted(() => ({
  getDashboardStats: vi.fn(),
  getProjects: vi.fn(),
  getProjectSessions: vi.fn(),
  getSessions: vi.fn(),
  searchSessions: vi.fn(),
  getActiveProviders: vi.fn(),
  getCachedCostAnalytics: vi.fn(),
}));

vi.mock('@/lib/claude-data/reader', () => ({
  getDashboardStats: readerState.getDashboardStats,
  getProjects: readerState.getProjects,
  getProjectSessions: readerState.getProjectSessions,
  getSessions: readerState.getSessions,
  searchSessions: readerState.searchSessions,
}));

vi.mock('@/lib/agent-data/registry', () => ({
  getActiveProviders: readerState.getActiveProviders,
}));

vi.mock('@/lib/agent-data/analytics', () => ({
  getCachedCostAnalytics: readerState.getCachedCostAnalytics,
}));

vi.mock('@/components/pages/dashboard-client', () => ({
  DashboardClient: ({ initialStats }: { initialStats?: DashboardStats }) => (
    <div>Dashboard client {initialStats?.totalSessions ?? 'client-fetch'}</div>
  ),
}));

vi.mock('@/components/pages/costs-client', () => ({
  CostsClient: ({ initialStats, initialProjects }: { initialStats?: DashboardStats; initialProjects?: ProjectInfo[] }) => (
    <div>Costs client {initialStats?.totalTokens ?? 'client-fetch'} {initialProjects?.length ?? 'client-fetch'}</div>
  ),
}));

vi.mock('@/components/pages/projects-client', () => ({
  ProjectsClient: ({ initialProjects }: { initialProjects?: ProjectInfo[] }) => (
    <div>Projects client {initialProjects?.length ?? 'client-fetch'}</div>
  ),
}));

vi.mock('@/components/pages/project-detail-client', () => ({
  ProjectDetailClient: ({ projectId, initialSessions }: { projectId: string; initialSessions?: SessionInfo[] }) => (
    <div>Project detail client {projectId} {initialSessions?.length ?? 'client-fetch'}</div>
  ),
}));

vi.mock('@/components/pages/sessions-client', () => ({
  SessionsClient: ({ initialSessions, initialQuery }: { initialSessions?: SessionInfo[]; initialQuery?: string }) => (
    <div>Sessions client {initialQuery || 'empty'} {initialSessions?.length ?? 'client-fetch'}</div>
  ),
}));

function costs(api: number) {
  return { api, conservative: api / 2, subscription: api / 4 };
}

const session: SessionInfo = {
  id: 'session-1',
  projectId: 'project-1',
  projectName: 'AgentScope',
  timestamp: '2026-05-08T12:00:00.000Z',
  duration: 60_000,
  messageCount: 2,
  userMessageCount: 1,
  assistantMessageCount: 1,
  toolCallCount: 0,
  totalInputTokens: 100,
  totalOutputTokens: 50,
  totalCacheReadTokens: 0,
  totalCacheWriteTokens: 0,
  estimatedCost: 0.5,
  estimatedCosts: costs(0.5),
  model: 'claude-opus-4',
  models: ['Opus'],
  gitBranch: 'main',
  cwd: 'D:/dev/AgentScope',
  version: '1.0.0',
  toolsUsed: {},
  compaction: { compactions: 0, microcompactions: 0, totalTokensSaved: 0, compactionTimestamps: [] },
};

const project: ProjectInfo = {
  id: 'project-1',
  name: 'AgentScope',
  path: 'D:/dev/AgentScope',
  sessionCount: 1,
  totalMessages: 2,
  totalTokens: 150,
  estimatedCost: 0.5,
  estimatedCosts: costs(0.5),
  lastActive: '2026-05-08T12:00:00.000Z',
  models: ['Opus'],
};

const stats: DashboardStats = {
  totalSessions: 1,
  totalMessages: 2,
  totalTokens: 150,
  estimatedCost: 0.5,
  estimatedCosts: costs(0.5),
  dailyActivity: [],
  dailyModelTokens: [],
  changeTotals: { addedLines: 0, removedLines: 0, netLineDelta: 0, changedLines: 0, fileCount: 0, editCount: 0 },
  dailyChangeActivity: [],
  modelUsage: {},
  hourCounts: {},
  firstSessionDate: '2026-05-08',
  longestSession: { sessionId: 'session-1', duration: 60_000, messageCount: 2, timestamp: '2026-05-08T12:00:00.000Z' },
  projectCount: 1,
  recentSessions: [session],
};

describe('Next app page wrappers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readerState.getDashboardStats.mockResolvedValue(stats);
    readerState.getProjects.mockResolvedValue([project]);
    readerState.getProjectSessions.mockResolvedValue([session]);
    readerState.getSessions.mockResolvedValue([session]);
    readerState.searchSessions.mockResolvedValue([{ ...session, id: 'session-search' }]);
    readerState.getActiveProviders.mockReturnValue([]);
    readerState.getCachedCostAnalytics.mockReturnValue({ stats, projects: [project] });
  });

  it('renders dashboard, costs, and projects as shells without eager-loading large server data', async () => {
    const DashboardPage = (await import('@/app/page')).default;
    const CostsPage = (await import('@/app/costs/page')).default;
    const ProjectsPage = (await import('@/app/projects/page')).default;

    render(<DashboardPage />);
    expect(readerState.getDashboardStats).not.toHaveBeenCalled();
    expect(screen.getByText('Dashboard client client-fetch')).toBeInTheDocument();

    render(<CostsPage />);
    expect(readerState.getProjects).not.toHaveBeenCalled();
    expect(readerState.getCachedCostAnalytics).not.toHaveBeenCalled();
    expect(screen.getByText('Costs client client-fetch client-fetch')).toBeInTheDocument();

    render(await ProjectsPage());
    expect(screen.getByText('Projects client client-fetch')).toBeInTheDocument();
  });

  it('decodes project ids without eager-loading project sessions', async () => {
    const ProjectDetailPage = (await import('@/app/projects/[id]/page')).default;

    render(await ProjectDetailPage({ params: Promise.resolve({ id: 'D%3A%5Cdev%5CAgentScope' }) }));

    expect(readerState.getProjectSessions).not.toHaveBeenCalled();
    expect(screen.getByText('Project detail client D:\\dev\\AgentScope client-fetch')).toBeInTheDocument();
  });

  it('renders the sessions shell without eager-loading large server data', async () => {
    const SessionsPage = (await import('@/app/sessions/page')).default;

    render(await SessionsPage({ searchParams: Promise.resolve({}) }));
    expect(readerState.getSessions).not.toHaveBeenCalled();
    expect(screen.getByText('Sessions client empty client-fetch')).toBeInTheDocument();

    render(await SessionsPage({ searchParams: Promise.resolve({ q: 'needle' }) }));
    expect(readerState.searchSessions).not.toHaveBeenCalled();
    expect(screen.getByText('Sessions client needle client-fetch')).toBeInTheDocument();
  });
});
