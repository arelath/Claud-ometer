import { describe, expect, it } from 'vitest';
import {
  buildCodexToolCalls,
  buildCodexPatchResultToolCalls,
  buildCodexToolResultBlock,
  collectCodexToolResults,
  parseJsonObject,
} from '@/lib/agent-data/providers/codex/tool-parser';
import type { CodexEnvelope } from '@/lib/agent-data/providers/codex/schema';

describe('Codex tool parser', () => {
  it('parses shell function call arguments from a JSON string', () => {
    expect(parseJsonObject('{"command":"npm test","cwd":"D:/repo"}')).toEqual({
      command: 'npm test',
      cwd: 'D:/repo',
    });
  });

  it('enriches shell calls with matching command results', () => {
    const records: CodexEnvelope[] = [{
      timestamp: '2026-05-08T10:00:00.000Z',
      type: 'event_msg',
      payload: { kind: 'exec_command_end', call_id: 'call-1', exit_code: 1, stdout: '', stderr: 'boom', duration_ms: 5 },
    }];
    const results = collectCodexToolResults(records);
    const calls = buildCodexToolCalls({
      type: 'function_call',
      name: 'shell_command',
      call_id: 'call-1',
      arguments: '{"command":"npm test"}',
    }, results);

    expect(calls[0].summary).toBe('npm test');
    expect(calls[0].details).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'exit_code', value: '1' }),
      expect.objectContaining({ key: 'status', value: 'failed' }),
    ]));
  });

  it('creates diff artifacts for apply_patch changed files', () => {
    const records: CodexEnvelope[] = [{
      timestamp: '2026-05-08T10:00:00.000Z',
      type: 'event_msg',
      payload: {
        kind: 'patch_apply_end',
        call_id: 'patch-1',
        success: true,
        stdout: 'Done',
        changes: {
          'src/example.ts': {
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
    }];

    const calls = buildCodexToolCalls({
      type: 'custom_tool_call',
      name: 'apply_patch',
      call_id: 'patch-1',
      input: 'patch',
    }, collectCodexToolResults(records));

    expect(calls).toHaveLength(1);
    expect(calls[0].artifact).toMatchObject({
      kind: 'diff',
      oldText: 'old',
      newText: 'new',
    });
    expect(calls[0].details).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'file_path', value: 'src/example.ts' }),
      expect.objectContaining({ key: 'status', value: 'success' }),
    ]));
  });

  it('creates diff artifacts directly from orphaned patch results', () => {
    const results = collectCodexToolResults([{
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
          'D:\\dev\\repo\\src\\added.ts': {
            type: 'add',
            content: 'export const added = true;\n',
          },
          'D:\\dev\\repo\\src\\deleted.ts': {
            type: 'delete',
            content: 'export const deleted = true;\n',
          },
        },
      },
    }]);

    const calls = buildCodexPatchResultToolCalls(results.get('exec-36079e9a-cb99-41f6-8220-e570d681a02d')!);

    expect(calls).toHaveLength(3);
    expect(calls[0]).toMatchObject({
      name: 'apply_patch',
      summary: 'D:\\dev\\repo\\src\\example.ts',
      artifact: {
        kind: 'diff',
        oldText: 'old',
        newText: 'new',
      },
    });
    expect(calls[1]).toMatchObject({
      summary: 'D:\\dev\\repo\\src\\added.ts',
      artifact: {
        kind: 'diff',
        oldText: '',
        newText: 'export const added = true;\n',
      },
    });
    expect(calls[2]).toMatchObject({
      summary: 'D:\\dev\\repo\\src\\deleted.ts',
      artifact: {
        kind: 'diff',
        oldText: 'export const deleted = true;\n',
        newText: '',
      },
    });
  });

  it('creates apply_patch diff artifacts from legacy patch input', () => {
    const patchInput = [
      '*** Begin Patch',
      '*** Update File: d:\\dev\\repo\\src\\app.ts',
      '@@',
      '-export const enabled = false;',
      '+export const enabled = true;',
      '*** Add File: d:\\dev\\repo\\src\\new.ts',
      '+export const added = true;',
      '*** End Patch',
    ].join('\n');

    const calls = buildCodexToolCalls({
      type: 'custom_tool_call',
      name: 'apply_patch',
      call_id: 'patch-legacy',
      input: patchInput,
    }, collectCodexToolResults([{
      timestamp: '2026-04-18T02:05:00.000Z',
      type: 'response_item',
      payload: {
        type: 'custom_tool_call_output',
        call_id: 'patch-legacy',
        output: '{"output":"Success. Updated the following files:\\nM d:\\\\dev\\\\repo\\\\src\\\\app.ts\\nA d:\\\\dev\\\\repo\\\\src\\\\new.ts\\n"}',
      },
    }]));

    expect(calls).toHaveLength(2);
    expect(calls[0].artifact).toMatchObject({
      kind: 'diff',
      oldText: 'export const enabled = false;',
      newText: 'export const enabled = true;',
    });
    expect(calls[1].artifact).toMatchObject({
      kind: 'diff',
      oldText: '',
      newText: 'export const added = true;',
    });
    expect(calls.map(call => call.summary)).toEqual([
      'd:\\dev\\repo\\src\\app.ts',
      'd:\\dev\\repo\\src\\new.ts',
    ]);
  });

  it('leaves missing results as pending generic tool calls', () => {
    const calls = buildCodexToolCalls({
      type: 'function_call',
      name: 'unknown_tool',
      call_id: 'missing',
      arguments: '{"query":"hello"}',
    }, new Map());

    expect(calls[0]).toMatchObject({
      name: 'unknown_tool',
      id: 'missing',
      summary: 'unknown_tool',
    });
    expect(calls[0].details).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'status', value: 'pending' }),
      expect.objectContaining({ key: 'query', value: 'hello' }),
    ]));
  });

  it('collects response_item function and custom tool outputs by call id', () => {
    const records: CodexEnvelope[] = [
      {
        timestamp: '2026-05-08T10:00:00.000Z',
        type: 'response_item',
        payload: { type: 'function_call_output', call_id: 'call-1', output: 'function output' },
      },
      {
        timestamp: '2026-05-08T10:00:01.000Z',
        type: 'response_item',
        payload: { type: 'custom_tool_call_output', call_id: 'call-2', output: { ok: true } },
      },
    ];

    const results = collectCodexToolResults(records);

    expect(buildCodexToolResultBlock(results.get('call-1')!)).toMatchObject({
      type: 'tool-result',
      title: 'function_call_output',
      content: 'function output',
    });
    expect(buildCodexToolResultBlock(results.get('call-2')!).content).toContain('"ok": true');
  });

  it('prefers enriched event-end results over basic response outputs', () => {
    const results = collectCodexToolResults([
      {
        timestamp: '2026-05-08T10:00:00.000Z',
        type: 'response_item',
        payload: { type: 'function_call_output', call_id: 'call-1', output: 'basic output' },
      },
      {
        timestamp: '2026-05-08T10:00:01.000Z',
        type: 'event_msg',
        payload: { kind: 'exec_command_end', call_id: 'call-1', exit_code: 0, stdout: 'enriched output' },
      },
    ]);

    const block = buildCodexToolResultBlock(results.get('call-1')!);

    expect(block.title).toBe('exec_command_end');
    expect(block.content).toBe('enriched output');
  });
});
