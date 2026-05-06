import { describe, expect, it } from 'vitest';
import { getFilePatchText, getSessionDiffSummary, getSessionPatchText } from '@/lib/session-diff';
import { buildToolCallDisplay } from '@/lib/claude-data/tool-parser';
import type { SessionMessageDisplay, SessionToolCallDetail } from '@/lib/claude-data/types';

function detail(key: string, value: string): SessionToolCallDetail {
  return { key, label: key, value };
}

function assistantWithEdit(
  messageIndex: number,
  filePath: string,
  oldText: string,
  newText: string,
  startLine: string,
): SessionMessageDisplay {
  return {
    role: 'assistant',
    content: '',
    timestamp: `2026-05-04T12:00:${String(messageIndex).padStart(2, '0')}.000Z`,
    toolCalls: [
      {
        name: 'Edit',
        id: `edit-${messageIndex}`,
        summary: filePath,
        details: [
          detail('file_path', filePath),
          detail('startLine', startLine),
          detail('old_string', oldText),
          detail('new_string', newText),
        ],
        artifact: {
          kind: 'diff',
          title: 'Edit preview',
          oldText,
          newText,
          location: `line ${startLine}`,
        },
      },
    ],
  };
}

function readMessages(filePath: string, startLine: string, content: string): SessionMessageDisplay[] {
  return [
    {
      role: 'tool-use',
      content: '',
      timestamp: '2026-05-04T12:00:00.000Z',
      toolCalls: [
        {
          name: 'Read',
          id: 'read-1',
          summary: filePath,
          details: [
            detail('file_path', filePath),
            detail('startLine', startLine),
          ],
        },
      ],
    },
    {
      role: 'tool-result',
      content: '',
      timestamp: '2026-05-04T12:00:01.000Z',
      blocks: [
        {
          type: 'tool-result',
          title: 'Text',
          summary: filePath,
          content,
          details: [
            detail('tool_use_id', 'read-1'),
            detail('content.file.filePath', filePath),
          ],
        },
      ],
    },
  ];
}

function assistantWithTool(
  messageIndex: number,
  name: string,
  id: string,
  input: Record<string, unknown>,
): SessionMessageDisplay {
  return {
    role: 'assistant',
    content: '',
    timestamp: `2026-05-04T12:01:${String(messageIndex).padStart(2, '0')}.000Z`,
    toolCalls: [
      buildToolCallDisplay(name, id, input),
    ],
  };
}

