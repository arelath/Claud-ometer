import { describe, expect, it } from 'vitest';
import {
  buildContextLineRange,
  formatContextRanges,
  getContextFileGroups,
  getContextFilePathsText,
  getContextLoadedLineCount,
  mergeContextLineRanges,
  parseContextLineCount,
} from '@/lib/context-files';
import type { SessionMessageDisplay, SessionToolCallDetail } from '@/lib/claude-data/types';

function detail(key: string, value: string): SessionToolCallDetail {
  return { key, label: key, value };
}

function message(partial: Partial<SessionMessageDisplay>): SessionMessageDisplay {
  return {
    role: 'assistant',
    content: '',
    timestamp: '2026-05-04T12:00:00.000Z',
    ...partial,
  };
}

describe('context file helpers', () => {
  it('builds, clamps, and merges visual line ranges', () => {
    expect(buildContextLineRange(800, null, 200)).toEqual({ start: 800, end: 999 });
    expect(buildContextLineRange(null, 999, 200)).toEqual({ start: 800, end: 999 });
    expect(buildContextLineRange(12, 4, null)).toEqual({ start: 4, end: 12 });

    expect(mergeContextLineRanges([
      { start: 50, end: 75 },
      { start: 74, end: 90 },
      { start: 120, end: 125 },
      { start: 126, end: 130 },
      { start: 995, end: 1010 },
    ], 1000)).toEqual([
      { start: 50, end: 90 },
      { start: 120, end: 130 },
      { start: 995, end: 1000 },
    ]);
  });

  it('keeps read ranges positioned against total file lines', () => {
    const groups = getContextFileGroups([
      message({
        toolCalls: [
          {
            name: 'Read',
            id: 'read-1',
            summary: 'src/big.ts (800-999)',
            details: [
              detail('file_path', 'src/big.ts'),
              detail('startLine', '800'),
              detail('endLine', '999'),
            ],
          },
        ],
      }),
      message({
        role: 'tool-result',
        blocks: [
          {
            type: 'tool-result',
            title: 'Tool Result',
            summary: 'src/big.ts',
            details: [
              detail('tool_use_id', 'read-1'),
              detail('content.file.filePath', 'src/big.ts'),
              detail('content.file.numLines', '200'),
              detail('content.file.totalLines', '1,436'),
            ],
            content: 'loaded file section',
          },
        ],
      }),
    ]);

    expect(groups.referenced).toEqual([]);
    expect(groups.inContext).toHaveLength(1);
    expect(groups.inContext[0]).toMatchObject({
      fullPath: 'src/big.ts',
      loadedLines: '200',
      totalLines: '1,436',
      loadedRanges: [{ start: 800, end: 999 }],
    });
    expect(getContextLoadedLineCount(groups.inContext[0])).toBe(200);
    expect(formatContextRanges(groups.inContext[0].loadedRanges)).toBe('L800-999');
  });

  it('merges multiple mentions of the same file and preserves disjoint sections', () => {
    const groups = getContextFileGroups([
      message({
        toolCalls: [
          {
            name: 'Read',
            id: 'read-1',
            summary: 'helper.ts (10-20)',
            details: [
              detail('file_path', 'helper.ts'),
              detail('startLine', '10'),
              detail('endLine', '20'),
            ],
          },
          {
            name: 'Read',
            id: 'read-2',
            summary: 'src/helper.ts (80-90)',
            details: [
              detail('file_path', 'src/helper.ts'),
              detail('startLine', '80'),
              detail('endLine', '90'),
            ],
          },
        ],
      }),
      message({
        role: 'tool-result',
        blocks: [
          {
            type: 'tool-result',
            title: 'Tool Result',
            summary: 'src/helper.ts',
            details: [
              detail('tool_use_id', 'read-1'),
              detail('content.file.filePath', 'src/helper.ts'),
              detail('content.file.numLines', '11'),
              detail('content.file.totalLines', '100'),
            ],
            content: 'first section',
          },
          {
            type: 'tool-result',
            title: 'Tool Result',
            summary: 'src/helper.ts',
            details: [
              detail('tool_use_id', 'read-2'),
              detail('content.file.filePath', 'src/helper.ts'),
              detail('content.file.numLines', '11'),
              detail('content.file.totalLines', '100'),
            ],
            content: 'second section',
          },
        ],
      }),
    ]);

    expect(groups.inContext).toHaveLength(1);
    expect(groups.inContext[0].fullPath).toBe('src/helper.ts');
    expect(groups.inContext[0].messageIndexes).toEqual([0, 1]);
    expect(groups.inContext[0].loadedRanges).toEqual([
      { start: 10, end: 20 },
      { start: 80, end: 90 },
    ]);
    expect(getContextLoadedLineCount(groups.inContext[0])).toBe(22);
  });

  it('formats copy-all path text in the rendered file order', () => {
    const groups = getContextFileGroups([
      message({
        blocks: [
          {
            type: 'tool-result',
            title: 'Tool Result',
            summary: 'src/zeta.ts',
            details: [detail('content.file.filePath', 'src/zeta.ts'), detail('content.file.numLines', '3')],
          },
          {
            type: 'tool-result',
            title: 'Tool Result',
            summary: 'src/alpha.ts',
            details: [detail('content.file.filePath', 'src/alpha.ts'), detail('content.file.numLines', '7')],
          },
        ],
      }),
    ]);

    expect(getContextFilePathsText([...groups.inContext, ...groups.referenced])).toBe('src/alpha.ts\nsrc/zeta.ts');
  });

  it('parses only plain positive integer line counts', () => {
    expect(parseContextLineCount('1,436')).toBe(1436);
    expect(parseContextLineCount(' 42 ')).toBe(42);
    expect(parseContextLineCount('42 lines')).toBeNull();
    expect(parseContextLineCount(undefined)).toBeNull();
  });
});
