import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const root = path.join(process.cwd(), '.test-artifacts', 'codex-rollout-replacement');
const codexDir = path.join(root, '.codex');
const directory = path.join(codexDir, 'sessions', '2026', '09', '05');
const id = '00000000-0000-0000-0000-000000000001';
const original = path.join(directory, `rollout-2026-09-05T07-00-00-${id}.jsonl`);
const replacement = path.join(directory, `rollout-2026-09-05T08-00-00-${id}_00000000-0000-0000-0000-000000000002.jsonl`);
const stamp = (hour: number) => `2026-09-05T${String(hour).padStart(2, '0')}:00:00.000Z`;
const meta = (hour: number, extra = {}) => ({ timestamp: stamp(hour), type: 'session_meta', payload: {
  id, session_id: id, originator: 'codex_cli', cwd: 'D:/sample', timestamp: stamp(hour), history_mode: 'paginated', ...extra,
} });
const message = (role: string, text: string, hour = 7) => ({ timestamp: stamp(hour), type: 'response_item', payload: {
  type: 'message', role, content: [{ type: 'input_text', text }],
} });
const context = { timestamp: stamp(7), type: 'turn_context', payload: { model: 'gpt-5.5' } };
const usage = (input: number, hour = 7) => ({ timestamp: stamp(hour), type: 'event_msg', payload: {
  type: 'token_count', info: { total_token_usage: { input_tokens: input, output_tokens: input / 10 } },
} });
const jsonl = (rows: unknown[]) => rows.map(row => JSON.stringify(row) + '\n').join('');

beforeEach(() => {
  vi.resetModules();
  fs.mkdirSync(directory, { recursive: true });
  process.env.AGENT_SCOPE_CODEX_DIR = codexDir;
  process.env.AGENT_SCOPE_IMPORT_DIR = path.join(root, 'import');
});
afterEach(() => {
  delete process.env.AGENT_SCOPE_CODEX_DIR;
  delete process.env.AGENT_SCOPE_IMPORT_DIR;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('Codex replacement rollouts', () => {
  it('keeps one stable route and composes only the declared history prefix with its replacement', async () => {
    const prefix = jsonl([meta(7), context, message('user', 'retained question'), message('assistant', 'retained answer'), usage(100)]);
    fs.writeFileSync(original, prefix + jsonl([message('user', 'abandoned question'), usage(9999)]));
    const reader = await import('@/lib/agent-data/providers/codex/reader');
    const [before] = await reader.discoverSessionSummarySources();
    fs.writeFileSync(replacement, jsonl([
      meta(8, { history_base: { thread_id: id, end_byte_offset: Buffer.byteLength(prefix), end_ordinal_exclusive: 5 } }),
      context, message('user', 'new question', 8), message('assistant', 'new answer', 8), usage(200, 8),
    ]));
    const child = path.join(directory, 'rollout-child.jsonl');
    fs.writeFileSync(child, jsonl([meta(8, { id: 'child', parent_thread_id: id, agent_role: 'worker' })]));
    const sources = await reader.discoverSessionSummarySources();
    expect(sources).toHaveLength(1);
    expect(sources[0].sourceFilePath).toBe(before.sourceFilePath);
    const summary = await reader.buildSessionSummary(sources[0]);
    expect(summary.routeId).toBe(`codex:${id}`);
    expect(summary.sourceFilePaths).toEqual([original, replacement, child]);
    expect(summary.tokenTotals.input).toBe(200);
    expect(summary.messageCount).toBe(4);
    expect((await reader.buildLightweightSessionSummary(sources[0])).tokenTotals).toEqual(summary.tokenTotals);
    const detail = await reader.getSessionDetail(`codex:${id}`);
    expect(detail?.messages.filter(m => m.content).map(m => m.content)).toEqual([
      'retained question', 'retained answer', 'new question', 'new answer',
    ]);
    expect(summary.usageEvents?.reduce((sum, event) => sum + event.inputTokens, 0)).toBe(200);
  });

  it('uses a fresh replacement without counting the superseded transcript', async () => {
    fs.writeFileSync(original, jsonl([meta(7), context, message('user', 'superseded'), usage(9999)]));
    fs.writeFileSync(replacement, jsonl([meta(8), context, message('user', 'replacement', 8), message('assistant', 'answer', 8), usage(50, 8)]));
    const reader = await import('@/lib/agent-data/providers/codex/reader');
    const sources = await reader.discoverSessionSummarySources();
    expect(sources).toHaveLength(1);
    const summary = await reader.buildSessionSummary(sources[0]);
    expect(summary.sourceFilePath).toBe(original);
    expect(summary.tokenTotals.input).toBe(50);
    expect(summary.messageCount).toBe(2);
    expect(summary.createdAt).toBe(stamp(8));
    expect(summary.searchTextPreview).not.toContain('superseded');
  });

  it('rejects a history prefix ending inside a record', async () => {
    fs.writeFileSync(original, jsonl([meta(7), context]));
    fs.writeFileSync(replacement, jsonl([meta(8, { history_base: { thread_id: id, end_byte_offset: 10 } })]));
    const reader = await import('@/lib/agent-data/providers/codex/reader');
    const [source] = await reader.discoverSessionSummarySources();
    await expect(reader.buildSessionSummary(source)).rejects.toThrow('not a record boundary');
  });

  it('composes chained replacements without replaying abandoned tails', async () => {
    const first = jsonl([meta(7), context, message('user', 'first'), usage(100)]);
    fs.writeFileSync(original, first);
    const second = jsonl([
      meta(8, { history_base: { thread_id: id, end_byte_offset: Buffer.byteLength(first) } }),
      message('user', 'second', 8), usage(200, 8),
    ]);
    fs.writeFileSync(replacement, second + jsonl([message('user', 'abandoned', 8), usage(9999, 8)]));
    fs.writeFileSync(path.join(directory, `rollout-2026-09-05T09-00-00-${id}_third.jsonl`), jsonl([
      meta(9, { history_base: { thread_id: id, end_byte_offset: Buffer.byteLength(second) } }),
      message('user', 'third', 9), usage(300, 9),
    ]));
    const reader = await import('@/lib/agent-data/providers/codex/reader');
    const [source] = await reader.discoverSessionSummarySources();
    const summary = await reader.buildSessionSummary(source);
    expect(summary.messageCount).toBe(3);
    expect(summary.tokenTotals.input).toBe(300);
    expect(summary.searchTextPreview).not.toContain('abandoned');
  });

  it('uses the thread UUID rather than the replacement-file UUID as the filename fallback', async () => {
    fs.writeFileSync(replacement, jsonl([meta(8, { id: undefined })]));
    const index = await import('@/lib/agent-data/providers/codex/session-index');
    expect((await index.discoverCodexSessionFiles())[0].nativeId).toBe(id);
  });
});
