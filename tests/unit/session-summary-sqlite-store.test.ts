import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isSqliteAvailable, openDatabase } from '@/lib/sqlite';
import {
  clearSessionSummaryIndexCache,
  commitSessionSummaryIndex,
  getSessionSummaryIndexPath,
  readSessionSummaryIndexCache,
} from '@/lib/agent-data/session-summary-sqlite-store';
import { writeSessionSummaryCache } from '@/lib/agent-data/session-summary-cache';
import { SESSION_SUMMARY_CACHE_VERSION, type CachedSessionSummary, type SessionSummarySource } from '@/lib/agent-data/session-summary';

const sqliteDescribe = isSqliteAvailable() ? describe : describe.skip;

sqliteDescribe('SQLite session summary index store', () => {
  const root = path.join(process.cwd(), '.test-artifacts', 'session-summary-sqlite-store');

  function makeSource(overrides: Partial<SessionSummarySource> = {}): SessionSummarySource {
    return {
      provider: 'claude',
      parserVersion: 'parser-v1',
      sourceFilePath: path.join(root, 'session.jsonl'),
      sourceSignature: { size: 10, mtimeMs: 20 },
      nativeProjectId: 'project',
      projectName: 'Project',
      ...overrides,
    };
  }

  function makeSummary(overrides: Partial<CachedSessionSummary> = {}): CachedSessionSummary {
    const source = makeSource({
      provider: overrides.provider || 'claude',
      parserVersion: overrides.parserVersion || 'parser-v1',
      sourceFilePath: overrides.sourceFilePath || path.join(root, 'session.jsonl'),
    });
    return {
      cacheVersion: SESSION_SUMMARY_CACHE_VERSION,
      parserVersion: source.parserVersion,
      provider: source.provider,
      nativeId: overrides.nativeId || 'session',
      routeId: overrides.routeId || `${source.provider}:session`,
      nativeProjectId: 'project',
      projectRouteId: `${source.provider}:project`,
      projectName: 'Project',
      sourceFilePath: source.sourceFilePath,
      sourceSignature: source.sourceSignature,
      createdAt: '2026-05-08T10:00:00.000Z',
      updatedAt: '2026-05-08T10:00:01.000Z',
      cwd: 'D:/repo',
      gitBranch: 'main',
      version: 'test',
      model: 'test-model',
      models: ['test-model'],
      messageCount: 2,
      userMessageCount: 1,
      assistantMessageCount: 1,
      toolCallCount: 1,
      tokenTotals: { input: 10, output: 20, cacheRead: 3, cacheWrite: 4, reasoningOutput: 5 },
      modelUsage: {
        'test-model': {
          inputTokens: 10,
          outputTokens: 20,
          cacheReadInputTokens: 3,
          cacheCreationInputTokens: 4,
          reasoningOutputTokens: 5,
        },
      },
      changeTotals: { addedLines: 2, removedLines: 1, netLineDelta: 1, changedLines: 3, fileCount: 1, editCount: 1 },
      usageEvents: [{
        timestamp: '2026-05-08T10:00:01.000Z',
        role: 'assistant',
        model: 'test-model',
        messageCount: 1,
        userMessageCount: 0,
        assistantMessageCount: 1,
        toolCallCount: 1,
        inputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: 3,
        cacheWriteTokens: 4,
        reasoningOutputTokens: 5,
        estimatedCosts: { api: 1, conservative: 0.5, subscription: 0.25 },
      }],
      changeEvents: [{
        timestamp: '2026-05-08T10:00:01.000Z',
        addedLines: 2,
        removedLines: 1,
        netLineDelta: 1,
        changedLines: 3,
        fileCount: 1,
        editCount: 1,
      }],
      toolsUsed: { Edit: 1 },
      compaction: { compactions: 0, microcompactions: 0, totalTokensSaved: 0, compactionTimestamps: [] },
      searchTextPreview: 'hello sqlite',
      ...overrides,
    };
  }

  beforeEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });
    process.env.AGENT_SCOPE_CACHE_DIR = root;
  });

  afterEach(() => {
    clearSessionSummaryIndexCache();
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.AGENT_SCOPE_CACHE_DIR;
  });

  it('persists summaries and normalized metric rows', () => {
    const source = makeSource();
    const summary = makeSummary();

    commitSessionSummaryIndex({
      touchedProviders: ['claude'],
      discoveredSources: [source],
      updatedSummaries: [summary],
    });

    expect(readSessionSummaryIndexCache().summaries).toMatchObject([{ nativeId: 'session', tokenTotals: { input: 10 } }]);

    const db = openDatabase(getSessionSummaryIndexPath());
    try {
      expect(db.get<{ count: number }>('SELECT COUNT(*) as count FROM usage_events')?.count).toBe(1);
      expect(db.get<{ count: number }>('SELECT COUNT(*) as count FROM change_events')?.count).toBe(1);
      expect(db.get<{ count: number }>('SELECT COUNT(*) as count FROM summary_model_usage')?.count).toBe(1);
      expect(db.get<{ count: number }>('SELECT COUNT(*) as count FROM summary_tools')?.count).toBe(1);
    } finally {
      db.close();
    }
  });

  it('warms the SQLite index from the legacy JSON cache', () => {
    writeSessionSummaryCache({
      cacheVersion: SESSION_SUMMARY_CACHE_VERSION,
      generatedAt: '2026-05-08T10:00:00.000Z',
      summaries: [makeSummary()],
    });

    const cache = readSessionSummaryIndexCache();

    expect(cache.generatedAt).toBe('2026-05-08T10:00:00.000Z');
    expect(cache.summaries).toHaveLength(1);
    expect(fs.existsSync(getSessionSummaryIndexPath())).toBe(true);
  });

  it('deletes missing touched-provider rows without deleting untouched providers', () => {
    const claudeSource = makeSource();
    const codexSource = makeSource({
      provider: 'codex',
      parserVersion: 'codex-v1',
      sourceFilePath: path.join(root, 'codex.jsonl'),
    });

    commitSessionSummaryIndex({
      touchedProviders: ['claude', 'codex'],
      discoveredSources: [claudeSource, codexSource],
      updatedSummaries: [
        makeSummary(),
        makeSummary({
          provider: 'codex',
          parserVersion: 'codex-v1',
          nativeId: 'codex-session',
          routeId: 'codex:codex-session',
          sourceFilePath: codexSource.sourceFilePath,
        }),
      ],
    });

    commitSessionSummaryIndex({
      touchedProviders: ['claude'],
      discoveredSources: [],
      updatedSummaries: [],
    });

    expect(readSessionSummaryIndexCache().summaries.map(summary => summary.provider)).toEqual(['codex']);
  });
});
