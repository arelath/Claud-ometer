import { describe, expect, it } from 'vitest';
import {
  SESSION_SUMMARY_CACHE_VERSION,
  summariesToDashboardStats,
  summariesToProjects,
  summaryToSessionInfo,
  type CachedSessionSummary,
} from '@/lib/agent-data/session-summary';

function makeSummary(overrides: Partial<CachedSessionSummary> = {}): CachedSessionSummary {
  return {
    cacheVersion: SESSION_SUMMARY_CACHE_VERSION,
    parserVersion: 'test-v1',
    provider: 'claude',
    nativeId: 'session-1',
    routeId: 'claude:session-1',
    nativeProjectId: 'project-1',
    projectRouteId: 'claude:project-1',
    projectName: 'Project One',
    sourceFilePath: 'D:/repo/session-1.jsonl',
    sourceSignature: { size: 100, mtimeMs: 1000 },
    createdAt: '2026-05-08T10:00:00.000Z',
    updatedAt: '2026-05-08T10:01:00.000Z',
    cwd: 'D:/repo',
    gitBranch: 'main',
    version: '1.0.0',
    model: 'gpt-5.5',
    models: ['gpt-5.5'],
    messageCount: 2,
    userMessageCount: 1,
    assistantMessageCount: 1,
    toolCallCount: 1,
    tokenTotals: { input: 100, output: 20, cacheRead: 5, cacheWrite: 2, reasoningOutput: 3 },
    modelUsage: {
      'gpt-5.5': {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadInputTokens: 5,
        cacheCreationInputTokens: 2,
        reasoningOutputTokens: 3,
      },
    },
    changeTotals: { addedLines: 2, removedLines: 1, netLineDelta: 1, changedLines: 3, fileCount: 1, editCount: 1 },
    toolsUsed: { shell_command: 1 },
    compaction: { compactions: 0, microcompactions: 0, totalTokensSaved: 0, compactionTimestamps: [] },
    searchTextPreview: 'project one',
    ...overrides,
  };
}

describe('session summary aggregation', () => {
  it('converts summaries to public session info while preserving route metadata', () => {
    const claude = summaryToSessionInfo(makeSummary());
    const codex = summaryToSessionInfo(makeSummary({
      provider: 'codex',
      nativeId: 'codex-session',
      routeId: 'codex:codex-session',
      nativeProjectId: 'codex-project',
      projectRouteId: 'codex:codex-project',
    }));

    expect(claude).toMatchObject({
      id: 'session-1',
      routeId: 'claude:session-1',
      projectId: 'project-1',
      projectRouteId: 'claude:project-1',
    });
    expect(codex).toMatchObject({
      id: 'codex:codex-session',
      routeId: 'codex:codex-session',
      projectId: 'codex:codex-project',
    });
    expect(claude).not.toHaveProperty('searchTextPreview');
    expect(claude).not.toHaveProperty('modelUsage');
  });

  it('aggregates projects and dashboard stats from cached summaries', () => {
    const summaries = [
      makeSummary(),
      makeSummary({
        nativeId: 'session-2',
        routeId: 'claude:session-2',
        sourceFilePath: 'D:/repo/session-2.jsonl',
        createdAt: '2026-05-08T11:00:00.000Z',
        updatedAt: '2026-05-08T11:02:00.000Z',
        messageCount: 3,
        toolCallCount: 2,
        tokenTotals: { input: 50, output: 10, cacheRead: 0, cacheWrite: 0 },
        modelUsage: {
          'gpt-5.4': {
            inputTokens: 50,
            outputTokens: 10,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
          },
        },
        changeTotals: { addedLines: 5, removedLines: 2, netLineDelta: 3, changedLines: 7, fileCount: 2, editCount: 2 },
      }),
    ];

    const projects = summariesToProjects(summaries);
    const stats = summariesToDashboardStats(summaries);

    expect(projects).toMatchObject([{
      id: 'project-1',
      sessionCount: 2,
      totalMessages: 5,
      totalTokens: 187,
    }]);
    expect(stats).toMatchObject({
      totalSessions: 2,
      totalMessages: 5,
      totalTokens: 187,
      projectCount: 1,
    });
    expect(stats.dailyActivity).toEqual([{ date: '2026-05-08', messageCount: 5, sessionCount: 2, toolCallCount: 3 }]);
    expect(stats.changeTotals).toEqual({ addedLines: 7, removedLines: 3, netLineDelta: 4, changedLines: 10, fileCount: 3, editCount: 3 });
    expect(stats.dailyChangeActivity).toEqual([{
      date: '2026-05-08',
      addedLines: 7,
      removedLines: 3,
      netLineDelta: 4,
      changedLines: 10,
      fileCount: 3,
      editCount: 3,
      sessionCount: 2,
    }]);
    expect(Object.keys(stats.modelUsage)).toEqual(expect.arrayContaining(['gpt-5.5', 'gpt-5.4']));
    expect(stats.recentSessions.map(session => session.id)).toEqual(['session-2', 'session-1']);
  });
});
