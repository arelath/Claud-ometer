import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/agent-data/data-source', () => ({
  getSelectedAgents: vi.fn(() => ['claude']),
}));

vi.mock('@/lib/claude-data/live-sessions', () => ({
  getLiveSessions: vi.fn(() => []),
}));

vi.mock('@/lib/claude-data/reader', () => ({
  getProjects: vi.fn(async () => [{
    id: 'D-dev-AgentScope',
    name: 'AgentScope',
    path: 'D:/dev/AgentScope',
    sessionCount: 1,
    totalMessages: 2,
    totalTokens: 3,
    estimatedCost: 0,
    estimatedCosts: { api: 0, conservative: 0, subscription: 0 },
    lastActive: '2026-05-08T10:00:00.000Z',
    models: ['Sonnet'],
  }]),
  getSessions: vi.fn(async () => [{
    id: 'session-1',
    projectId: 'D-dev-AgentScope',
    projectName: 'AgentScope',
    timestamp: '2026-05-08T10:00:00.000Z',
    duration: 1000,
    messageCount: 2,
    userMessageCount: 1,
    assistantMessageCount: 1,
    toolCallCount: 0,
    totalInputTokens: 1,
    totalOutputTokens: 2,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    estimatedCost: 0,
    estimatedCosts: { api: 0, conservative: 0, subscription: 0 },
    model: 'claude-sonnet',
    models: ['Sonnet'],
    gitBranch: 'main',
    cwd: 'D:/dev/AgentScope',
    version: '1.0.0',
    toolsUsed: {},
    compaction: { compactions: 0, microcompactions: 0, totalTokensSaved: 0, compactionTimestamps: [] },
  }]),
  getProjectSessions: vi.fn(async () => []),
  getSessionDetail: vi.fn(async () => null),
  searchSessions: vi.fn(async () => []),
  getDashboardStats: vi.fn(async () => ({
    totalSessions: 0,
    totalMessages: 0,
    totalTokens: 0,
    estimatedCost: 0,
    estimatedCosts: { api: 0, conservative: 0, subscription: 0 },
    dailyActivity: [],
    dailyModelTokens: [],
    changeTotals: { addedLines: 0, removedLines: 0, netLineDelta: 0, changedLines: 0, fileCount: 0, editCount: 0 },
    dailyChangeActivity: [],
    modelUsage: {},
    hourCounts: {},
    firstSessionDate: '',
    longestSession: { sessionId: '', duration: 0, messageCount: 0, timestamp: '' },
    projectCount: 0,
    recentSessions: [],
  })),
}));

describe('agent provider registry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the Claude provider', async () => {
    const { getProvider } = await import('@/lib/agent-data/registry');

    expect(getProvider('claude')?.kind).toBe('claude');
  });

  it('returns the Codex provider after registration', async () => {
    const { getProvider } = await import('@/lib/agent-data/registry');

    expect(getProvider('codex')?.kind).toBe('codex');
  });

  it('returns the Copilot provider after registration', async () => {
    const { getProvider } = await import('@/lib/agent-data/registry');

    expect(getProvider('copilot')?.kind).toBe('copilot');
  });

  it('returns the Cursor provider after registration', async () => {
    const { getProvider } = await import('@/lib/agent-data/registry');

    expect(getProvider('cursor')?.kind).toBe('cursor');
  });

  it('resolves legacy unqualified session ids to Claude', async () => {
    const { resolveSessionProvider } = await import('@/lib/agent-data/registry');

    expect(resolveSessionProvider('session-1')?.kind).toBe('claude');
  });

  it('adds provider identity to Claude sessions and projects', async () => {
    const { getProvider } = await import('@/lib/agent-data/registry');
    const provider = getProvider('claude')!;

    await expect(provider.getProjects()).resolves.toMatchObject([{
      agentKind: 'claude',
      nativeId: 'D-dev-AgentScope',
      routeId: 'claude:D-dev-AgentScope',
    }]);
    await expect(provider.getSessions()).resolves.toMatchObject([{
      agentKind: 'claude',
      nativeId: 'session-1',
      routeId: 'claude:session-1',
      nativeProjectId: 'D-dev-AgentScope',
      projectRouteId: 'claude:D-dev-AgentScope',
    }]);
  });
});
