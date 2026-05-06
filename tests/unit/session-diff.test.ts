import { describe, expect, it } from 'vitest';
import { getFilePatchText, getSessionDiffSummary, getSessionPatchText } from '@/lib/session-diff';
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
});
