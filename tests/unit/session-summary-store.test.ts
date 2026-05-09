import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentDataProvider } from '@/lib/agent-data/provider';
import {
  clearSessionSummaryCache,
  getCachedSessionSummaries,
  resetSessionSummaryStoreForTests,
} from '@/lib/agent-data/session-summary-store';
import { SESSION_SUMMARY_CACHE_VERSION, type CachedSessionSummary, type SessionSummarySource } from '@/lib/agent-data/session-summary';

describe('session summary store', () => {
  const root = path.join(process.cwd(), '.test-artifacts', 'session-summary-store');
  const filePath = path.join(root, 'session.jsonl');

  function sourceFor(file: string, parserVersion = 'parser-v1'): SessionSummarySource {
    const stat = fs.statSync(file);
    return {
      provider: 'claude',
      parserVersion,
      sourceFilePath: file,
      sourceSignature: { size: stat.size, mtimeMs: stat.mtimeMs },
      nativeProjectId: 'project',
      projectName: 'Project',
    };
  }

  function summaryFor(source: SessionSummarySource): CachedSessionSummary {
    return {
      cacheVersion: SESSION_SUMMARY_CACHE_VERSION,
      parserVersion: source.parserVersion,
      provider: source.provider,
      nativeId: path.basename(source.sourceFilePath, '.jsonl'),
      routeId: `claude:${path.basename(source.sourceFilePath, '.jsonl')}`,
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
      toolsUsed: {},
      compaction: { compactions: 0, microcompactions: 0, totalTokensSaved: 0, compactionTimestamps: [] },
    };
  }

  function makeProvider(parserVersion = 'parser-v1') {
    const buildSessionSummary = vi.fn(async (source: SessionSummarySource) => summaryFor(source));
    const provider: AgentDataProvider = {
      kind: 'claude',
      parserVersion,
      getProjects: vi.fn(),
      getSessions: vi.fn(),
      getProjectSessions: vi.fn(),
      getSessionDetail: vi.fn(),
      searchSessions: vi.fn(),
      getDashboardStats: vi.fn(),
      discoverSessionSources: vi.fn(async () => [sourceFor(filePath, parserVersion)]),
      buildSessionSummary,
    };
    return { provider, buildSessionSummary };
  }

  beforeEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(filePath, 'one');
    process.env.CLAUD_OMETER_CACHE_DIR = root;
    resetSessionSummaryStoreForTests();
  });

  afterEach(() => {
    clearSessionSummaryCache();
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.CLAUD_OMETER_CACHE_DIR;
  });

  it('parses once and reuses memory cache for unchanged sources', async () => {
    const { provider, buildSessionSummary } = makeProvider();

    await expect(getCachedSessionSummaries([provider])).resolves.toHaveLength(1);
    await expect(getCachedSessionSummaries([provider])).resolves.toHaveLength(1);

    expect(buildSessionSummary).toHaveBeenCalledTimes(1);
  });

  it('reuses persistent cache after memory reset', async () => {
    const first = makeProvider();
    await getCachedSessionSummaries([first.provider]);
    resetSessionSummaryStoreForTests();

    const second = makeProvider();
    await expect(getCachedSessionSummaries([second.provider])).resolves.toHaveLength(1);

    expect(second.buildSessionSummary).not.toHaveBeenCalled();
  });

  it('rebuilds only when the source signature changes', async () => {
    const first = makeProvider();
    await getCachedSessionSummaries([first.provider]);
    fs.appendFileSync(filePath, 'two');
    resetSessionSummaryStoreForTests();

    const second = makeProvider();
    await getCachedSessionSummaries([second.provider]);

    expect(second.buildSessionSummary).toHaveBeenCalledTimes(1);
  });

  it('shares concurrent in-flight rebuilds', async () => {
    const { provider, buildSessionSummary } = makeProvider();

    await Promise.all([
      getCachedSessionSummaries([provider]),
      getCachedSessionSummaries([provider]),
    ]);

    expect(buildSessionSummary).toHaveBeenCalledTimes(1);
  });
});
