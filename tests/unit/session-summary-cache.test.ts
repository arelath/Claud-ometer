import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearSessionSummaryCache,
  getSessionSummaryCachePath,
  isSummaryValidForSource,
  mergeUpdatedSummaries,
  readSessionSummaryCache,
  writeSessionSummaryCache,
} from '@/lib/agent-data/session-summary-cache';
import { SESSION_SUMMARY_CACHE_VERSION, type CachedSessionSummary, type SessionSummarySource } from '@/lib/agent-data/session-summary';

describe('session summary cache storage', () => {
  const root = path.join(process.cwd(), '.test-artifacts', 'session-summary-cache');

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
    const source = makeSource();
    return {
      cacheVersion: SESSION_SUMMARY_CACHE_VERSION,
      parserVersion: source.parserVersion,
      provider: source.provider,
      nativeId: 'session',
      routeId: 'claude:session',
      nativeProjectId: 'project',
      projectRouteId: 'claude:project',
      projectName: 'Project',
      sourceFilePath: source.sourceFilePath,
      sourceSignature: source.sourceSignature,
      createdAt: '2026-05-08T10:00:00.000Z',
      updatedAt: '2026-05-08T10:00:01.000Z',
      cwd: 'D:/repo',
      gitBranch: '',
      version: '',
      model: 'unknown',
      models: [],
      messageCount: 0,
      userMessageCount: 0,
      assistantMessageCount: 0,
      toolCallCount: 0,
      tokenTotals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      modelUsage: {},
      changeTotals: { addedLines: 1, removedLines: 0, netLineDelta: 1, changedLines: 1, fileCount: 1, editCount: 1 },
      toolsUsed: {},
      compaction: { compactions: 0, microcompactions: 0, totalTokensSaved: 0, compactionTimestamps: [] },
      ...overrides,
    };
  }

  beforeEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    process.env.CLAUD_OMETER_CACHE_DIR = root;
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.CLAUD_OMETER_CACHE_DIR;
  });

  it('writes and reads cache files atomically', () => {
    writeSessionSummaryCache({
      cacheVersion: SESSION_SUMMARY_CACHE_VERSION,
      generatedAt: '2026-05-08T10:00:00.000Z',
      summaries: [makeSummary()],
    });

    expect(getSessionSummaryCachePath()).toBe(path.join(root, 'agent-session-summary-v3.json'));
    expect(fs.readdirSync(root).some(file => file.endsWith('.tmp'))).toBe(false);
    expect(readSessionSummaryCache()).toMatchObject({
      generatedAt: '2026-05-08T10:00:00.000Z',
      summaries: [{ nativeId: 'session', changeTotals: { addedLines: 1, changedLines: 1 } }],
    });
  });

  it('treats corrupt cache JSON as empty', () => {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(getSessionSummaryCachePath(), '{not json');

    expect(readSessionSummaryCache().summaries).toEqual([]);
  });

  it('validates summaries by provider, parser version, file size, and mtime', () => {
    const source = makeSource();
    const summary = makeSummary();

    expect(isSummaryValidForSource(summary, source)).toBe(true);
    expect(isSummaryValidForSource(summary, makeSource({ parserVersion: 'parser-v2' }))).toBe(false);
    expect(isSummaryValidForSource(summary, makeSource({ sourceSignature: { size: 11, mtimeMs: 20 } }))).toBe(false);
    expect(isSummaryValidForSource(summary, makeSource({ sourceSignature: { size: 10, mtimeMs: 21 } }))).toBe(false);
    expect(isSummaryValidForSource(summary, makeSource({ provider: 'codex' }))).toBe(false);
  });

  it('drops deleted touched-provider summaries while preserving untouched providers', () => {
    const claude = makeSummary();
    const codex = makeSummary({
      provider: 'codex',
      parserVersion: 'codex-v1',
      nativeId: 'codex-session',
      routeId: 'codex:codex-session',
      sourceFilePath: path.join(root, 'codex.jsonl'),
    });
    const updated = makeSummary({ nativeId: 'new-session', sourceFilePath: path.join(root, 'new.jsonl') });

    const merged = mergeUpdatedSummaries([claude, codex], [updated], [{
      ...makeSource(),
      sourceFilePath: updated.sourceFilePath,
    }]);

    expect(merged.map(summary => summary.nativeId)).toEqual(expect.arrayContaining(['new-session', 'codex-session']));
    expect(merged.map(summary => summary.nativeId)).not.toContain('session');
  });

  it('clears the persistent cache file', () => {
    writeSessionSummaryCache({
      cacheVersion: SESSION_SUMMARY_CACHE_VERSION,
      generatedAt: '2026-05-08T10:00:00.000Z',
      summaries: [makeSummary()],
    });

    clearSessionSummaryCache();

    expect(fs.existsSync(getSessionSummaryCachePath())).toBe(false);
  });
});
