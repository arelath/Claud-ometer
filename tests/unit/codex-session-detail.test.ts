import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSessionDiffSummary } from '@/lib/session-diff';
import type { CodexEnvelope } from '@/lib/agent-data/providers/codex/schema';

describe('Codex session detail parser', () => {
  const root = path.join(process.cwd(), '.test-artifacts', 'codex-session-detail');
  const codexDir = path.join(root, '.codex');

  async function loadReader() {
    vi.resetModules();
    process.env.AGENT_SCOPE_CODEX_DIR = codexDir;
    process.env.AGENT_SCOPE_IMPORT_DIR = path.join(root, 'import');
    return import('@/lib/agent-data/providers/codex/reader');
  }

  beforeEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.cpSync(path.join(process.cwd(), 'tests', 'fixtures', 'codex'), codexDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.AGENT_SCOPE_CODEX_DIR;
    delete process.env.AGENT_SCOPE_IMPORT_DIR;
  });

  it('emits normalized transcript rows and metadata', async () => {
    const reader = await loadReader();

    const detail = await reader.getSessionDetail('codex:00000000-0000-0000-0000-000000000001');

    expect(detail).toMatchObject({
      agentKind: 'codex',
      nativeId: '00000000-0000-0000-0000-000000000001',
      cwd: 'D:\\dev\\research\\AgentScope',
      model: 'gpt-5.5',
      gitBranch: 'main',
      compaction: { compactions: 1 },
    });
    expect(detail?.messages.map(message => message.role)).toEqual(expect.arrayContaining([
      'user',
      'system',
      'assistant',
      'tool-use',
      'tool-result',
    ]));
    expect(detail?.messages.some(message => message.blocks?.some(block => block.type === 'thinking'))).toBe(true);
    expect(detail?.messages.some(message => message.content.includes('image input omitted'))).toBe(true);
    expect(detail?.messages.some(message => message.blocks?.some(block => block.summary === 'Reasoning event summary from a safe fixture.'))).toBe(true);
    expect(JSON.stringify(detail?.messages)).not.toContain('redacted-fixture');
    expect(detail?.messages.filter(message => message.content === 'I will add a Codex provider and parser.')).toHaveLength(1);
    expect(detail?.messages.some(message => message.content.includes('Tests passed from response output'))).toBe(false);
  });

  it('builds Codex cache summaries without rendering full transcript details', async () => {
    const reader = await loadReader();

    const [source] = await reader.discoverSessionSummarySources();
    const summary = await reader.buildSessionSummary(source);

    expect(summary).toMatchObject({
      provider: 'codex',
      nativeId: '00000000-0000-0000-0000-000000000001',
      messageCount: 3,
      userMessageCount: 2,
      assistantMessageCount: 1,
      toolCallCount: 2,
      tokenTotals: {
        input: 125,
        output: 18,
        cacheRead: 25,
        cacheWrite: 0,
        reasoningOutput: 5,
      },
      changeTotals: {
        addedLines: 1,
        removedLines: 1,
        netLineDelta: 0,
        changedLines: 2,
        fileCount: 1,
        editCount: 1,
      },
      compaction: { compactions: 1 },
    });
    expect(summary.searchTextPreview).toContain('fixture user text');
  });

  it('keeps a subagent own identity when inherited history contains parent metadata', async () => {
    const childId = '11111111-1111-4111-8111-111111111111';
    const parentId = '22222222-2222-4222-8222-222222222222';
    const sessionsDir = path.join(codexDir, 'sessions', '2026', '05', '09');
    const filePath = path.join(sessionsDir, `rollout-2026-05-09T10-00-00-${childId}.jsonl`);
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(filePath, [
      JSON.stringify({
        timestamp: '2026-05-09T10:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: childId,
          originator: 'codex_cli',
          cwd: 'D:/repo/child',
          cli_version: '1.0.0',
          git: { branch: 'child-branch' },
        },
      }),
      JSON.stringify({
        timestamp: '2026-05-09T10:00:01.000Z',
        type: 'turn_context',
        payload: { cwd: 'D:/repo/child', model: 'gpt-5.5' },
      }),
      JSON.stringify({
        timestamp: '2026-05-09T10:00:02.000Z',
        type: 'session_meta',
        payload: {
          id: parentId,
          cwd: 'D:/repo/parent',
          cli_version: '0.9.0',
          git: { branch: 'parent-branch' },
        },
      }),
      JSON.stringify({
        timestamp: '2026-05-09T10:00:03.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'child result' }] },
      }),
    ].join('\n'));
    const reader = await loadReader();

    const source = (await reader.discoverSessionSummarySources())
      .find(item => item.sourceFilePath === filePath);
    expect(source).toBeTruthy();
    const summary = await reader.buildSessionSummary(source!);
    const detail = await reader.getSessionDetail(`codex:${childId}`);

    expect(summary).toMatchObject({
      nativeId: childId,
      routeId: `codex:${childId}`,
      cwd: 'D:/repo/child',
      version: '1.0.0',
      gitBranch: 'child-branch',
    });
    expect(detail).toMatchObject({
      nativeId: childId,
      routeId: `codex:${childId}`,
      cwd: 'D:/repo/child',
      version: '1.0.0',
      gitBranch: 'child-branch',
    });
    await expect(reader.getSessionDetail(`codex:${parentId}`)).resolves.toBeNull();
  });

  it('folds an explicit subagent into its parent with rebased usage and marked messages', async () => {
    const parentId = '00000000-0000-0000-0000-000000000001';
    const childId = '33333333-3333-4333-8333-333333333333';
    const nestedId = '44444444-4444-4444-8444-444444444444';
    const sessionsDir = path.join(codexDir, 'sessions', '2026', '05', '09');
    const filePath = path.join(sessionsDir, `rollout-2026-05-09T11-00-00-${childId}.jsonl`);
    const nestedFilePath = path.join(sessionsDir, `rollout-2026-05-09T11-01-00-${nestedId}.jsonl`);
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(filePath, [
      JSON.stringify({
        timestamp: '2026-05-09T11:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: childId,
          session_id: parentId,
          parent_thread_id: parentId,
          forked_from_id: parentId,
          agent_nickname: 'Faraday',
          agent_role: 'code_searcher',
          agent_path: '/root/search',
          originator: 'codex_cli',
          cwd: 'D:/repo/child',
        },
      }),
      JSON.stringify({ timestamp: '2026-05-09T11:00:00.001Z', type: 'session_meta', payload: { id: parentId, cwd: 'D:/repo/parent' } }),
      JSON.stringify({ timestamp: '2026-05-09T11:00:00.002Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'inherited parent text' }] } }),
      JSON.stringify({
        timestamp: '2026-05-09T11:00:00.003Z',
        type: 'event_msg',
        payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 20 } } },
      }),
      JSON.stringify({ timestamp: '2026-05-09T11:00:00.004Z', type: 'turn_context', payload: { model: 'gpt-5.5', cwd: 'D:/repo/child' } }),
      JSON.stringify({
        timestamp: '2026-05-09T11:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'agent_message',
          content: [{ type: 'input_text', text: 'Message Type: NEW_TASK\nTask name: /root/search\nSender: /root\nPayload:\ninspect child code' }],
        },
      }),
      JSON.stringify({ timestamp: '2026-05-09T11:00:02.000Z', type: 'event_msg', payload: { type: 'agent_message', message: 'child answer' } }),
      JSON.stringify({ timestamp: '2026-05-09T11:00:02.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'child answer' }] } }),
      JSON.stringify({
        timestamp: '2026-05-09T11:00:03.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: { input_tokens: 30, cached_input_tokens: 10, output_tokens: 5 },
            total_token_usage: { input_tokens: 130, cached_input_tokens: 30, output_tokens: 25 },
          },
        },
      }),
    ].join('\n'));
    fs.writeFileSync(nestedFilePath, [
      JSON.stringify({
        timestamp: '2026-05-09T11:01:00.000Z',
        type: 'session_meta',
        payload: {
          id: nestedId,
          session_id: childId,
          parent_thread_id: childId,
          agent_nickname: 'Noether',
          agent_role: 'code_reviewer',
          originator: 'codex_cli',
          cwd: 'D:/repo/child',
        },
      }),
      JSON.stringify({ timestamp: '2026-05-09T11:01:00.000Z', type: 'event_msg', payload: { type: 'task_started' } }),
      JSON.stringify({ timestamp: '2026-05-09T11:01:00.000Z', type: 'inter_agent_communication_metadata', payload: { trigger_turn: true } }),
      JSON.stringify({
        timestamp: '2026-05-09T11:01:00.001Z',
        type: 'response_item',
        payload: {
          type: 'agent_message',
          author: '/root',
          recipient: '/root/search',
          content: [{ type: 'input_text', text: 'Message Type: NEW_TASK\nTask name: /root/search\nSender: /root\nPayload:\nancestor task must not repeat' }],
        },
      }),
      JSON.stringify({ timestamp: '2026-05-09T11:01:00.002Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ancestor answer must not repeat' }] } }),
      JSON.stringify({
        timestamp: '2026-05-09T11:01:00.003Z',
        type: 'event_msg',
        payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 150, cached_input_tokens: 40, output_tokens: 30 } } },
      }),
      JSON.stringify({ timestamp: '2026-05-09T11:01:00.004Z', type: 'turn_context', payload: { model: 'gpt-5.5', cwd: 'D:/repo/child' } }),
      JSON.stringify({ timestamp: '2026-05-09T11:01:00.500Z', type: 'event_msg', payload: { type: 'task_started' } }),
      JSON.stringify({ timestamp: '2026-05-09T11:01:00.750Z', type: 'inter_agent_communication_metadata', payload: { trigger_turn: true } }),
      JSON.stringify({
        timestamp: '2026-05-09T11:01:01.000Z',
        type: 'response_item',
        payload: {
          type: 'agent_message',
          author: '/root/search',
          recipient: '/root/search/review',
          content: [{ type: 'input_text', text: 'Message Type: NEW_TASK\nTask name: /root/search/review\nSender: /root/search\nPayload:\nreview nested code' }],
        },
      }),
      JSON.stringify({ timestamp: '2026-05-09T11:01:02.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'nested review answer' }] } }),
      JSON.stringify({
        timestamp: '2026-05-09T11:01:03.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: { total_token_usage: { input_tokens: 160, cached_input_tokens: 42, output_tokens: 33 } },
        },
      }),
    ].join('\n'));
    const reader = await loadReader();

    const sessions = await reader.getSessions();
    const detail = await reader.getSessionDetail(`codex:${parentId}`);
    const sources = await reader.discoverSessionSummarySources();
    const summary = await reader.buildSessionSummary(sources[0]);

    expect(sessions).toHaveLength(1);
    expect(await reader.getSessionDetail(`codex:${childId}`)).toBeNull();
    expect(await reader.getSessionDetail(`codex:${nestedId}`)).toBeNull();
    expect(detail).toMatchObject({
      nativeId: parentId,
      messageCount: 7,
      userMessageCount: 4,
      assistantMessageCount: 3,
      totalInputTokens: 153,
      totalCacheReadTokens: 37,
      totalOutputTokens: 26,
    });
    expect(detail?.sourceFilePaths).toHaveLength(3);
    expect(detail?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'user', content: 'inspect child code', subagent: expect.objectContaining({ nickname: 'Faraday', role: 'code_searcher' }) }),
      expect.objectContaining({ role: 'assistant', content: 'child answer', subagent: expect.objectContaining({ id: childId, path: '/root/search' }) }),
      expect.objectContaining({ role: 'user', content: 'review nested code', subagent: expect.objectContaining({ id: nestedId, depth: 2 }) }),
      expect.objectContaining({ role: 'assistant', content: 'nested review answer', subagent: expect.objectContaining({ nickname: 'Noether', depth: 2 }) }),
    ]));
    expect(JSON.stringify(detail?.messages)).not.toContain('inherited parent text');
    expect(JSON.stringify(detail?.messages)).not.toContain('ancestor task must not repeat');
    expect(JSON.stringify(detail?.messages)).not.toContain('ancestor answer must not repeat');
    expect(summary).toMatchObject({ messageCount: 7, sourceFilePaths: expect.any(Array) });
    expect(summary.sourceFilePaths).toHaveLength(3);
  });

  it('renders errors and compactions as visible system events', async () => {
    const reader = await loadReader();
    const detail = await reader.getSessionDetail('00000000-0000-0000-0000-000000000001');

    expect(detail?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'system', content: 'Context compacted' }),
      expect.objectContaining({ role: 'system', content: 'fixture abort example' }),
    ]));
  });

  it('deduplicates paired Codex compaction records', async () => {
    const { parseCodexRecords } = await import('@/lib/agent-data/providers/codex/transcript-parser');
    const records: CodexEnvelope[] = [
      { timestamp: '2026-05-08T10:00:00.000Z', type: 'session_meta', payload: { id: 'compacted', cwd: 'D:/repo' } },
      { timestamp: '2026-05-08T10:00:01.000Z', type: 'turn_context', payload: { model: 'gpt-5.5', cwd: 'D:/repo' } },
      { timestamp: '2026-05-08T10:00:02.000Z', type: 'compacted', payload: {} },
      { timestamp: '2026-05-08T10:00:02.004Z', type: 'event_msg', payload: { kind: 'context_compacted', trigger: 'manual', pre_tokens: 120000 } },
    ];

    const parsed = parseCodexRecords('D:/repo/compacted.jsonl', records);
    const compactionMessages = parsed.detail.messages.filter(message => message.content === 'Context compacted');

    expect(parsed.detail.compaction.compactions).toBe(1);
    expect(parsed.detail.compaction.compactionTimestamps).toHaveLength(1);
    expect(compactionMessages).toHaveLength(1);
    expect(compactionMessages[0].blocks?.[0].details).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'trigger', value: 'manual' }),
    ]));
  });

  it('attaches Codex last-token usage and cost to the assistant turn', async () => {
    const { parseCodexRecords } = await import('@/lib/agent-data/providers/codex/transcript-parser');
    const records: CodexEnvelope[] = [
      { timestamp: '2026-05-08T10:00:00.000Z', type: 'session_meta', payload: { id: 'window', cwd: 'D:/repo' } },
      { timestamp: '2026-05-08T10:00:01.000Z', type: 'turn_context', payload: { model: 'gpt-5.5', cwd: 'D:/repo' } },
      {
        timestamp: '2026-05-08T10:00:02.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] },
      },
      {
        timestamp: '2026-05-08T10:00:03.000Z',
        type: 'event_msg',
        payload: {
          kind: 'token_count',
          info: {
            last_token_usage: {
              input_tokens: 100,
              cached_input_tokens: 80,
              output_tokens: 12,
              reasoning_output_tokens: 4,
            },
            total_token_usage: {
              input_tokens: 900,
              cached_input_tokens: 700,
              output_tokens: 120,
              reasoning_output_tokens: 40,
            },
          },
        },
      },
    ];

    const parsed = parseCodexRecords('D:/repo/window.jsonl', records);
    const assistant = parsed.detail.messages.find(message => message.role === 'assistant' && message.content === 'done');

    expect((parsed as unknown as { records?: unknown }).records).toBeUndefined();
    expect(assistant?.promptBreakdown).toMatchObject({
      totalTokens: 100,
      conversationTokens: 20,
      cacheReadTokens: 80,
    });
    expect(assistant?.usage).toMatchObject({
      input_tokens: 20,
      cache_read_input_tokens: 80,
      output_tokens: 12,
      cache_creation_input_tokens: 0,
    });
    expect(assistant?.estimatedCosts?.api).toBeGreaterThan(0);
    expect(parsed.info.totalInputTokens).toBe(200);
    expect(parsed.info.totalCacheReadTokens).toBe(700);
  });

  it('attaches cumulative token deltas when last-token usage is absent', async () => {
    const { parseCodexRecords } = await import('@/lib/agent-data/providers/codex/transcript-parser');
    const records: CodexEnvelope[] = [
      { timestamp: '2026-05-08T10:00:00.000Z', type: 'session_meta', payload: { id: 'cumulative', cwd: 'D:/repo' } },
      { timestamp: '2026-05-08T10:00:01.000Z', type: 'turn_context', payload: { model: 'gpt-5.5', cwd: 'D:/repo' } },
      {
        timestamp: '2026-05-08T10:00:02.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'first' }] },
      },
      {
        timestamp: '2026-05-08T10:00:03.000Z',
        type: 'event_msg',
        payload: {
          kind: 'token_count',
          info: { total_token_usage: { input_tokens: 20, cached_input_tokens: 5, output_tokens: 7, reasoning_output_tokens: 1 } },
        },
      },
      {
        timestamp: '2026-05-08T10:00:04.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'second' }] },
      },
      {
        timestamp: '2026-05-08T10:00:05.000Z',
        type: 'event_msg',
        payload: {
          kind: 'token_count',
          info: { total_token_usage: { input_tokens: 32, cached_input_tokens: 9, output_tokens: 11, reasoning_output_tokens: 3 } },
        },
      },
    ];

    const parsed = parseCodexRecords('D:/repo/cumulative.jsonl', records);
    const assistants = parsed.detail.messages.filter(message => message.role === 'assistant');

    expect(assistants[0].usage).toMatchObject({ input_tokens: 15, cache_read_input_tokens: 5, output_tokens: 7 });
    expect(assistants[1].usage).toMatchObject({ input_tokens: 8, cache_read_input_tokens: 4, output_tokens: 4 });
    expect(parsed.info.totalInputTokens).toBe(23);
    expect(parsed.info.totalCacheReadTokens).toBe(9);
    expect(parsed.info.totalOutputTokens).toBe(11);
  });

  it('estimates Codex tokens from text when no token records exist', async () => {
    const { parseCodexRecords } = await import('@/lib/agent-data/providers/codex/transcript-parser');
    const records: CodexEnvelope[] = [
      { timestamp: '2026-05-08T10:00:00.000Z', type: 'session_meta', payload: { id: 'estimated', cwd: 'D:/repo' } },
      { timestamp: '2026-05-08T10:00:01.000Z', type: 'turn_context', payload: { model: 'gpt-5.5', cwd: 'D:/repo' } },
      { timestamp: '2026-05-08T10:00:02.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '12345678' }] } },
      { timestamp: '2026-05-08T10:00:03.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '123456789' }] } },
    ];

    const parsed = parseCodexRecords('D:/repo/estimated.jsonl', records);

    expect(parsed.info.totalInputTokens).toBe(2);
    expect(parsed.info.totalOutputTokens).toBe(3);
    expect(parsed.info.totalCacheReadTokens).toBe(0);
    expect(parsed.info.estimatedCosts.api).toBeGreaterThan(0);
  });

  it('keeps explicit zero cumulative token records at zero', async () => {
    const { parseCodexRecords } = await import('@/lib/agent-data/providers/codex/transcript-parser');
    const records: CodexEnvelope[] = [
      { timestamp: '2026-05-08T10:00:00.000Z', type: 'session_meta', payload: { id: 'zero', cwd: 'D:/repo' } },
      { timestamp: '2026-05-08T10:00:01.000Z', type: 'turn_context', payload: { model: 'gpt-5.5', cwd: 'D:/repo' } },
      { timestamp: '2026-05-08T10:00:02.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'text that would otherwise estimate' }] } },
      {
        timestamp: '2026-05-08T10:00:03.000Z',
        type: 'event_msg',
        payload: {
          kind: 'token_count',
          info: { total_token_usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 } },
        },
      },
    ];

    const parsed = parseCodexRecords('D:/repo/zero.jsonl', records);

    expect(parsed.info.totalInputTokens).toBe(0);
    expect(parsed.info.totalOutputTokens).toBe(0);
    expect(parsed.info.totalCacheReadTokens).toBe(0);
  });

  it('feeds Codex apply_patch artifacts into the Changes diff summary', async () => {
    const reader = await loadReader();
    const detail = await reader.getSessionDetail('00000000-0000-0000-0000-000000000001');

    const summary = getSessionDiffSummary(detail?.messages || []);

    expect(summary.files).toHaveLength(1);
    expect(summary.files[0]).toMatchObject({
      path: 'src/example.ts',
      editCount: 1,
    });
    expect(summary.addedLines).toBe(1);
    expect(summary.removedLines).toBe(1);
  });

  it('feeds legacy Codex apply_patch input artifacts into the Changes diff summary', async () => {
    const { parseCodexRecords } = await import('@/lib/agent-data/providers/codex/transcript-parser');
    const patchInput = [
      '*** Begin Patch',
      '*** Update File: d:\\dev\\repo\\src\\app.ts',
      '@@',
      '-export const enabled = false;',
      '+export const enabled = true;',
      '*** End Patch',
    ].join('\n');
    const records: CodexEnvelope[] = [
      { timestamp: '2026-04-18T02:05:00.000Z', type: 'session_meta', payload: { id: 'legacy-patch', cwd: 'D:/repo' } },
      { timestamp: '2026-04-18T02:05:01.000Z', type: 'turn_context', payload: { model: 'gpt-5.5', cwd: 'D:/repo' } },
      { timestamp: '2026-04-18T02:05:02.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: 'patch-legacy', input: patchInput } },
      {
        timestamp: '2026-04-18T02:05:03.000Z',
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output',
          call_id: 'patch-legacy',
          output: '{"output":"Success. Updated the following files:\\nM d:\\\\dev\\\\repo\\\\src\\\\app.ts\\n"}',
        },
      },
    ];

    const parsed = parseCodexRecords('D:/repo/legacy-patch.jsonl', records);
    const summary = getSessionDiffSummary(parsed.detail.messages);

    expect(summary).toMatchObject({
      fileCount: 1,
      editCount: 1,
      addedLines: 1,
      removedLines: 1,
    });
    expect(summary.files[0].path).toBe('d:/dev/repo/src/app.ts');
  });

  it('feeds orphaned Desktop patch results into the Changes diff summary once', async () => {
    const { parseCodexRecords } = await import('@/lib/agent-data/providers/codex/transcript-parser');
    const patchResult: CodexEnvelope = {
      timestamp: '2026-08-15T19:09:24.000Z',
      type: 'event_msg',
      payload: {
        type: 'patch_apply_end',
        call_id: 'exec-36079e9a-cb99-41f6-8220-e570d681a02d',
        success: true,
        changes: {
          'D:\\dev\\repo\\src\\example.ts': {
            unified_diff: [
              'diff --git a/src/example.ts b/src/example.ts',
              '--- a/src/example.ts',
              '+++ b/src/example.ts',
              '@@ -1 +1 @@',
              '-old',
              '+new',
            ].join('\n'),
          },
        },
      },
    };
    const records: CodexEnvelope[] = [
      { timestamp: '2026-08-15T19:09:23.000Z', type: 'session_meta', payload: { id: 'desktop-patch', cwd: 'D:/repo' } },
      { timestamp: '2026-08-15T19:09:23.500Z', type: 'turn_context', payload: { model: 'gpt-5.6', cwd: 'D:/repo' } },
      patchResult,
    ];

    const parsed = parseCodexRecords('D:/repo/desktop-patch.jsonl', records);
    const summary = getSessionDiffSummary(parsed.detail.messages);

    expect(summary).toMatchObject({
      fileCount: 1,
      editCount: 1,
      addedLines: 1,
      removedLines: 1,
    });
    expect(summary.files[0].path).toBe('D:/dev/repo/src/example.ts');

    records.splice(2, 0, {
      timestamp: '2026-08-15T19:09:23.750Z',
      type: 'response_item',
      payload: {
        type: 'custom_tool_call',
        name: 'apply_patch',
        call_id: 'exec-36079e9a-cb99-41f6-8220-e570d681a02d',
        input: 'patch',
      },
    });
    const paired = parseCodexRecords('D:/repo/paired-patch.jsonl', records);
    expect(getSessionDiffSummary(paired.detail.messages).editCount).toBe(1);
  });

  it('renders response output tool results when no enriched end event exists', async () => {
    const { parseCodexRecords } = await import('@/lib/agent-data/providers/codex/transcript-parser');
    const records: CodexEnvelope[] = [
      { timestamp: '2026-05-08T10:00:00.000Z', type: 'session_meta', payload: { id: 'output-only', cwd: 'D:/repo' } },
      { timestamp: '2026-05-08T10:00:01.000Z', type: 'turn_context', payload: { model: 'gpt-5.5', cwd: 'D:/repo' } },
      { timestamp: '2026-05-08T10:00:02.000Z', type: 'response_item', payload: { type: 'function_call', name: 'shell_command', call_id: 'shell-1', arguments: '{"command":"npm test"}' } },
      { timestamp: '2026-05-08T10:00:03.000Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'shell-1', output: 'function-only output' } },
      { timestamp: '2026-05-08T10:00:04.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: 'patch-1', input: 'patch' } },
      { timestamp: '2026-05-08T10:00:05.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'patch-1', output: 'custom-only output' } },
    ];

    const parsed = parseCodexRecords('D:/repo/output-only.jsonl', records);

    const resultContent = parsed.detail.messages
      .filter(message => message.role === 'tool-result')
      .flatMap(message => message.blocks || [])
      .map(block => block.content);
    expect(resultContent).toEqual(expect.arrayContaining([
      'function-only output',
      'custom-only output',
    ]));
  });
});
