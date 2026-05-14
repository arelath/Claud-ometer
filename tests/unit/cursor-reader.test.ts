import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('Cursor reader', () => {
  const root = path.join(process.cwd(), '.test-artifacts', 'cursor-reader');
  const cursorDir = path.join(root, 'cursor');
  const importDir = path.join(root, 'import');
  const projectId = 'd-dev-research-Claudometer';
  const sessionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

  async function loadReader() {
    vi.resetModules();
    process.env.CLAUD_OMETER_CURSOR_DIR = cursorDir;
    process.env.CLAUD_OMETER_IMPORT_DIR = importDir;
    return import('@/lib/agent-data/providers/cursor/reader');
  }

  beforeEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.cpSync(path.join(process.cwd(), 'tests', 'fixtures', 'cursor'), cursorDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.CLAUD_OMETER_CURSOR_DIR;
    delete process.env.CLAUD_OMETER_IMPORT_DIR;
    vi.resetModules();
  });

  it('returns parent Cursor transcripts with provider identity and project-qualified route ids', async () => {
    const reader = await loadReader();

    const sessions = await reader.getSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: `cursor:${projectId}:${sessionId}`,
      agentKind: 'cursor',
      nativeId: sessionId,
      projectId: `cursor:${projectId}`,
      projectName: 'Claudometer',
      title: 'Add a compact Cursor fixture for the dashboard.',
      messageCount: 4,
      userMessageCount: 2,
      assistantMessageCount: 2,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      model: 'unknown',
    });
  });

  it('parses Cursor transcript messages in order', async () => {
    const reader = await loadReader();

    const detail = await reader.getSessionDetail(`cursor:${projectId}:${sessionId}`);

    expect(detail).toMatchObject({
      id: `cursor:${projectId}:${sessionId}`,
      agentKind: 'cursor',
      messageCount: 4,
      userMessageCount: 2,
      assistantMessageCount: 2,
    });
    expect(detail?.messages.map(message => message.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(detail?.messages[2].content).toContain('Also include multiple content blocks.');
    expect(detail?.messages[2].content).toContain('This should remain in order.');
    expect(detail?.messages[1].usage).toMatchObject({ input_tokens: 0, output_tokens: 0 });
    expect(detail?.messages[3].usage).toMatchObject({ input_tokens: 0, output_tokens: 0 });
  });

  it('builds summaries with zero token and cost totals until Cursor exposes reliable usage data', async () => {
    const reader = await loadReader();
    const source = (await reader.discoverSessionSummarySources())[0];

    const summary = await reader.buildSessionSummary(source);

    expect(summary).toMatchObject({
      provider: 'cursor',
      nativeId: sessionId,
      routeId: `cursor:${projectId}:${sessionId}`,
      nativeProjectId: projectId,
      projectRouteId: `cursor:${projectId}`,
      messageCount: 4,
      toolCallCount: 0,
      model: 'unknown',
      models: [],
      tokenTotals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoningOutput: 0 },
      modelUsage: {},
    });
    expect(summary.searchTextPreview).toContain('compact cursor fixture');
  });
});
