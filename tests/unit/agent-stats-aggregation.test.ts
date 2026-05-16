import { describe, expect, it } from 'vitest';
import { mergeDashboardStats } from '@/lib/agent-data/aggregate';
import type { DashboardStats } from '@/lib/claude-data/types';

function costs(api: number) {
  return { api, conservative: api / 2, subscription: api / 4 };
}

function stats(name: 'claude' | 'codex'): DashboardStats {
  const isCodex = name === 'codex';
  const model = isCodex ? 'gpt-5.5' : 'claude-opus-4';
  const sessionId = isCodex ? 'codex:session-1' : 'session-1';
  const timestamp = isCodex ? '2026-05-08T11:00:00.000Z' : '2026-05-07T10:00:00.000Z';
  return {
    totalSessions: isCodex ? 1 : 2,
    totalMessages: isCodex ? 3 : 8,
    totalTokens: isCodex ? 198 : 1200,
    estimatedCost: isCodex ? 0.02 : 0.4,
    estimatedCosts: costs(isCodex ? 0.08 : 1.6),
    dailyActivity: [{ date: '2026-05-08', messageCount: isCodex ? 3 : 2, sessionCount: isCodex ? 1 : 1, toolCallCount: isCodex ? 2 : 4 }],
    dailyModelTokens: [{
      date: '2026-05-08',
      tokensByModel: { [model]: isCodex ? 198 : 1200 },
      costsByModel: { [model]: costs(isCodex ? 0.08 : 1.6) },
    }],
    changeTotals: {
      addedLines: isCodex ? 3 : 10,
      removedLines: isCodex ? 1 : 4,
      netLineDelta: isCodex ? 2 : 6,
      changedLines: isCodex ? 4 : 14,
      fileCount: isCodex ? 1 : 2,
      editCount: isCodex ? 1 : 3,
    },
    dailyChangeActivity: [{
      date: '2026-05-08',
      addedLines: isCodex ? 3 : 10,
      removedLines: isCodex ? 1 : 4,
      netLineDelta: isCodex ? 2 : 6,
      changedLines: isCodex ? 4 : 14,
      fileCount: isCodex ? 1 : 2,
      editCount: isCodex ? 1 : 3,
      sessionCount: isCodex ? 1 : 2,
    }],
    modelUsage: {
      [model]: {
        inputTokens: isCodex ? 150 : 900,
        outputTokens: isCodex ? 23 : 100,
        cacheReadInputTokens: isCodex ? 25 : 150,
        cacheCreationInputTokens: isCodex ? 0 : 50,
        reasoningOutputTokens: isCodex ? 5 : 0,
        costUSD: 0,
        contextWindow: 0,
        maxOutputTokens: 0,
        webSearchRequests: 0,
        estimatedCost: isCodex ? 0.02 : 0.4,
        estimatedCosts: costs(isCodex ? 0.08 : 1.6),
      },
    },
    hourCounts: { [isCodex ? '11' : '10']: isCodex ? 1 : 2 },
    firstSessionDate: isCodex ? '2026-05-08' : '2026-05-07',
    longestSession: { sessionId, duration: isCodex ? 15_000 : 30_000, messageCount: isCodex ? 3 : 8, timestamp },
    projectCount: isCodex ? 1 : 2,
    recentSessions: [{
      id: sessionId,
      projectId: `${name}:project`,
      projectName: name,
      timestamp,
      duration: isCodex ? 15_000 : 30_000,
      messageCount: isCodex ? 3 : 8,
      userMessageCount: 1,
      assistantMessageCount: 2,
      toolCallCount: isCodex ? 2 : 4,
      totalInputTokens: isCodex ? 150 : 900,
      totalOutputTokens: isCodex ? 23 : 100,
      totalCacheReadTokens: isCodex ? 25 : 150,
      totalCacheWriteTokens: isCodex ? 0 : 50,
      estimatedCost: isCodex ? 0.02 : 0.4,
      estimatedCosts: costs(isCodex ? 0.08 : 1.6),
      model,
      models: [model],
      gitBranch: 'main',
      cwd: 'D:/dev/project',
      version: 'test',
      toolsUsed: {},
      compaction: { compactions: 0, microcompactions: 0, totalTokensSaved: 0, compactionTimestamps: [] },
      agentKind: name,
    }],
  };
}

describe('agent stats aggregation', () => {
  it('merges Claude and Codex dashboard stats without dropping provider data', () => {
    const merged = mergeDashboardStats([stats('claude'), stats('codex')]);

    expect(merged.totalSessions).toBe(3);
    expect(merged.totalMessages).toBe(11);
    expect(merged.totalTokens).toBe(1398);
    expect(merged.projectCount).toBe(3);
    expect(merged.dailyActivity).toEqual([{ date: '2026-05-08', messageCount: 5, sessionCount: 2, toolCallCount: 6 }]);
    expect(merged.changeTotals).toEqual({ addedLines: 13, removedLines: 5, netLineDelta: 8, changedLines: 18, fileCount: 3, editCount: 4 });
    expect(merged.dailyChangeActivity).toEqual([{
      date: '2026-05-08',
      addedLines: 13,
      removedLines: 5,
      netLineDelta: 8,
      changedLines: 18,
      fileCount: 3,
      editCount: 4,
      sessionCount: 3,
    }]);
    expect(merged.dailyModelTokens[0].tokensByModel).toEqual({ 'claude-opus-4': 1200, 'gpt-5.5': 198 });
    expect(merged.modelUsage['gpt-5.5'].reasoningOutputTokens).toBe(5);
    expect(merged.hourCounts).toEqual({ '10': 2, '11': 1 });
    expect(merged.longestSession.sessionId).toBe('session-1');
    expect(merged.recentSessions.map(session => session.id)).toEqual(['codex:session-1', 'session-1']);
  });
});
