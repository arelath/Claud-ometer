// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { fork } from 'node:child_process';
import { build } from 'esbuild';
import { afterEach, describe, expect, it } from 'vitest';
import { readCodexSummaryRecords } from '@/lib/agent-data/providers/codex/summary-records';
import { parseCodexRecords, readCodexRecords } from '@/lib/agent-data/providers/codex/transcript-parser';
import { normalizeSearchText } from '@/lib/agent-data/session-summary';
import { getSessionChangeTotals, getSessionDiffSummary } from '@/lib/session-diff';
import { buildChangeEvents } from '@/lib/agent-data/event-metrics';

const root = path.join(process.cwd(), '.test-artifacts', 'codex-summary-memory');
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('Codex summary memory', () => {
  it('preserves metrics, patch results, usage attribution and search while discarding display payloads', async () => {
    fs.mkdirSync(root, { recursive: true });
    const file = path.join(root, 'session.jsonl');
    const stamp = '2026-09-01T10:00:00.000Z';
    const patch = '*** Begin Patch\n*** Add File: sample.ts\n+hello\n*** End Patch';
    const rows = [
      { type: 'session_meta', payload: { id: 'summary', cwd: 'D:/sample' } },
      { type: 'turn_context', payload: { model: 'gpt-5.5' } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'An answer' }] } },
      { type: 'event_msg', payload: { type: 'token_count', total_token_usage: { input_tokens: 100, output_tokens: 20 }, last_token_usage: { input_tokens: 100, output_tokens: 20 } } },
      { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'failed', input: `await tools.apply_patch(${JSON.stringify(patch)})` } },
      { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'failed', output: 'x'.repeat(20_000) + '\nScript error: failed' } },
      { type: 'event_msg', payload: { type: 'patch_apply_end', call_id: 'orphan', success: true, changes: { 'sample.ts': { type: 'add', content: 'hello\n' } } } },
      { type: 'compacted', replacement_history: [{ content: 'ignored history'.repeat(10_000) }] },
    ];
    // Exercise timestamps nested in payloads, as well as ordinary envelopes.
    fs.writeFileSync(file, rows.map(row => JSON.stringify({ ...row, payload: { ...row.payload, timestamp: stamp } })).join('\n'));
    const full = parseCodexRecords(file, await readCodexRecords(file));
    const projected = await readCodexSummaryRecords(file);
    const compact = parseCodexRecords(file, projected, undefined, { summaryOnly: true });
    expect(compact.info).toEqual(full.info);
    expect(compact.modelUsage).toEqual(full.modelUsage);
    expect(compact.reasoningOutputTokens).toEqual(full.reasoningOutputTokens);
    expect(compact.detail.messages.map(m => m.usage)).toEqual(full.detail.messages.map(m => m.usage));
    expect(normalizeSearchText([compact.searchableText])).toEqual(normalizeSearchText([full.searchableText]));
    expect(getSessionChangeTotals(compact.detail.messages)).toEqual(getSessionChangeTotals(full.detail.messages));
    expect(buildChangeEvents(compact.detail.messages)).toEqual(buildChangeEvents(full.detail.messages));
    expect(compact.info.toolsUsed).toEqual({ exec: 1, apply_patch: 1 });
    expect(JSON.stringify(projected)).not.toContain('ignored history');
    expect(compact.detail.messages.every(message => message.content === '')).toBe(true);
  });

  it('retains complete Read snapshots needed to locate edits beyond the search preview', async () => {
    fs.mkdirSync(root, { recursive: true });
    const file = path.join(root, 'snapshot.jsonl');
    const rows = [
      { type: 'session_meta', payload: { id: 'snapshot', cwd: 'D:/sample' } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'read', output: 'context\n'.repeat(5000) + 'before\n' } },
      { type: 'response_item', payload: { type: 'function_call', name: 'Read', call_id: 'read', arguments: '{"file_path":"sample.ts"}' } },
      { type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: 'patch', input: '*** Begin Patch\n*** Update File: sample.ts\n@@\n-before\n+after\n*** End Patch' } },
    ];
    fs.writeFileSync(file, rows.map(row => JSON.stringify({ timestamp: '2026-09-01T10:00:00.000Z', ...row })).join('\n'));
    const full = parseCodexRecords(file, await readCodexRecords(file));
    const compact = parseCodexRecords(file, await readCodexSummaryRecords(file), undefined, { summaryOnly: true });
    const expected = getSessionDiffSummary(full.detail.messages);
    expect(expected.files[0].editHunks[0].oldStartLine).toBe(5001);
    expect(getSessionDiffSummary(compact.detail.messages)).toEqual(expected);
  });

  it('indexes a large transcript in a real worker with a bounded heap', async () => {
    fs.mkdirSync(root, { recursive: true });
    const file = path.join(root, 'large.jsonl');
    const fd = fs.openSync(file, 'w');
    const timestamp = '2026-09-01T10:00:00.000Z';
    const write = (type: string, payload: unknown) => fs.writeSync(fd, JSON.stringify({ timestamp, type, payload }) + '\n');
    try {
      write('session_meta', { id: 'large-summary', cwd: 'D:/sample' });
      write('turn_context', { model: 'gpt-5.5' });
      const output = 'large tool output '.repeat(32 * 1024);
      for (let i = 0; i < 192; i++) {
        write('response_item', { type: 'function_call', name: 'shell_command', call_id: String(i), arguments: '{"command":"echo example"}' });
        write('response_item', { type: 'function_call_output', call_id: String(i), output });
      }
    } finally {
      fs.closeSync(fd);
    }
    const worker = path.join(root, 'worker.mjs');
    await build({
      entryPoints: ['src/indexer/summary-worker.ts'], outfile: worker,
      bundle: true, platform: 'node', format: 'esm', target: 'node22',
      tsconfig: 'tsconfig.json', external: ['tiktoken/lite'], logLevel: 'silent',
      banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
    });
    const child = fork(worker, [], { execArgv: ['--max-old-space-size=128'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let stderr = '';
    child.stderr?.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
    try {
      const result = await new Promise<import('@/indexer/summary-worker-protocol').SummaryWorkerResponse>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Summary worker timed out')), 30_000);
        child.once('message', message => { clearTimeout(timer); resolve(message as import('@/indexer/summary-worker-protocol').SummaryWorkerResponse); });
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', code => { clearTimeout(timer); reject(new Error(`Worker exited ${code}: ${stderr}`)); });
        const stat = fs.statSync(file);
        child.send({ type: 'run', id: 'memory-regression', task: {
          provider: 'codex', mode: 'full', source: {
            provider: 'codex', parserVersion: 'codex-summary-v9', sourceFilePath: file,
            sourceSignature: { size: stat.size, mtimeMs: stat.mtimeMs },
          },
        } });
      });
      expect(result.type).toBe('result');
      if (result.type !== 'result') throw new Error('Unexpected worker response');
      expect(result.result.error).toBeUndefined();
      expect(result.result.summary?.toolCallCount).toBe(192);
      expect(result.result.summary?.searchTextPreview?.length).toBeLessThanOrEqual(8192);
    } finally {
      const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
      if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; }
    }
  }, 60_000);
});
