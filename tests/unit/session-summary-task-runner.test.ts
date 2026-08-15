import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentKind } from '@/lib/agent-data/types';
import type { CachedSessionSummary, SessionSummarySource } from '@/lib/agent-data/session-summary';

describe('session summary task runner', () => {
  const root = path.join(process.cwd(), '.test-artifacts', 'session-summary-task-runner');
  const fixturesRoot = path.join(process.cwd(), 'tests', 'fixtures');

  afterEach(() => {
    delete process.env.AGENT_SCOPE_CODEX_DIR;
    delete process.env.AGENT_SCOPE_COPILOT_DIR;
    delete process.env.AGENT_SCOPE_CURSOR_DIR;
    delete process.env.AGENT_SCOPE_CURSOR_USER_DIR;
    delete process.env.AGENT_SCOPE_IMPORT_DIR;
    vi.resetModules();
  });

  async function expectStaticTaskMatchesDirectBuild(
    provider: AgentKind,
    source: SessionSummarySource,
    directSummary: CachedSessionSummary,
  ): Promise<void> {
    const { runParseSummaryTask } = await import('@/lib/agent-data/session-summary-task-runner');

    const result = await runParseSummaryTask({
      provider,
      source,
      mode: 'full',
    });

    expect(result.error).toBeUndefined();
    expect(result).toMatchObject({
      sourceKey: `${provider}:${source.sourceFilePath}`,
      provider,
      mode: 'full',
    });
    expect(result.summary).toEqual(directSummary);
  }

  it('builds Codex summaries through the static provider-kind path', async () => {
    process.env.AGENT_SCOPE_CODEX_DIR = path.join(fixturesRoot, 'codex');
    process.env.AGENT_SCOPE_IMPORT_DIR = path.join(root, 'import');
    vi.resetModules();
    const reader = await import('@/lib/agent-data/providers/codex/reader');
    const [source] = await reader.discoverSessionSummarySources();
    const directSummary = await reader.buildSessionSummary(source);

    await expectStaticTaskMatchesDirectBuild('codex', source, directSummary);
  });

  it('builds Copilot summaries through the static provider-kind path', async () => {
    process.env.AGENT_SCOPE_COPILOT_DIR = path.join(fixturesRoot, 'copilot');
    process.env.AGENT_SCOPE_IMPORT_DIR = path.join(root, 'import');
    vi.resetModules();
    const reader = await import('@/lib/agent-data/providers/copilot/reader');
    const source = (await reader.discoverSessionSummarySources())
      .find(item => item.sourceFilePath.includes('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'));
    expect(source).toBeTruthy();
    const directSummary = await reader.buildSessionSummary(source!);

    await expectStaticTaskMatchesDirectBuild('copilot', source!, directSummary);
  });

  it('builds Cursor summaries through the static provider-kind path', async () => {
    process.env.AGENT_SCOPE_CURSOR_DIR = path.join(fixturesRoot, 'cursor');
    process.env.AGENT_SCOPE_CURSOR_USER_DIR = path.join(root, 'Cursor', 'User');
    process.env.AGENT_SCOPE_IMPORT_DIR = path.join(root, 'import');
    vi.resetModules();
    const reader = await import('@/lib/agent-data/providers/cursor/reader');
    const source = (await reader.discoverSessionSummarySources())
      .find(item => item.sourceFilePath.endsWith('cccccccc-cccc-4ccc-8ccc-cccccccccccc.jsonl'));
    expect(source).toBeTruthy();
    const directSummary = await reader.buildSessionSummary(source!);

    await expectStaticTaskMatchesDirectBuild('cursor', source!, directSummary);
  });
});
