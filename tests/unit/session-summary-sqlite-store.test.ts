import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isSqliteAvailable, openDatabase, openWritableDatabase } from '@/lib/sqlite';
import {
  clearSessionSummaryIndexCache,
  commitSessionSummaryIndexSource,
  commitSessionSummaryIndex,
  finalizeSessionSummaryIndexDiscovery,
  getSessionSummaryIndexPath,
  readSourceParseCheckpoints,
  readSessionSummaryIndexCache,
} from '@/lib/agent-data/session-summary-sqlite-store';
import { getSessionsSql } from '@/lib/agent-data/analytics-sql';
import { sourceSummaryCacheKey, writeSessionSummaryCache } from '@/lib/agent-data/session-summary-cache';
import type { AgentDataProvider } from '@/lib/agent-data/provider';
import { SESSION_SUMMARY_CACHE_VERSION, type CachedSessionSummary, type SessionSummarySource } from '@/lib/agent-data/session-summary';
import type { SourceParseCheckpoint } from '@/lib/agent-data/session-parse-checkpoint';

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

  function makeCheckpoint(source = makeSource(), overrides: Partial<SourceParseCheckpoint> = {}): SourceParseCheckpoint {
    return {
      sourceKey: sourceSummaryCacheKey(source),
      provider: source.provider,
      parserVersion: source.parserVersion,
      checkpointVersion: 1,
      sourceFilePath: source.sourceFilePath,
      sourceSize: source.sourceSignature.size,
      sourceMtimeMs: source.sourceSignature.mtimeMs,
      lastCompleteOffset: source.sourceSignature.size,
      recordCount: 2,
      componentStateJson: '{"components":[]}',
      accumulatorJson: '{"messageCount":2}',
      updatedAt: '2026-05-08T10:00:02.000Z',
      ...overrides,
    };
  }

  function getRevision(): string {
    const db = openDatabase(getSessionSummaryIndexPath());
    try {
      return db.get<{ value: string }>("SELECT value FROM cache_meta WHERE key = 'revision'")?.value || '';
    } finally {
      db.close();
    }
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

  it('serves SQL session pages from scalar rows without reading payload JSON', () => {
    const source = makeSource();
    const summary = makeSummary({
      compaction: {
        compactions: 1,
        microcompactions: 2,
        totalTokensSaved: 99,
        compactionTimestamps: ['2026-05-08T10:00:01.000Z'],
      },
      toolsUsed: { Read: 2, Edit: 1 },
    });
    commitSessionSummaryIndex({
      touchedProviders: ['claude'],
      discoveredSources: [source],
      updatedSummaries: [summary],
    });

    const db = openWritableDatabase(getSessionSummaryIndexPath());
    try {
      db.run("UPDATE session_summaries SET payload_json = '{not valid json'");
    } finally {
      db.close();
    }

    const page = getSessionsSql([{ kind: 'claude' } as AgentDataProvider], { limit: 10 });

    expect(page?.sessions).toHaveLength(1);
    expect(page?.sessions[0]).toMatchObject({
      id: 'session',
      agentKind: 'claude',
      totalInputTokens: 10,
      totalOutputTokens: 20,
      toolsUsed: { Read: 2, Edit: 1 },
      compaction: {
        compactions: 1,
        microcompactions: 2,
        totalTokensSaved: 99,
        compactionTimestamps: ['2026-05-08T10:00:01.000Z'],
      },
    });
  });

  it('rolls back the whole transaction when a summary write fails', () => {
    const source = makeSource();
    const conflictingSource = makeSource({ sourceFilePath: path.join(root, 'conflict.jsonl') });
    const summary = makeSummary();
    const conflictingSummary = makeSummary({
      sourceFilePath: conflictingSource.sourceFilePath,
      nativeId: 'conflict',
      routeId: summary.routeId,
    });

    commitSessionSummaryIndex({
      touchedProviders: ['claude'],
      discoveredSources: [source],
      updatedSummaries: [summary],
    });

    expect(() => commitSessionSummaryIndex({
      touchedProviders: ['claude'],
      discoveredSources: [source, conflictingSource],
      updatedSummaries: [summary, conflictingSummary],
    })).toThrow();

    const db = openDatabase(getSessionSummaryIndexPath());
    try {
      expect(db.get<{ count: number }>('SELECT COUNT(*) as count FROM sources')?.count).toBe(1);
      expect(db.get<{ count: number }>('SELECT COUNT(*) as count FROM session_summaries')?.count).toBe(1);
      expect(db.get<{ count: number }>(
        'SELECT COUNT(*) as count FROM sources WHERE source_file_path = ?',
        [conflictingSource.sourceFilePath],
      )?.count).toBe(0);
    } finally {
      db.close();
    }
  });

  it('replaces child rows when a summary is rebuilt', () => {
    const source = makeSource();
    const firstSummary = makeSummary({
      modelUsage: {
        first: {
          inputTokens: 1,
          outputTokens: 2,
          cacheReadInputTokens: 3,
          cacheCreationInputTokens: 4,
        },
      },
      toolsUsed: { Read: 2, Edit: 1 },
      usageEvents: [
        {
          timestamp: '2026-05-08T10:00:01.000Z',
          role: 'assistant',
          model: 'first',
          messageCount: 1,
          userMessageCount: 0,
          assistantMessageCount: 1,
          toolCallCount: 1,
          inputTokens: 1,
          outputTokens: 2,
          cacheReadTokens: 3,
          cacheWriteTokens: 4,
          estimatedCosts: { api: 0, conservative: 0, subscription: 0 },
        },
        {
          timestamp: '2026-05-08T10:00:02.000Z',
          role: 'assistant',
          model: 'first',
          messageCount: 1,
          userMessageCount: 0,
          assistantMessageCount: 1,
          toolCallCount: 0,
          inputTokens: 5,
          outputTokens: 6,
          cacheReadTokens: 7,
          cacheWriteTokens: 8,
          estimatedCosts: { api: 0, conservative: 0, subscription: 0 },
        },
      ],
      changeEvents: [
        {
          timestamp: '2026-05-08T10:00:01.000Z',
          addedLines: 1,
          removedLines: 0,
          netLineDelta: 1,
          changedLines: 1,
          fileCount: 1,
          editCount: 1,
        },
      ],
    });
    const rebuiltSummary = makeSummary({
      model: 'second',
      models: ['second'],
      modelUsage: {
        second: {
          inputTokens: 9,
          outputTokens: 10,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      },
      toolsUsed: { Bash: 1 },
      usageEvents: [
        {
          timestamp: '2026-05-08T11:00:01.000Z',
          role: 'assistant',
          model: 'second',
          messageCount: 1,
          userMessageCount: 0,
          assistantMessageCount: 1,
          toolCallCount: 1,
          inputTokens: 9,
          outputTokens: 10,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          estimatedCosts: { api: 0, conservative: 0, subscription: 0 },
        },
      ],
      changeEvents: [],
    });

    commitSessionSummaryIndex({
      touchedProviders: ['claude'],
      discoveredSources: [source],
      updatedSummaries: [firstSummary],
    });
    commitSessionSummaryIndex({
      touchedProviders: ['claude'],
      discoveredSources: [source],
      updatedSummaries: [rebuiltSummary],
    });

    const db = openDatabase(getSessionSummaryIndexPath());
    try {
      expect(db.get<{ count: number }>('SELECT COUNT(*) as count FROM summary_model_usage')?.count).toBe(1);
      expect(db.get<{ model: string }>('SELECT model FROM summary_model_usage')?.model).toBe('second');
      expect(db.get<{ count: number }>('SELECT COUNT(*) as count FROM summary_tools')?.count).toBe(1);
      expect(db.get<{ tool_name: string }>('SELECT tool_name FROM summary_tools')?.tool_name).toBe('Bash');
      expect(db.get<{ count: number }>('SELECT COUNT(*) as count FROM usage_events')?.count).toBe(1);
      expect(db.get<{ model: string }>('SELECT model FROM usage_events')?.model).toBe('second');
      expect(db.get<{ count: number }>('SELECT COUNT(*) as count FROM change_events')?.count).toBe(1);
    } finally {
      db.close();
    }
  });

  it('bumps the SQLite revision for each successful commit', () => {
    const source = makeSource();

    commitSessionSummaryIndex({
      touchedProviders: ['claude'],
      discoveredSources: [source],
      updatedSummaries: [makeSummary()],
    });
    const firstRevision = Number(getRevision());
    commitSessionSummaryIndex({
      touchedProviders: ['claude'],
      discoveredSources: [source],
      updatedSummaries: [makeSummary({ updatedAt: '2026-05-08T10:00:02.000Z' })],
    });

    expect(Number(getRevision())).toBe(firstRevision + 1);
  });

  it('creates the incremental checkpoint table', () => {
    commitSessionSummaryIndex({
      touchedProviders: ['claude'],
      discoveredSources: [makeSource()],
      updatedSummaries: [],
    });

    const db = openDatabase(getSessionSummaryIndexPath());
    try {
      expect(db.get<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'source_parse_checkpoints'",
      )?.name).toBe('source_parse_checkpoints');
    } finally {
      db.close();
    }
  });

  it('persists source parse checkpoints with the index commit', () => {
    const source = makeSource();
    const checkpoint = makeCheckpoint(source);

    commitSessionSummaryIndex({
      touchedProviders: ['claude'],
      discoveredSources: [source],
      updatedSummaries: [makeSummary()],
      updatedCheckpoints: [checkpoint],
    });

    expect(readSourceParseCheckpoints([source]).get(sourceSummaryCacheKey(source))).toEqual(checkpoint);
  });

  it('deletes invalidated source parse checkpoints in the index commit', () => {
    const source = makeSource();
    const sourceKey = sourceSummaryCacheKey(source);

    commitSessionSummaryIndex({
      touchedProviders: ['claude'],
      discoveredSources: [source],
      updatedSummaries: [makeSummary()],
      updatedCheckpoints: [makeCheckpoint(source)],
    });
    commitSessionSummaryIndex({
      touchedProviders: ['claude'],
      discoveredSources: [source],
      updatedSummaries: [makeSummary()],
      deletedCheckpointKeys: [sourceKey],
    });

    expect(readSourceParseCheckpoints([source]).has(sourceKey)).toBe(false);
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

  it('defers missing-source deletion until discovery finalization', () => {
    const firstSource = makeSource();
    const secondSource = makeSource({ sourceFilePath: path.join(root, 'second.jsonl') });
    commitSessionSummaryIndex({
      touchedProviders: ['claude'],
      discoveredSources: [firstSource, secondSource],
      updatedSummaries: [
        makeSummary(),
        makeSummary({
          nativeId: 'second',
          routeId: 'claude:second',
          sourceFilePath: secondSource.sourceFilePath,
        }),
      ],
    });

    commitSessionSummaryIndexSource({
      source: firstSource,
      summary: makeSummary({ updatedAt: '2026-05-08T10:00:02.000Z' }),
    });
    expect(readSessionSummaryIndexCache().summaries).toHaveLength(2);

    finalizeSessionSummaryIndexDiscovery(['claude'], [firstSource]);
    expect(readSessionSummaryIndexCache().summaries.map(summary => summary.nativeId)).toEqual(['session']);
  });

  it('filters session date ranges in the requested local time zone', () => {
    const provider = { kind: 'claude' } as AgentDataProvider;
    const daySource = makeSource({ sourceFilePath: path.join(root, 'day.jsonl') });
    const lateSource = makeSource({ sourceFilePath: path.join(root, 'late.jsonl') });

    commitSessionSummaryIndex({
      touchedProviders: ['claude'],
      discoveredSources: [daySource, lateSource],
      updatedSummaries: [
        makeSummary({
          sourceFilePath: daySource.sourceFilePath,
          nativeId: 'day',
          routeId: 'claude:day',
          createdAt: '2026-05-08T10:00:00.000Z',
          updatedAt: '2026-05-08T10:00:01.000Z',
        }),
        makeSummary({
          sourceFilePath: lateSource.sourceFilePath,
          nativeId: 'late-local-day',
          routeId: 'claude:late-local-day',
          createdAt: '2026-05-09T06:30:00.000Z',
          updatedAt: '2026-05-09T06:30:01.000Z',
        }),
      ],
    });

    const utcPage = getSessionsSql([provider], {
      range: { start: '2026-05-08', end: '2026-05-08' },
      limit: 10,
    });
    const localPage = getSessionsSql([provider], {
      range: { start: '2026-05-08', end: '2026-05-08', timeZone: 'America/Los_Angeles' },
      limit: 10,
    });

    expect(utcPage?.sessions.map(session => session.id)).toEqual(['day']);
    expect(localPage?.sessions.map(session => session.id)).toEqual(['late-local-day', 'day']);
    expect(localPage?.total).toBe(2);
  });
});
