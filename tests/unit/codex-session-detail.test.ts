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
    process.env.CLAUD_OMETER_CODEX_DIR = codexDir;
    process.env.CLAUD_OMETER_IMPORT_DIR = path.join(root, 'import');
    return import('@/lib/agent-data/providers/codex/reader');
  }

  beforeEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.cpSync(path.join(process.cwd(), 'tests', 'fixtures', 'codex'), codexDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.CLAUD_OMETER_CODEX_DIR;
    delete process.env.CLAUD_OMETER_IMPORT_DIR;
  });

  it('emits normalized transcript rows and metadata', async () => {
    const reader = await loadReader();

    const detail = await reader.getSessionDetail('codex:00000000-0000-0000-0000-000000000001');

    expect(detail).toMatchObject({
      agentKind: 'codex',
      nativeId: '00000000-0000-0000-0000-000000000001',
      cwd: 'D:\\dev\\research\\Claud-ometer',
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
      compaction: { compactions: 1 },
    });
    expect(summary.searchTextPreview).toContain('fixture user text');
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
