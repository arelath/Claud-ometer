import { describe, expect, it } from 'vitest';
import {
  buildEventBlock,
  buildThinkingBlock,
  buildToolCallDetails,
  buildToolCallDisplay,
  buildToolCallSummary,
  buildToolResultBlock,
  extractTextPreview,
  flattenStructuredRecord,
} from '@/lib/claude-data/tool-parser';
import type { SessionMessage } from '@/lib/claude-data/types';

describe('tool parser helpers', () => {
  it('builds prioritized tool details and read summaries', () => {
    const details = buildToolCallDetails('Read', {
      file_path: 'C:\\repo\\src\\index.ts',
      startLine: 10,
      endLine: 22,
      ignored: 'later',
    });

    expect(details.slice(0, 3)).toEqual([
      { key: 'file_path', label: 'File', value: 'C:\\repo\\src\\index.ts' },
      { key: 'startLine', label: 'Start line', value: '10' },
      { key: 'endLine', label: 'End line', value: '22' },
    ]);
    expect(buildToolCallSummary('Read', details)).toBe('C:\\repo\\src\\index.ts (10-22)');
  });

  it('summarizes scalar, array, and large text inputs', () => {
    expect(buildToolCallDetails('Bash', 'npm test')).toEqual([
      { key: 'input', label: 'Input', value: 'npm test' },
    ]);

    expect(buildToolCallDetails('Glob', { paths: ['src/a.ts', 'src/b.ts'] })).toEqual([
      { key: 'paths', label: 'Paths', value: 'src/a.ts src/b.ts' },
    ]);

    expect(buildToolCallDetails('Write', { file_path: 'a.txt', content: 'one\ntwo\nthree' })).toEqual([
      { key: 'file_path', label: 'File', value: 'a.txt' },
      { key: 'content', label: 'Content', value: '3 lines' },
    ]);
  });

  it('builds diff artifacts from edit-style tool calls', () => {
    const display = buildToolCallDisplay('Edit', 'tool-1', {
      file_path: 'src/app.ts',
      startLine: 7,
      old_string: 'const oldValue = true;',
      new_string: 'const newValue = true;',
    });

    expect(display.summary).toBe('src/app.ts');
    expect(display.artifact).toEqual({
      kind: 'diff',
      title: 'Edit preview',
      oldText: 'const oldValue = true;',
      newText: 'const newValue = true;',
      location: 'line 7',
    });
  });

  it('flattens nested structured records up to the supported depth', () => {
    expect(flattenStructuredRecord({
      content: { file: { filePath: 'src/app.ts', totalLines: 9 } },
      empty: null,
    })).toEqual({
      'content.file.filePath': 'src/app.ts',
      'content.file.totalLines': 9,
    });
  });

  it('extracts text previews from strings, arrays, and structured content', () => {
    expect(extractTextPreview('  hello world  ')).toBe('hello world');
    expect(extractTextPreview([{ text: 'first' }, { tool_name: 'Read' }])).toBe('first, Read');
    expect(extractTextPreview({ content: 'nested text' })).toBe('nested text');
    expect(extractTextPreview([''])).toBeUndefined();
  });

  it('builds tool result blocks with ids, source assistants, content, and file summaries', () => {
    const block = buildToolResultBlock(
      { tool_use_id: 'tool-1', content: [{ text: 'result body' }] },
      { type: 'file', filePath: 'src/app.ts', content: { file: { numLines: 12 } } },
      'assistant-uuid',
    );

    expect(block.type).toBe('tool-result');
    expect(block.title).toBe('File');
    expect(block.summary).toBe('result body');
    expect(block.content).toBe('result body');
    expect(block.details).toEqual(expect.arrayContaining([
      { key: 'tool_use_id', label: 'Tool call', value: 'tool-1' },
      { key: 'filePath', label: 'File', value: 'src/app.ts' },
      { key: 'sourceToolAssistantUUID', label: 'Source assistant', value: 'assistant-uuid' },
    ]));
  });

  it('builds thinking blocks only when useful content is present', () => {
    expect(buildThinkingBlock({ thinking: 'step one\nstep two', signature: 'abcdef' })).toMatchObject({
      type: 'thinking',
      title: 'Thinking',
      summary: '2 lines',
      content: 'step one\nstep two',
    });
    expect(buildThinkingBlock({ thinking: '  ', signature: '' })).toBeNull();
  });

  it('builds attachment and system event blocks', () => {
    const attachment = buildEventBlock({
      type: 'attachment',
      sessionId: 's1',
      timestamp: '2026-05-03T12:00:00.000Z',
      attachment: {
        type: 'file',
        displayPath: 'src/index.ts',
        content: { file: { filePath: 'src/index.ts', totalLines: 20 } },
      },
    });

    expect(attachment).toMatchObject({
      type: 'event',
      title: 'Attachment: File',
      summary: 'file: src/index.ts',
    });

    const system = buildEventBlock({
      type: 'system',
      subtype: 'init',
      sessionId: 's1',
      timestamp: '2026-05-03T12:00:00.000Z',
      permissionMode: 'acceptEdits',
      durationMs: 1200,
    } as SessionMessage & { durationMs: number });

    expect(system).toMatchObject({
      type: 'event',
      title: 'System: Init',
      summary: 'init',
    });
    expect(buildEventBlock({ type: 'empty', sessionId: 's1', timestamp: 't' })).toMatchObject({
      type: 'event',
      title: 'Empty',
    });
  });
});
