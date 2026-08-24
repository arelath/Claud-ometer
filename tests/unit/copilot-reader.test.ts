import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { calculateCostAllModes } from '@/config/pricing';
import { addCosts, zeroCosts } from '@/lib/claude-data/cost-utils';
import { getContextFileGroups } from '@/lib/context-files';
import { getSessionDiffSummary } from '@/lib/session-diff';

describe('Copilot reader', () => {
  const root = path.join(process.cwd(), '.test-artifacts', 'copilot-reader');
  const copilotDir = path.join(root, 'copilot');
  const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const workspaceHash = '48bc27b295ea103e3d172520b17fc2e5';

  async function loadReader() {
    vi.resetModules();
    process.env.AGENT_SCOPE_COPILOT_DIR = copilotDir;
    process.env.AGENT_SCOPE_IMPORT_DIR = path.join(root, 'import');
    return import('@/lib/agent-data/providers/copilot/reader');
  }

  beforeEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.cpSync(path.join(process.cwd(), 'tests', 'fixtures', 'copilot'), copilotDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.AGENT_SCOPE_COPILOT_DIR;
    delete process.env.AGENT_SCOPE_IMPORT_DIR;
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
      projectName: 'AgentScope',
      version: '0.46.2',
      model: 'gpt-5.4',
      totalInputTokens: 750,
      totalOutputTokens: 80,
      totalCacheReadTokens: 250,
    });
    expect(sessions.find(session => session.nativeId === 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')).toMatchObject({
      title: 'Summarize the cache design proposal.',
      version: '0.46.2',
      timestamp: '2026-05-02T05:33:20.000Z',
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

  it('detects nested Copilot subagent models without moving root usage', async () => {
    const subagentWorkspaceHash = '72d8e19acf1af4d01e06b9f707dfc26b';
    const subagentSessionId = '08ec8cef-9a73-4f60-a826-9d3ead54c662';
    const invocationId = 'call_ia5gsg5DcLkXb119ui39sMYy';
    const workspaceDir = path.join(copilotDir, 'workspaceStorage', subagentWorkspaceHash);
    const transcriptPath = path.join(
      workspaceDir,
      'GitHub.copilot-chat',
      'transcripts',
      `${subagentSessionId}.jsonl`,
    );
    const chatSessionPath = path.join(workspaceDir, 'chatSessions', `${subagentSessionId}.jsonl`);
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
    fs.mkdirSync(path.dirname(chatSessionPath), { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, 'workspace.json'), JSON.stringify({ folder: 'file:///D:/dev/TSE_pdykstra_ToolsSB1' }));

    const runSubagentResponse = {
      kind: 'toolInvocationSerialized',
      toolCallId: invocationId,
      toolId: 'runSubagent',
      toolSpecificData: {
        agentName: 'code-searcher',
        modelName: 'GPT-5.6 Luna',
      },
    };
    const nestedResponse = {
      kind: 'toolInvocationSerialized',
      toolCallId: 'call_nested_read',
      toolId: 'copilot_readFile',
      subAgentInvocationId: invocationId,
    };
    const responseSnapshot = [runSubagentResponse, nestedResponse];
    fs.writeFileSync(chatSessionPath, [
      {
        kind: 0,
        v: {
          version: 3,
          creationDate: 1787066400000,
          responderUsername: 'GitHub Copilot',
          sessionId: subagentSessionId,
          requests: [{
            requestId: 'request-root-sol',
            timestamp: 1787066401000,
            modelId: 'copilot/gpt-5.6-sol',
            message: { text: 'Trace the hook.' },
            response: responseSnapshot,
          }],
          inputState: {
            selectedModel: {
              identifier: 'copilot/gpt-5.6-sol',
              metadata: { id: 'gpt-5.6-sol', vendor: 'copilot' },
            },
          },
        },
      },
      { kind: 1, k: ['requests', 0, 'response'], v: responseSnapshot },
      { kind: 1, k: ['requests', 0, 'response'], v: responseSnapshot },
      {
        kind: 1,
        k: ['requests', 0, 'result'],
        v: {
          metadata: {
            summaries: [{
              usage: {
                prompt_tokens: 1000,
                completion_tokens: 80,
                total_tokens: 1080,
                prompt_tokens_details: { cached_tokens: 250 },
              },
            }],
          },
        },
      },
    ].map(record => JSON.stringify(record)).join('\n'));

    fs.writeFileSync(transcriptPath, [
      {
        type: 'session.start',
        data: { sessionId: subagentSessionId, copilotVersion: '0.61.0', startTime: '2026-08-18T14:20:00.000Z' },
        timestamp: '2026-08-18T14:20:00.000Z',
      },
      {
        type: 'user.message',
        data: { content: 'Trace the hook.' },
        timestamp: '2026-08-18T14:20:01.000Z',
      },
      {
        type: 'assistant.message',
        data: {
          messageId: 'assistant-root-sol',
          content: 'I will delegate repository discovery.',
          toolRequests: [{
            toolCallId: invocationId,
            name: 'runSubagent',
            arguments: JSON.stringify({ agentName: 'code-searcher' }),
          }],
        },
        timestamp: '2026-08-18T14:20:02.000Z',
      },
      {
        type: 'tool.execution_start',
        data: { toolCallId: invocationId, toolName: 'runSubagent', arguments: { agentName: 'code-searcher' } },
        timestamp: '2026-08-18T14:20:03.000Z',
      },
      {
        type: 'tool.execution_complete',
        data: { toolCallId: invocationId, success: true },
        timestamp: '2026-08-18T14:20:04.000Z',
      },
    ].map(record => JSON.stringify(record)).join('\n'));

    const reader = await loadReader();
    const { getCopilotChatSessionSummary } = await import('@/lib/agent-data/providers/copilot/chat-session');
    const chatSummary = getCopilotChatSessionSummary(chatSessionPath);
    const routeId = `copilot:${subagentWorkspaceHash}:${subagentSessionId}`;
    const detail = await reader.getSessionDetail(routeId);
    const source = (await reader.discoverSessionSummarySources()).find(
      item => (item.metadata as { nativeId?: string } | undefined)?.nativeId === subagentSessionId,
    )!;
    const lightweightSummary = reader.buildLightweightSessionSummary(source);
    const summary = await reader.buildSessionSummary(source);

    expect(chatSummary).toMatchObject({
      model: 'gpt-5.6-sol',
      models: ['gpt-5.6-sol', 'gpt-5.6-luna'],
      subagents: [{
        invocationId,
        requestIndex: 0,
        agentName: 'code-searcher',
        model: 'gpt-5.6-luna',
      }],
    });
    expect(Object.keys(chatSummary.modelUsage)).toEqual(['gpt-5.6-sol']);
    expect(detail).toMatchObject({
      id: routeId,
      nativeId: subagentSessionId,
      model: 'gpt-5.6-sol',
      models: ['gpt-5.6-sol', 'gpt-5.6-luna'],
      totalInputTokens: 750,
      totalOutputTokens: 80,
      totalCacheReadTokens: 250,
      sourceFilePaths: [transcriptPath, chatSessionPath],
    });
    expect(source.sourceFilePath).toBe(transcriptPath);
    expect(source.parserVersion).toBe('copilot-summary-v8');
    expect(lightweightSummary).toMatchObject({
      parserVersion: 'copilot-summary-v8',
      model: 'gpt-5.6-sol',
      models: ['gpt-5.6-sol', 'gpt-5.6-luna'],
    });
    expect(summary).toMatchObject({
      parserVersion: 'copilot-summary-v8',
      routeId,
      model: 'gpt-5.6-sol',
      models: ['gpt-5.6-sol', 'gpt-5.6-luna'],
      tokenTotals: { input: 750, output: 80, cacheRead: 250 },
    });
    expect(Object.keys(summary.modelUsage)).toEqual(['gpt-5.6-sol']);

    const rootAssistant = detail?.messages.find(message => message.role === 'assistant');
    expect(rootAssistant).toMatchObject({
      model: 'gpt-5.6-sol',
      usage: { input_tokens: 750, output_tokens: 80, cache_read_input_tokens: 250 },
    });
    expect(rootAssistant?.subagent).toBeUndefined();
    const subagentMessages = detail?.messages.filter(message => message.subagent) || [];
    expect(subagentMessages).toHaveLength(1);
    expect(subagentMessages[0]).toMatchObject({
      role: 'tool-result',
      model: 'gpt-5.6-luna',
      subagent: {
        id: invocationId,
        parentId: subagentSessionId,
        nickname: 'code-searcher',
        depth: 1,
      },
    });
    expect(subagentMessages[0]).not.toHaveProperty('usage');
    expect(subagentMessages[0]).not.toHaveProperty('estimatedCosts');
  });

  it('uses cumulative legacy Copilot shutdown usage for tokens and estimated cost', async () => {
    const sessionDir = path.join(copilotDir, 'session-state', 'legacy-session-1');
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, 'workspace.yaml'), 'id: legacy-session-1\ncwd: "D:/repo/legacy-app" # comment\n');
    const firstShutdown = {
      currentModel: 'gpt-4.1',
      tokenDetails: {
        input: { tokenCount: 10 },
        cache_read: { tokenCount: 100 },
        cache_write: { tokenCount: 20 },
        output: { tokenCount: 100 },
      },
      modelMetrics: {
        'gpt-4.1': {
          usage: { inputTokens: 130, outputTokens: 100, cacheReadTokens: 100, cacheWriteTokens: 20, reasoningTokens: 7 },
          tokenDetails: {
            input: { tokenCount: 10 },
            cache_read: { tokenCount: 100 },
            cache_write: { tokenCount: 20 },
            output: { tokenCount: 100 },
          },
        },
      },
    };
    const finalShutdown = {
      currentModel: 'copilot/claude-haiku-4.5',
      tokenDetails: {
        input: { tokenCount: 12 },
        cache_read: { tokenCount: 150 },
        cache_write: { tokenCount: 30 },
        output: { tokenCount: 125 },
      },
      modelMetrics: {
        'gpt-4.1': firstShutdown.modelMetrics['gpt-4.1'],
        'copilot/claude-haiku-4.5': {
          usage: { inputTokens: 62, outputTokens: 25, cacheReadTokens: 50, cacheWriteTokens: 10, reasoningTokens: 3 },
          tokenDetails: {
            input: { tokenCount: 2 },
            cache_read: { tokenCount: 50 },
            cache_write: { tokenCount: 10 },
            output: { tokenCount: 25 },
          },
        },
      },
    };
    fs.writeFileSync(path.join(sessionDir, 'events.jsonl'), [
      JSON.stringify({ type: 'session.model_change', timestamp: '2026-05-04T09:00:00.000Z', data: { newModel: 'gpt-4.1' } }),
      JSON.stringify({ type: 'user.message', timestamp: '2026-05-04T09:00:01.000Z', data: { content: 'Update the legacy app.' } }),
      JSON.stringify({
        type: 'assistant.message',
        timestamp: '2026-05-04T09:00:02.000Z',
        data: {
          messageId: 'legacy-msg-1',
          outputTokens: 40,
          toolRequests: [{ toolCallId: 'legacy-tool-1', name: 'read_file', arguments: JSON.stringify({ filePath: 'src/app.ts' }) }],
        },
      }),
      JSON.stringify({
        type: 'assistant.message',
        timestamp: '2026-05-04T09:00:03.000Z',
        data: { messageId: 'legacy-msg-2', outputTokens: 60 },
      }),
      JSON.stringify({ type: 'session.shutdown', timestamp: '2026-05-04T09:00:04.000Z', data: firstShutdown }),
      JSON.stringify({ type: 'session.resume', timestamp: '2026-05-04T09:01:00.000Z', data: {} }),
      JSON.stringify({ type: 'session.model_change', timestamp: '2026-05-04T09:01:01.000Z', data: { newModel: 'copilot/claude-haiku-4.5' } }),
      JSON.stringify({ type: 'user.message', timestamp: '2026-05-04T09:01:02.000Z', data: { content: 'Check the result.' } }),
      JSON.stringify({
        type: 'assistant.message',
        timestamp: '2026-05-04T09:01:03.000Z',
        data: { messageId: 'legacy-msg-3', outputTokens: 25 },
      }),
      JSON.stringify({ type: 'subagent.completed', timestamp: '2026-05-04T09:01:04.000Z', data: { totalTokens: 999_999 } }),
      JSON.stringify({ type: 'session.shutdown', timestamp: '2026-05-04T09:01:05.000Z', data: finalShutdown }),
      JSON.stringify({ type: 'session.shutdown', timestamp: '2026-05-04T09:01:06.000Z', data: finalShutdown }),
      JSON.stringify({ type: 'session.shutdown', timestamp: '2026-05-04T09:01:07.000Z', data: { tokenDetails: {} } }),
    ].join('\n'));

    const reader = await loadReader();
    const detail = await reader.getSessionDetail('copilot:legacy:legacy-session-1');
    const source = (await reader.discoverSessionSummarySources()).find(
      item => (item.metadata as { nativeId?: string } | undefined)?.nativeId === 'legacy-session-1',
    )!;
    const lightweightSummary = reader.buildLightweightSessionSummary(source);
    const summary = await reader.buildSessionSummary(source);
    const expectedCosts = addCosts(
      calculateCostAllModes('gpt-4.1', 10, 100, 20, 100),
      calculateCostAllModes('claude-haiku-4.5', 2, 25, 10, 50),
    );

    expect(detail).toMatchObject({
      id: 'copilot:legacy:legacy-session-1',
      agentKind: 'copilot',
      projectId: 'copilot:legacy:D-repo-legacy-app',
      projectName: 'legacy-app',
      model: 'claude-haiku-4.5',
      models: ['gpt-4.1', 'claude-haiku-4.5'],
      messageCount: 5,
      totalInputTokens: 12,
      totalOutputTokens: 125,
      totalCacheReadTokens: 150,
      totalCacheWriteTokens: 30,
      estimatedCosts: expectedCosts,
      toolCallCount: 1,
      toolsUsed: { Read: 1 },
    });
    expect(detail?.messages.map(message => message.role)).toEqual(['user', 'assistant', 'assistant', 'user', 'assistant']);
    expect(detail?.messages[1].usage).toEqual({
      input_tokens: 0,
      output_tokens: 40,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
    expect(detail?.messages[2].usage).toEqual({
      input_tokens: 10,
      output_tokens: 60,
      cache_creation_input_tokens: 20,
      cache_read_input_tokens: 100,
    });
    expect(detail?.messages[4].usage).toEqual({
      input_tokens: 2,
      output_tokens: 25,
      cache_creation_input_tokens: 10,
      cache_read_input_tokens: 50,
    });
    expect(detail?.messages.reduce(
      (costs, message) => addCosts(costs, message.estimatedCosts || zeroCosts()),
      zeroCosts(),
    )).toEqual(expectedCosts);
    expect(source.parserVersion).toBe('copilot-summary-v8');
    expect(lightweightSummary).toMatchObject({
      parserVersion: 'copilot-summary-v8',
      tokenTotals: { input: 12, output: 125, cacheRead: 150, cacheWrite: 30, reasoningOutput: 10 },
    });
    expect(summary).toMatchObject({
      parserVersion: 'copilot-summary-v8',
      tokenTotals: { input: 12, output: 125, cacheRead: 150, cacheWrite: 30, reasoningOutput: 10 },
      modelUsage: {
        'gpt-4.1': {
          inputTokens: 10,
          outputTokens: 100,
          cacheReadInputTokens: 100,
          cacheCreationInputTokens: 20,
          reasoningOutputTokens: 7,
        },
        'claude-haiku-4.5': {
          inputTokens: 2,
          outputTokens: 25,
          cacheReadInputTokens: 50,
          cacheCreationInputTokens: 10,
          reasoningOutputTokens: 3,
        },
      },
    });
    expect(summary.usageEvents?.reduce((totals, event) => ({
      input: totals.input + event.inputTokens,
      output: totals.output + event.outputTokens,
      cacheRead: totals.cacheRead + event.cacheReadTokens,
      cacheWrite: totals.cacheWrite + event.cacheWriteTokens,
      reasoningOutput: totals.reasoningOutput + (event.reasoningOutputTokens || 0),
    }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoningOutput: 0 })).toEqual({
      input: 12,
      output: 125,
      cacheRead: 150,
      cacheWrite: 30,
      reasoningOutput: 10,
    });
  });

  it('preserves output-only legacy usage when no valid shutdown summary exists', async () => {
    const sessionDir = path.join(copilotDir, 'session-state', 'legacy-session-no-shutdown');
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, 'workspace.yaml'), 'cwd: "D:/repo/legacy-app"\n');
    fs.writeFileSync(path.join(sessionDir, 'events.jsonl'), [
      JSON.stringify({ type: 'session.model_change', data: { newModel: 'gpt-4.1' } }),
      JSON.stringify({ type: 'user.message', data: { content: 'Keep the fallback.' } }),
      JSON.stringify({ type: 'assistant.message', data: { messageId: 'fallback', outputTokens: 150 } }),
      JSON.stringify({ type: 'session.shutdown', data: { tokenDetails: { output: { tokenCount: 150 } } } }),
    ].join('\n'));

    const reader = await loadReader();
    const detail = await reader.getSessionDetail('copilot:legacy:legacy-session-no-shutdown');

    expect(detail).toMatchObject({
      totalInputTokens: 0,
      totalOutputTokens: 150,
      totalCacheReadTokens: 0,
      totalCacheWriteTokens: 0,
    });
    expect(detail?.messages.at(-1)?.usage).toEqual({
      input_tokens: 0,
      output_tokens: 150,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
  });

  it('rejects stale, incompatible, and prototype-bearing legacy shutdown summaries', async () => {
    const tokenDetails = (input: number, output: number) => ({
      input: { tokenCount: input },
      cache_read: { tokenCount: 0 },
      cache_write: { tokenCount: 0 },
      output: { tokenCount: output },
    });
    const shutdown = (entries: Array<[string, number, number]>) => ({
      currentModel: entries.at(-1)?.[0],
      tokenDetails: tokenDetails(
        entries.reduce((total, [, input]) => total + input, 0),
        entries.reduce((total, [, , output]) => total + output, 0),
      ),
      modelMetrics: Object.fromEntries(entries.map(([model, input, output]) => [model, {
        usage: { inputTokens: input, outputTokens: output, reasoningTokens: 0 },
        tokenDetails: tokenDetails(input, output),
      }])),
    });
    const writeSession = (id: string, records: unknown[]) => {
      const sessionDir = path.join(copilotDir, 'session-state', id);
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.writeFileSync(path.join(sessionDir, 'workspace.yaml'), 'cwd: "D:/repo/legacy-app"\n');
      fs.writeFileSync(path.join(sessionDir, 'events.jsonl'), records.map(record => JSON.stringify(record)).join('\n'));
    };
    const modelChange = (model: string) => ({ type: 'session.model_change', data: { newModel: model } });
    const assistant = (messageId: string, outputTokens: number) => ({
      type: 'assistant.message',
      data: { messageId, outputTokens },
    });

    writeSession('legacy-stale-shutdown', [
      modelChange('gpt-4.1'),
      assistant('stale-before', 10),
      { type: 'session.shutdown', data: shutdown([['gpt-4.1', 3, 20]]) },
      { type: 'session.resume', data: {} },
      { type: 'user.message', data: { content: 'Continue after shutdown.' } },
      assistant('stale-after', 5),
    ]);
    writeSession('legacy-output-overage', [
      modelChange('gpt-4.1'),
      assistant('overage', 15),
      { type: 'session.shutdown', data: shutdown([['gpt-4.1', 4, 10]]) },
    ]);
    writeSession('legacy-missing-model', [
      modelChange('gpt-4.1'),
      assistant('known-model', 10),
      modelChange('claude-haiku-4.5'),
      assistant('missing-model', 5),
      { type: 'session.shutdown', data: shutdown([['gpt-4.1', 4, 15]]) },
    ]);
    writeSession('legacy-prototype-model', [
      modelChange('gpt-4.1'),
      assistant('prototype-model', 10),
      { type: 'session.shutdown', data: shutdown([['__proto__', 4, 10]]) },
    ]);

    const objectPrototype = Object.prototype as Record<string, unknown>;
    expect(objectPrototype.inputTokens).toBeUndefined();
    const reader = await loadReader();
    try {
      await expect(reader.getSessionDetail('copilot:legacy:legacy-stale-shutdown')).resolves.toMatchObject({
        totalInputTokens: 0,
        totalOutputTokens: 15,
      });
      await expect(reader.getSessionDetail('copilot:legacy:legacy-output-overage')).resolves.toMatchObject({
        totalInputTokens: 0,
        totalOutputTokens: 15,
      });
      await expect(reader.getSessionDetail('copilot:legacy:legacy-missing-model')).resolves.toMatchObject({
        totalInputTokens: 0,
        totalOutputTokens: 15,
      });
      await expect(reader.getSessionDetail('copilot:legacy:legacy-prototype-model')).resolves.toMatchObject({
        totalInputTokens: 0,
        totalOutputTokens: 10,
      });
      expect(objectPrototype.inputTokens).toBeUndefined();
      expect(objectPrototype.outputTokens).toBeUndefined();
      expect(objectPrototype.cacheReadInputTokens).toBeUndefined();
      expect(objectPrototype.cacheCreationInputTokens).toBeUndefined();
    } finally {
      delete objectPrototype.inputTokens;
      delete objectPrototype.outputTokens;
      delete objectPrototype.cacheReadInputTokens;
      delete objectPrototype.cacheCreationInputTokens;
      delete objectPrototype.reasoningOutputTokens;
    }
  });

  it('infers transcript model family and fallback tokens when no token sidecar exists', async () => {
    const fallbackSessionId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const transcriptPath = path.join(
      copilotDir,
      'workspaceStorage',
      workspaceHash,
      'GitHub.copilot-chat',
      'transcripts',
      `${fallbackSessionId}.jsonl`,
    );
    fs.writeFileSync(transcriptPath, [
      JSON.stringify({
        type: 'session.start',
        data: {
          sessionId: fallbackSessionId,
          producer: 'copilot-agent',
          copilotVersion: '0.46.2',
          startTime: '2026-05-04T09:30:00.000Z',
        },
        timestamp: '2026-05-04T09:30:00.000Z',
      }),
      JSON.stringify({ type: 'user.message', data: { content: 'check' }, timestamp: '2026-05-04T09:30:01.000Z' }),
      JSON.stringify({
        type: 'assistant.message',
        data: {
          messageId: 'fallback-msg-1',
          content: 'done',
          reasoningText: 'think',
          toolRequests: [{ toolCallId: 'call_openai_1', name: 'read_file', arguments: JSON.stringify({ filePath: 'src/app.ts' }) }],
        },
        timestamp: '2026-05-04T09:30:02.000Z',
      }),
    ].join('\n'));

    const reader = await loadReader();
    const detail = await reader.getSessionDetail(`copilot:${workspaceHash}:${fallbackSessionId}`);

    expect(detail).toMatchObject({
      model: 'copilot-openai-auto',
      models: ['copilot-openai-auto'],
      totalInputTokens: 2,
      totalOutputTokens: 1,
      toolCallCount: 1,
    });
    expect(detail?.messages[1]).toMatchObject({
      role: 'assistant',
      model: 'copilot-openai-auto',
      usage: {
        input_tokens: 2,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    });
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

  it('turns Copilot apply_patch tool input into modified-file diffs', async () => {
    const patchSessionId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const workspaceDir = path.join(copilotDir, 'workspaceStorage', workspaceHash);
    const transcriptPath = path.join(workspaceDir, 'GitHub.copilot-chat', 'transcripts', `${patchSessionId}.jsonl`);
    const chatSessionPath = path.join(workspaceDir, 'chatSessions', `${patchSessionId}.jsonl`);
    const patchInput = [
      '*** Begin Patch',
      '*** Update File: src/one.ts',
      '@@',
      '-export const enabled = false;',
      '+export const enabled = true;',
      '*** Add File: src/two.ts',
      '+export const added = true;',
      '*** End Patch',
    ].join('\n');

    fs.writeFileSync(transcriptPath, [
      {
        type: 'session.start',
        data: {
          sessionId: patchSessionId,
          producer: 'copilot-agent',
          copilotVersion: '0.46.2',
          startTime: '2026-05-04T10:00:00.000Z',
        },
        id: 'event-1',
        timestamp: '2026-05-04T10:00:00.000Z',
      },
      {
        type: 'user.message',
        data: { content: 'Patch two files.', attachments: [] },
        id: 'event-2',
        timestamp: '2026-05-04T10:00:01.000Z',
      },
      {
        type: 'assistant.message',
        data: {
          messageId: 'assistant-1',
          content: 'Applying the requested edits.',
          toolRequests: [{
            toolCallId: 'tool-patch-1',
            name: 'apply_patch',
            arguments: JSON.stringify({ explanation: 'Update fixtures.', input: patchInput }),
            type: 'function',
          }],
        },
        id: 'event-3',
        timestamp: '2026-05-04T10:00:02.000Z',
      },
      {
        type: 'tool.execution_start',
        data: {
          toolCallId: 'tool-patch-1',
          toolName: 'apply_patch',
          arguments: { explanation: 'Update fixtures.', input: patchInput },
        },
        id: 'event-4',
        timestamp: '2026-05-04T10:00:03.000Z',
      },
      {
        type: 'tool.execution_complete',
        data: { toolCallId: 'tool-patch-1', success: true },
        id: 'event-5',
        timestamp: '2026-05-04T10:00:04.000Z',
      },
    ].map(record => JSON.stringify(record)).join('\n'));
    fs.writeFileSync(chatSessionPath, JSON.stringify({
      kind: 0,
      v: {
        version: 3,
        creationDate: 1777802400000,
        responderUsername: 'GitHub Copilot',
        sessionId: patchSessionId,
        requests: [],
        inputState: {
          selectedModel: {
            identifier: 'copilot/gpt-5.4',
            metadata: { id: 'gpt-5.4', vendor: 'copilot' },
          },
        },
      },
    }));

    const reader = await loadReader();
    const detail = await reader.getSessionDetail(`copilot:${workspaceHash}:${patchSessionId}`);

    expect(detail).toMatchObject({
      id: `copilot:${workspaceHash}:${patchSessionId}`,
      toolCallCount: 1,
      toolsUsed: { apply_patch: 1 },
    });

    const patchTool = detail?.messages.flatMap(message => message.toolCalls || []).find(tool => tool.name === 'apply_patch');
    expect(patchTool?.details.find(detail => detail.key === 'file_path')?.value).toBe('src/one.ts\nsrc/two.ts');
    expect(patchTool?.artifact?.edits?.map(edit => edit.path)).toEqual(['src/one.ts', 'src/two.ts']);

    const diffSummary = getSessionDiffSummary(detail!.messages);
    expect(diffSummary).toMatchObject({
      fileCount: 2,
      editCount: 2,
      addedLines: 2,
      removedLines: 1,
    });
    expect(diffSummary.files.map(file => file.path).sort()).toEqual(['src/one.ts', 'src/two.ts']);
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
      changeTotals: {
        addedLines: 1,
        removedLines: 1,
        netLineDelta: 0,
        changedLines: 2,
        fileCount: 1,
        editCount: 1,
      },
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

  it('includes chat-only metadata in summary search text', async () => {
    const reader = await loadReader();
    const source = (await reader.discoverSessionSummarySources()).find(item => item.sourceFilePath.includes('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'));

    const summary = await reader.buildSessionSummary(source!);

    expect(summary.searchTextPreview).toContain('summarize the cache design proposal.');
    expect(summary.searchTextPreview).toContain('0.46.2');
  });
});