describe('session diff helpers', () => {
  it('groups edit artifacts by file and computes line-level stats', () => {
    const summary = getSessionDiffSummary([
      assistantWithEdit(
        1,
        'src/cache.ts',
        ['export function cache() {', '  return false;', '}'].join('\n'),
        ['export function cache() {', '  return true;', '}', 'cache();'].join('\n'),
        '40',
      ),
      assistantWithEdit(
        2,
        'src/cache.ts',
        ['const mode = "old";'].join('\n'),
        ['const mode = "new";'].join('\n'),
        '90',
      ),
      assistantWithEdit(
        3,
        'src/only-added.ts',
        '',
        ['export const created = true;'].join('\n'),
        '1',
      ),
    ]);

    expect(summary.fileCount).toBe(2);
    expect(summary.editCount).toBe(3);
    expect(summary.addedLines).toBe(4);
    expect(summary.removedLines).toBe(2);

    const cacheFile = summary.files.find(file => file.path === 'src/cache.ts');
    expect(cacheFile).toMatchObject({
      addedLines: 3,
      removedLines: 2,
      editCount: 2,
      status: 'modified',
    });
    expect(cacheFile?.editHunks).toHaveLength(2);
    expect(cacheFile?.hunks[0].rows.map(row => row.type)).toEqual(['context', 'remove', 'add', 'context', 'add']);

    const addedFile = summary.files.find(file => file.path === 'src/only-added.ts');
    expect(addedFile?.status).toBe('added');
  });

  it('formats copyable unified patch text', () => {
    const summary = getSessionDiffSummary([
      assistantWithEdit(1, 'src/cache.ts', 'old line', 'new line', '7'),
    ]);
    const filePatch = getFilePatchText(summary.files[0]);

    expect(filePatch).toContain('diff --git a/src/cache.ts b/src/cache.ts');
    expect(filePatch).toContain('@@ -7 +7 @@ Net diff');
    expect(filePatch).toContain('-old line');
    expect(filePatch).toContain('+new line');
    expect(getSessionPatchText(summary)).toBe(filePatch);
  });

  it('combines sequential edits to the same region in net mode while preserving per-edit hunks', () => {
    const firstEdit = assistantWithEdit(
      1,
      'src/cache.ts',
      ['function cache() {', '  return false;', '}'].join('\n'),
      ['function cache() {', '  return true;', '}'].join('\n'),
      '40',
    );
    const secondEdit = assistantWithEdit(
      2,
      'src/cache.ts',
      ['function cache() {', '  return true;', '}'].join('\n'),
      ['function cache() {', '  return mode === "on";', '}'].join('\n'),
      '40',
    );

    const summary = getSessionDiffSummary([firstEdit, secondEdit]);
    const file = summary.files[0];

    expect(file.hunks).toHaveLength(1);
    expect(file.editHunks).toHaveLength(2);
    expect(file.hunks[0].rows.map(row => `${row.type}:${row.text}`)).toEqual([
      'context:function cache() {',
      'remove:  return false;',
      'add:  return mode === "on";',
      'context:}',
    ]);
    expect(getFilePatchText(file, 'net')).toContain('+  return mode === "on";');
    expect(getFilePatchText(file, 'net')).not.toContain('+  return true;');
    expect(getFilePatchText(file, 'edits')).toContain('+  return true;');
  });

  it('infers edit line numbers from prior read snapshots instead of falling back to one', () => {
    const messages = [
      ...readMessages(
        'src/cache.ts',
        '80',
        [
          'export const before = true;',
          'function cache() {',
          '  return false;',
          '}',
        ].join('\n'),
      ),
      assistantWithEdit(
        3,
        'src/cache.ts',
        ['function cache() {', '  return false;', '}'].join('\n'),
        ['function cache() {', '  return true;', '}'].join('\n'),
        '',
      ),
    ];

    const summary = getSessionDiffSummary(messages);
    const hunk = summary.files[0].hunks[0];

    expect(hunk.oldStartLine).toBe(81);
    expect(hunk.rows[0].oldLineNumber).toBe(81);
    expect(hunk.rows[1].oldLineNumber).toBe(82);
    expect(hunk.rows[1].newLineNumber).toBeNull();
  });

  it('treats read snapshots without an explicit start line as full-file reads', () => {
    const messages = [
      ...readMessages(
        'src/cache.ts',
        '',
        [
          'export const before = true;',
          'function cache() {',
          '  return false;',
          '}',
        ].join('\n'),
      ),
      assistantWithEdit(
        3,
        'src/cache.ts',
        ['function cache() {', '  return false;', '}'].join('\n'),
        ['function cache() {', '  return true;', '}'].join('\n'),
        '',
      ),
    ];

    const summary = getSessionDiffSummary(messages);
    expect(summary.files[0].hunks[0].oldStartLine).toBe(2);
    expect(summary.files[0].hunks[0].rows[0].oldLineNumber).toBe(2);
  });

  it('maps later net diff hunks back through earlier line drift', () => {
    const summary = getSessionDiffSummary([
      assistantWithEdit(
        1,
        'src/drift.ts',
        'const anchor = true;',
        [
          'const anchor = true;',
          'const added1 = true;',
          'const added2 = true;',
          'const added3 = true;',
          'const added4 = true;',
          'const added5 = true;',
          'const added6 = true;',
          'const added7 = true;',
          'const added8 = true;',
          'const added9 = true;',
          'const added10 = true;',
        ].join('\n'),
        '5',
      ),
      assistantWithEdit(
        2,
        'src/drift.ts',
        'const target = false;',
        'const target = true;',
        '25',
      ),
    ]);

    const file = summary.files[0];
    const driftedHunk = file.hunks.find(hunk => hunk.toolId === 'edit-2');

    expect(driftedHunk?.oldStartLine).toBe(15);
    expect(driftedHunk?.newStartLine).toBe(25);
    expect(driftedHunk?.rows).toEqual([
      {
        type: 'remove',
        oldLineNumber: 15,
        newLineNumber: null,
        text: 'const target = false;',
      },
      {
        type: 'add',
        oldLineNumber: null,
        newLineNumber: 25,
        text: 'const target = true;',
      },
    ]);
  });

  it('keeps overlapping net diff regions on a single continuous line-number track', () => {
    const summary = getSessionDiffSummary([
      assistantWithEdit(
        1,
        'src/overlap.ts',
        ['line10', 'line11', 'line12', 'line13', 'line14', 'line15'].join('\n'),
        ['line10', 'line11', 'line12 changed', 'line13', 'line14', 'line15'].join('\n'),
        '10',
      ),
      assistantWithEdit(
        2,
        'src/overlap.ts',
        ['line13', 'line14', 'line15'].join('\n'),
        ['line13', 'line14 changed', 'line15', 'line16 added'].join('\n'),
        '13',
      ),
    ]);

    const hunk = summary.files[0].hunks[0];

    expect(summary.files[0].hunks).toHaveLength(1);
    expect(hunk.oldStartLine).toBe(10);
    expect(hunk.newStartLine).toBe(10);
    expect(hunk.rows.filter(row => row.oldLineNumber != null).map(row => row.oldLineNumber)).toEqual([10, 11, 12, 13, 14, 15]);
    expect(hunk.rows.filter(row => row.newLineNumber != null).map(row => row.newLineNumber)).toEqual([10, 11, 12, 13, 14, 15, 16]);
  });

  it('uses unknown line numbers for low-confidence unresolved edits without corrupting later offsets', () => {
    const summary = getSessionDiffSummary([
      assistantWithEdit(
        1,
        'src/unknown.ts',
        '}',
        '};',
        '',
      ),
      assistantWithEdit(
        2,
        'src/unknown.ts',
        'const later = false;',
        'const later = true;',
        '20',
      ),
    ]);

    const file = summary.files[0];

    expect(file.editHunks[0].oldStartLine).toBeNull();
    expect(file.editHunks[0].rows.every(row => row.oldLineNumber == null && row.newLineNumber == null)).toBe(true);
    expect(file.editHunks[1].oldStartLine).toBe(20);
    expect(file.editHunks[1].rows[0].oldLineNumber).toBe(20);
    expect(file.editHunks[1].rows[1].newLineNumber).toBe(20);
  });

  it('includes newly written files from Write tool artifacts', () => {
    const summary = getSessionDiffSummary([
      assistantWithTool(1, 'Write', 'write-1', {
        file_path: 'src/new-file.ts',
        content: ['export const created = true;', 'created;'].join('\n'),
      }),
    ]);

    expect(summary.fileCount).toBe(1);
    expect(summary.editCount).toBe(1);
    expect(summary.addedLines).toBe(2);
    expect(summary.removedLines).toBe(0);
    expect(summary.files[0]).toMatchObject({
      path: 'src/new-file.ts',
      status: 'added',
      addedLines: 2,
      removedLines: 0,
    });
    expect(summary.files[0].hunks[0].rows).toEqual([
      {
        type: 'add',
        oldLineNumber: null,
        newLineNumber: 1,
        text: 'export const created = true;',
      },
      {
        type: 'add',
        oldLineNumber: null,
        newLineNumber: 2,
        text: 'created;',
      },
    ]);
  });

  it('includes delete edits where new_string is empty', () => {
    const summary = getSessionDiffSummary([
      assistantWithTool(1, 'Edit', 'edit-delete-1', {
        file_path: 'src/cleanup.ts',
        startLine: 12,
        old_string: ['obsolete();', 'cleanup();'].join('\n'),
        new_string: '',
      }),
    ]);

    expect(summary.fileCount).toBe(1);
    expect(summary.addedLines).toBe(0);
    expect(summary.removedLines).toBe(2);
    expect(summary.files[0].status).toBe('deleted');
    expect(summary.files[0].hunks[0].rows.map(row => row.type)).toEqual(['remove', 'remove']);
  });

  it('expands MultiEdit tool calls into separate per-edit hunks', () => {
    const summary = getSessionDiffSummary([
      assistantWithTool(1, 'MultiEdit', 'multi-1', {
        file_path: 'src/multi.ts',
        edits: [
          { old_string: 'const one = false;', new_string: 'const one = true;' },
          { old_string: 'const two = false;', new_string: 'const two = true;' },
        ],
      }),
    ]);

    expect(summary.fileCount).toBe(1);
    expect(summary.editCount).toBe(2);
    expect(summary.files[0].editHunks).toHaveLength(2);
    expect(summary.files[0].editHunks.map(hunk => hunk.toolId)).toEqual(['multi-1:1', 'multi-1:2']);
  });

  it('uses notebook_path for NotebookEdit changed files', () => {
    const summary = getSessionDiffSummary([
      assistantWithTool(1, 'NotebookEdit', 'notebook-1', {
        notebook_path: 'notebooks/analysis.ipynb',
        edit_mode: 'insert',
        cell_id: 'abc123',
        cell_type: 'code',
        new_source: 'print("hello")',
      }),
    ]);

    expect(summary.fileCount).toBe(1);
    expect(summary.files[0].path).toBe('notebooks/analysis.ipynb');
    expect(summary.files[0].editHunks[0]).toMatchObject({
      toolName: 'NotebookEdit',
      location: 'insert - cell abc123',
    });
  });
});
