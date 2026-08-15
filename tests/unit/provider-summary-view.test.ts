import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentDataProvider } from '@/lib/agent-data/provider';
import { getProviderSessionSummaries } from '@/lib/agent-data/provider-summary-view';
import {
  clearSessionSummaryCache,
  resetSessionSummaryStoreForTests,
} from '@/lib/agent-data/session-summary-store';
import {
  getQuickSessionIndexStatus,
  resetSessionIndexerForTests,
} from '@/lib/agent-data/indexer';
import { writeSessionSummaryCache } from '@/lib/agent-data/session-summary-cache';
import {
  SESSION_SUMMARY_CACHE_VERSION,
  type CachedSessionSummary,
  type SessionSummarySource,
} from '@/lib/agent-data/session-summary';

describe('provider summary view', () => {
  const root = path.join(process.cwd(), '.test-artifacts', 'provider-summary-view');
  const filePath = path.join(root, 'session.jsonl');

  function sourceFor(parserVersion: string): SessionSummarySource {
    const stat = fs.statSync(filePath);
    return {
      provider: 'codex',
      parserVersion,
      sourceFilePath: filePath,
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
      nativeId: 'session',
      routeId: 'codex:session',
      nativeProjectId: 'project',
      projectRouteId: 'codex:project',
      projectName: 'Project',
      sourceFilePath: source.sourceFilePath,
      sourceSignature: source.sourceSignature,
      createdAt: '2026-05-08T10:00:00.000Z',
      updatedAt: '2026-05-08T10:00:01.000Z',
      title: 'Session',
      cwd: 'D:/repo',
      gitBranch: '',
      version: '',
      model: 'unknown',
      models: [],
      messageCount: 1,
      userMessageCount: 1,
      assistantMessageCount: 0,
      toolCallCount: 0,
      tokenTotals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      modelUsage: {},
      toolsUsed: {},
      compaction: { compactions: 0, microcompactions: 0, totalTokensSaved: 0, compactionTimestamps: [] },
    };
  }

  function makeProvider(
    parserVersion: string,
    buildSessionSummary: AgentDataProvider['buildSessionSummary'] = vi.fn(async source => summaryFor(source)),
  ): AgentDataProvider {
    return {
      kind: 'codex',
      parserVersion,
      getProjects: vi.fn(),
      getSessions: vi.fn(),
      getProjectSessions: vi.fn(),
      getSessionDetail: vi.fn(),
      searchSessions: vi.fn(),
      getDashboardStats: vi.fn(),
      discoverSessionSources: vi.fn(async () => [sourceFor(parserVersion)]),
      buildSessionSummary,
    };
  }

  beforeEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(filePath, 'one');
    process.env.AGENT_SCOPE_CACHE_DIR = root;
    resetSessionIndexerForTests();
    resetSessionSummaryStoreForTests();
  });

  afterEach(() => {
    clearSessionSummaryCache();
    resetSessionIndexerForTests();
    resetSessionSummaryStoreForTests();
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.AGENT_SCOPE_CACHE_DIR;
  });

  it('serves a non-empty indexed snapshot and refreshes in the background', async () => {
    writeSessionSummaryCache({
      cacheVersion: SESSION_SUMMARY_CACHE_VERSION,
      generatedAt: '2026-05-08T10:00:00.000Z',
      summaries: [summaryFor(sourceFor('parser-v1'))],
    });
    let resolveBuild!: (summary: CachedSessionSummary) => void;
    const buildPromise = new Promise<CachedSessionSummary>(resolve => {
      resolveBuild = resolve;
    });
    const buildSessionSummary = vi.fn(() => buildPromise);
    const provider = makeProvider('parser-v2', buildSessionSummary);

    const summaries = await getProviderSessionSummaries(provider);

    expect(summaries).toHaveLength(1);
    expect(summaries[0].parserVersion).toBe('parser-v1');
    expect(buildSessionSummary).not.toHaveBeenCalled();
    expect(getQuickSessionIndexStatus([provider])).toMatchObject({ status: 'refreshing' });

    await vi.waitFor(() => expect(buildSessionSummary).toHaveBeenCalledTimes(1));
    resolveBuild(summaryFor(sourceFor('parser-v2')));

    await vi.waitFor(() => {
      expect(getQuickSessionIndexStatus([provider])).toMatchObject({
        status: 'fresh',
        staleCount: 0,
      });
    });
  });

  it('builds summaries when no indexed snapshot exists yet', async () => {
    const buildSessionSummary = vi.fn(async source => summaryFor(source));
    const provider = makeProvider('parser-v1', buildSessionSummary);

    const summaries = await getProviderSessionSummaries(provider);

    expect(summaries).toHaveLength(1);
    expect(summaries[0].parserVersion).toBe('parser-v1');
    expect(buildSessionSummary).toHaveBeenCalledTimes(1);
  });
});
