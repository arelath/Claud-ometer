import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getContextFileGroups } from '@/lib/context-files';
import { getSessionDiffSummary } from '@/lib/session-diff';

describe('Copilot reader', () => {
  const root = path.join(process.cwd(), '.test-artifacts', 'copilot-reader');
  const copilotDir = path.join(root, 'copilot');
  const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const workspaceHash = '48bc27b295ea103e3d172520b17fc2e5';

  async function loadReader() {
    vi.resetModules();
    process.env.CLAUD_OMETER_COPILOT_DIR = copilotDir;
    process.env.CLAUD_OMETER_IMPORT_DIR = path.join(root, 'import');
    return import('@/lib/agent-data/providers/copilot/reader');
  }

  beforeEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.cpSync(path.join(process.cwd(), 'tests', 'fixtures', 'copilot'), copilotDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.CLAUD_OMETER_COPILOT_DIR;
    delete process.env.CLAUD_OMETER_IMPORT_DIR;
    vi.resetModules();
  });

  it('returns sessions with Copilot provider identity and workspace-qualified route ids', async () => {
    const reader = await loadReader();

    const sessions = await reader.getSessions();

    expect(sessions).toHaveLength(3);
    const transcriptSession = sessions.find(session => session.nativeId === sessionId);
    expect(transcriptSession).toMatchObject({
      id: `copilot:${workspaceHash}:${sessionId}`,
      agentKind: 'copilot',
      nativeId: sessionId,
      projectId: `copilot:${workspaceHash}`,
      projectName: 'Claud-ometer',
      version: '0.46.2',
      model: 'gpt-5.4',
      totalInputTokens: 750,
      totalOutputTokens: 80,
      totalCacheReadTokens: 250,
    });
  });

  it('discovers Copilot chat sessions even when no transcript sidecar exists', async () => {
    const reader = await loadReader();

    const detail = await reader.getSessionDetail(`copilot:${workspaceHash}:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb`);

    expect(detail).toMatchObject({
      id: `copilot:${workspaceHash}:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb`,
      agentKind: 'copilot',
      title: 'Summarize the cache design proposal.',
      messageCount: 2,
      userMessageCount: 1,
      assistantMessageCount: 1,
      model: 'claude-opus-4.6',
      totalInputTokens: 1500,
      totalOutputTokens: 120,
      totalCacheReadTokens: 500,
    });
    expect(detail?.messages.map(message => message.role)).toEqual(['user', 'assistant']);
    expect(detail?.messages[1].content).toContain('cache design proposal');
  });

  it('does not treat output-only completion token updates as complete Copilot usage', async () => {
    const filePath = path.join(root, 'completion-only-copilot.jsonl');
    fs.writeFileSync(filePath, [
      JSON.stringify({
        kind: 0,
        v: {
          version: 3,
          creationDate: 1777802000000,
          responderUsername: 'GitHub Copilot',
          sessionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          requests: [],
          inputState: {
            selectedModel: {
              identifier: 'copilot/gpt-5.4',
              metadata: { id: 'gpt-5.4', vendor: 'copilot', maxInputTokens: 271805, maxOutputTokens: 128000 },
            },
          },
        },
      }),
      JSON.stringify({
        kind: 2,
        k: ['requests'],
        v: [{
          requestId: 'completion-only-1',
          timestamp: 1777802001000,
          modelId: 'copilot/gpt-5.4',
          response: [],
          message: { text: 'Completion-only request.' },
        }],
      }),
      JSON.stringify({ kind: 2, k: ['requests', 0, 'response'], v: [{ value: 'Completion-only response.' }] }),
      JSON.stringify({ kind: 1, k: ['requests', 0, 'completionTokens'], v: 4321 }),
    ].join('\n'));

    const { getCopilotChatSessionSummary } = await import('@/lib/agent-data/providers/copilot/chat-session');

    const summary = getCopilotChatSessionSummary(filePath);

    expect(summary.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      reasoningOutputTokens: 0,
    });
    expect(summary.requests).toEqual([]);
    expect(summary.messages[1].usage).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
  });

  it('parses transcript messages, read file context, and edit artifacts', async () => {
    const reader = await loadReader();

    const detail = await reader.getSessionDetail(`copilot:${workspaceHash}:${sessionId}`);

    expect(detail).toMatchObject({
      id: `copilot:${workspaceHash}:${sessionId}`,
      agentKind: 'copilot',
      messageCount: 2,
      userMessageCount: 1,
      assistantMessageCount: 1,
      toolCallCount: 2,
      toolsUsed: { Read: 1, Edit: 1 },
    });
    expect(detail?.messages.map(message => message.role)).toEqual([
      'user',
      'assistant',
      'tool-result',
      'tool-result',
    ]);
    expect(detail?.messages[1]).toMatchObject({
      role: 'assistant',
      model: 'gpt-5.4',
      usage: {
        input_tokens: 750,
        output_tokens: 80,
        cache_read_input_tokens: 250,
      },
    });

    const contextFiles = getContextFileGroups(detail!.messages);
    expect(contextFiles.referenced).toEqual([
      expect.objectContaining({
        fullPath: 'src/app/sessions/[id]/page.tsx',
        loadedRanges: [{ start: 1, end: 80 }],
      }),
    ]);

    const diffSummary = getSessionDiffSummary(detail!.messages);
    expect(diffSummary).toMatchObject({
      fileCount: 1,
      editCount: 1,
      addedLines: 1,
      removedLines: 1,
    });
  });

  it('assigns Copilot request usage to the final assistant event in each request group', async () => {
    const reader = await loadReader();
    const detail = await reader.getSessionDetail(`copilot:${workspaceHash}:cccccccc-cccc-4ccc-8ccc-cccccccccccc`);

    expect(detail).toMatchObject({
      agentKind: 'copilot',
      messageCount: 6,
      userMessageCount: 2,
      assistantMessageCount: 4,
      model: 'gpt-5.4',
      totalInputTokens: 500,
      totalOutputTokens: 80,
      totalCacheReadTokens: 300,
    });
    expect(detail?.messages.map(message => message.role)).toEqual([
      'user',
      'assistant',
      'assistant',
      'user',
      'assistant',
      'assistant',
    ]);
    expect(detail?.messages[1].usage).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
    expect(detail?.messages[2].usage).toEqual({
      input_tokens: 200,
      output_tokens: 30,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 100,
    });
    expect(detail?.messages[4].usage).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
    expect(detail?.messages[5].usage).toEqual({
      input_tokens: 300,
      output_tokens: 50,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 200,
    });
  });

  it('builds summaries with message and tool counts', async () => {
    const reader = await loadReader();
    const source = (await reader.discoverSessionSummarySources()).find(item => item.sourceFilePath.includes(sessionId));

    const summary = await reader.buildSessionSummary(source!);

    expect(summary).toMatchObject({
      provider: 'copilot',
      nativeId: sessionId,
      routeId: `copilot:${workspaceHash}:${sessionId}`,
      nativeProjectId: workspaceHash,
      projectRouteId: `copilot:${workspaceHash}`,
      messageCount: 2,
      toolCallCount: 2,
      model: 'gpt-5.4',
      models: ['gpt-5.4'],
      tokenTotals: { input: 750, output: 80, cacheRead: 250, cacheWrite: 0, reasoningOutput: 20 },
      modelUsage: {
        'gpt-5.4': {
          inputTokens: 750,
          outputTokens: 80,
          cacheReadInputTokens: 250,
          reasoningOutputTokens: 20,
          contextWindow: 271805,
          maxOutputTokens: 128000,
        },
      },
    });
    expect(summary.searchTextPreview).toContain('session detail page');
  });
});
