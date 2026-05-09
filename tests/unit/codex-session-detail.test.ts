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

  it('renders errors and compactions as visible system events', async () => {
    const reader = await loadReader();
    const detail = await reader.getSessionDetail('00000000-0000-0000-0000-000000000001');

    expect(detail?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'system', content: 'Context compacted' }),
      expect.objectContaining({ role: 'system', content: 'fixture abort example' }),
    ]));
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
