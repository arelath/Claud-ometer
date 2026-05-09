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
}));

vi.mock('@/lib/claude-data/reader', () => ({
  getDashboardStats: readerState.getDashboardStats,
  getProjects: readerState.getProjects,
  getProjectSessions: readerState.getProjectSessions,
  getSessions: readerState.getSessions,
  searchSessions: readerState.searchSessions,
}));

vi.mock('@/components/pages/dashboard-client', () => ({
  DashboardClient: ({ initialStats }: { initialStats: DashboardStats }) => (
    <div>Dashboard client {initialStats.totalSessions}</div>
  ),
}));

vi.mock('@/components/pages/costs-client', () => ({
  CostsClient: ({ initialStats, initialProjects }: { initialStats: DashboardStats; initialProjects: ProjectInfo[] }) => (
    <div>Costs client {initialStats.totalTokens} {initialProjects.length}</div>
  ),
}));

vi.mock('@/components/pages/projects-client', () => ({
  ProjectsClient: ({ initialProjects }: { initialProjects: ProjectInfo[] }) => (
    <div>Projects client {initialProjects.length}</div>
  ),
}));

vi.mock('@/components/pages/project-detail-client', () => ({
  ProjectDetailClient: ({ projectId, initialSessions }: { projectId: string; initialSessions: SessionInfo[] }) => (
    <div>Project detail client {projectId} {initialSessions.length}</div>
  ),
}));

vi.mock('@/components/pages/sessions-client', () => ({
  SessionsClient: ({ initialSessions, initialQuery }: { initialSessions: SessionInfo[]; initialQuery: string }) => (
    <div>Sessions client {initialQuery || 'empty'} {initialSessions.length}</div>
  ),
}));

function costs(api: number) {
  return { api, conservative: api / 2, subscription: api / 4 };
}

const session: SessionInfo = {
  id: 'session-1',
  projectId: 'project-1',
  projectName: 'Claudometer',
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
  cwd: 'D:/dev/Claudometer',
  version: '1.0.0',
  toolsUsed: {},
  compaction: { compactions: 0, microcompactions: 0, totalTokensSaved: 0, compactionTimestamps: [] },
};

const project: ProjectInfo = {
  id: 'project-1',
  name: 'Claudometer',
  path: 'D:/dev/Claudometer',
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
  modelUsage: {},
  hourCounts: {},
  firstSessionDate: '2026-05-08',
  longestSession: { sessionId: 'session-1', duration: 60_000, messageCount: 2, timestamp: '2026-05-08T12:00:00.000Z' },
  projectCount: 1,
  recentSessions: [session],
};

describe('Next app page wrappers', () => {
  beforeEach(() => {
    readerState.getDashboardStats.mockResolvedValue(stats);
    readerState.getProjects.mockResolvedValue([project]);
    readerState.getProjectSessions.mockResolvedValue([session]);
    readerState.getSessions.mockResolvedValue([session]);
    readerState.searchSessions.mockResolvedValue([{ ...session, id: 'session-search' }]);
  });

  it('loads dashboard, costs, and projects server data into client components', async () => {
    const DashboardPage = (await import('@/app/page')).default;
    const CostsPage = (await import('@/app/costs/page')).default;
    const ProjectsPage = (await import('@/app/projects/page')).default;

    render(await DashboardPage());
    expect(screen.getByText('Dashboard client 1')).toBeInTheDocument();

    render(await CostsPage());
    expect(screen.getByText('Costs client 150 1')).toBeInTheDocument();

    render(await ProjectsPage());
    expect(screen.getByText('Projects client 1')).toBeInTheDocument();
  });

  it('decodes project ids before loading project sessions', async () => {
    const ProjectDetailPage = (await import('@/app/projects/[id]/page')).default;

    render(await ProjectDetailPage({ params: Promise.resolve({ id: 'D%3A%5Cdev%5CClaudometer' }) }));

    expect(readerState.getProjectSessions).toHaveBeenCalledWith('D:\\dev\\Claudometer');
    expect(screen.getByText('Project detail client D:\\dev\\Claudometer 1')).toBeInTheDocument();
  });

  it('loads sessions by default and search results when a query is present', async () => {
    const SessionsPage = (await import('@/app/sessions/page')).default;

    render(await SessionsPage({ searchParams: Promise.resolve({}) }));
    expect(readerState.getSessions).toHaveBeenCalledWith(100, 0);
    expect(screen.getByText('Sessions client empty 1')).toBeInTheDocument();

    render(await SessionsPage({ searchParams: Promise.resolve({ q: 'needle' }) }));
    expect(readerState.searchSessions).toHaveBeenCalledWith('needle', 100);
    expect(screen.getByText('Sessions client needle 1')).toBeInTheDocument();
  });
});
