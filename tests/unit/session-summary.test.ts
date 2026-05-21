import { describe, expect, it } from 'vitest';
import {
  SESSION_SUMMARY_CACHE_VERSION,
  summariesToCostAnalytics,
  summariesToDashboardStats,
  summariesToProjects,
  summariesToSessions,
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

    const costAnalytics = summariesToCostAnalytics(summaries);
    expect(costAnalytics.projects).toMatchObject(projects);
    expect(costAnalytics.stats).toMatchObject({
      totalSessions: stats.totalSessions,
      totalMessages: stats.totalMessages,
      totalTokens: stats.totalTokens,
      estimatedCosts: stats.estimatedCosts,
      changeTotals: stats.changeTotals,
      projectCount: stats.projectCount,
    });
    expect(costAnalytics.stats.dailyModelTokens).toEqual(stats.dailyModelTokens);
    expect(costAnalytics.stats.dailyChangeActivity).toEqual(stats.dailyChangeActivity);
    expect(costAnalytics.stats.recentSessions).toEqual([]);
  });

  it('aggregates usage by event local day instead of session start day', () => {
    const summary = makeSummary({
      createdAt: '2026-05-08T06:30:00.000Z',
      updatedAt: '2026-05-08T07:30:00.000Z',
      messageCount: 1,
      userMessageCount: 0,
      assistantMessageCount: 1,
      toolCallCount: 0,
      tokenTotals: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
      modelUsage: {
        'gpt-5.5': {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      },
      changeTotals: { addedLines: 0, removedLines: 0, netLineDelta: 0, changedLines: 0, fileCount: 0, editCount: 0 },
      usageEvents: [{
        timestamp: '2026-05-08T07:30:00.000Z',
        model: 'gpt-5.5',
        messageCount: 1,
        userMessageCount: 0,
        assistantMessageCount: 1,
        toolCallCount: 0,
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningOutputTokens: 0,
        estimatedCosts: { api: 0.01, conservative: 0.005, subscription: 0.0025 },
      }],
      changeEvents: [],
    });

    const stats = summariesToDashboardStats([summary], {
      start: '2026-05-08',
      end: '2026-05-08',
      timeZone: 'America/Los_Angeles',
      granularity: 'day',
    });

    expect(stats.totalSessions).toBe(1);
    expect(stats.totalMessages).toBe(1);
    expect(stats.dailyActivity).toEqual([{ date: '2026-05-08', messageCount: 1, sessionCount: 0, toolCallCount: 0 }]);
    expect(stats.usageBuckets).toEqual([expect.objectContaining({
      key: '2026-05-08',
      messageCount: 1,
      sessionStartCount: 0,
      activeSessionCount: 1,
    })]);
  });

  it('uses four-hour buckets for short event-time ranges', () => {
    const summary = makeSummary({
      createdAt: '2026-05-08T07:10:00.000Z',
      updatedAt: '2026-05-08T07:30:00.000Z',
      messageCount: 1,
      userMessageCount: 0,
      assistantMessageCount: 1,
      tokenTotals: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0 },
      modelUsage: {},
      usageEvents: [{
        timestamp: '2026-05-08T07:30:00.000Z',
        model: 'gpt-5.5',
        messageCount: 1,
        userMessageCount: 0,
        assistantMessageCount: 1,
        toolCallCount: 0,
        inputTokens: 0,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningOutputTokens: 0,
        estimatedCosts: { api: 0, conservative: 0, subscription: 0 },
      }],
    });

    const stats = summariesToDashboardStats([summary], {
      start: '2026-05-08',
      end: '2026-05-08',
      timeZone: 'America/Los_Angeles',
      granularity: '4h',
    });

    expect(stats.bucketGranularity).toBe('4h');
    expect(stats.usageBuckets).toHaveLength(6);
    expect(stats.usageBuckets?.[0]).toMatchObject({
      key: '2026-05-08T00:00',
      messageCount: 1,
      activeSessionCount: 1,
    });
    expect(stats.usageBuckets?.slice(1).every(bucket => bucket.messageCount === 0)).toBe(true);
  });

  it('excludes empty zero-token placeholder sessions from user-facing lists and counts', () => {
    const visible = makeSummary();
    const emptyPlaceholder = makeSummary({
      nativeId: 'empty-session',
      routeId: 'copilot:workspace:empty-session',
      provider: 'copilot',
      sourceFilePath: 'D:/repo/empty.jsonl',
      createdAt: '2026-05-08T12:00:00.000Z',
      updatedAt: '2026-05-08T12:00:00.000Z',
      messageCount: 0,
      userMessageCount: 0,
      assistantMessageCount: 0,
      toolCallCount: 0,
      tokenTotals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoningOutput: 0 },
      modelUsage: {},
      toolsUsed: {},
      changeTotals: { addedLines: 0, removedLines: 0, netLineDelta: 0, changedLines: 0, fileCount: 0, editCount: 0 },
    });

    expect(summariesToSessions([emptyPlaceholder, visible]).map(session => session.nativeId)).toEqual(['session-1']);
    expect(summariesToProjects([emptyPlaceholder, visible])).toMatchObject([{ sessionCount: 1, totalMessages: 2 }]);
    expect(summariesToDashboardStats([emptyPlaceholder, visible])).toMatchObject({
      totalSessions: 1,
      totalMessages: 2,
      totalTokens: 127,
      projectCount: 1,
    });
  });
});
