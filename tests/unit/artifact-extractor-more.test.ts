import { describe, expect, it } from 'vitest';
import { getSessionDiffArtifacts } from '@/lib/artifact-extractor';
import type { SessionMessageDisplay, SessionToolCallDisplay } from '@/lib/claude-data/types';

function detail(key: string, value: string) {
  return { key, label: key, value };
}

function tool(name: string, id: string, details: SessionToolCallDisplay['details'], artifact?: SessionToolCallDisplay['artifact']): SessionToolCallDisplay {
  return {
    name,
    id,
    summary: name,
    details,
    artifact,
  };
}

function msg(index: number, toolCalls?: SessionToolCallDisplay[], blocks?: SessionMessageDisplay['blocks']): SessionMessageDisplay {
  return {
    role: toolCalls ? 'assistant' : 'tool-result',
    content: '',
    timestamp: `2026-05-08T12:00:0${index}.000Z`,
    toolCalls,
    blocks,
  };
}

describe('artifact extractor additional diff inference', () => {
  it('infers edit start lines from read snapshots and previous edits', () => {
    const read = msg(0, [tool('Read', 'read-1', [
      detail('file_path', './src/app.ts'),
      detail('startLine', '10'),
    ])]);
    const readResult = msg(1, undefined, [{
      type: 'tool-result',
      title: 'Read',
      summary: 'src/app.ts',
      content: '10 | const first = false;\n11 | const second = false;\n12 | const third = false;',
      details: [
        detail('tool_use_id', 'read-1'),
        detail('content.file.numLines', '3'),
        detail('content.file.totalLines', '99'),
      ],
    }]);
    const firstEdit = msg(2, [tool('Edit', 'edit-1', [
      detail('file_path', 'src/app.ts'),
    ], {
      kind: 'diff',
      title: 'src/app.ts',
      oldText: 'const first = false;\nconst second = false;',
      newText: 'const first = true;\nconst second = false;',
    })]);
    const secondEdit = msg(3, [tool('Edit', 'edit-2', [
      detail('file_path', 'src/app.ts'),
    ], {
      kind: 'diff',
      title: 'src/app.ts',
      oldText: 'const first = true;',
      newText: 'const first = maybe;',
    })]);

    const artifacts = getSessionDiffArtifacts([read, readResult, firstEdit, secondEdit]);

    expect(artifacts).toHaveLength(2);
    expect(artifacts[0]).toMatchObject({ path: 'src/app.ts', startLine: 10, location: 'line 10' });
    expect(artifacts[1]).toMatchObject({ path: 'src/app.ts', startLine: 10, location: 'line 10' });
  });

  it('uses full-file read snapshots as write old text and expands multi-edit ids', () => {
    const read = msg(0, [tool('Read', 'read-full', [
      detail('file_path', 'src/write-target.ts'),
      detail('startLine', '1'),
    ])]);
    const readResult = msg(1, undefined, [{
      type: 'tool-result',
      title: 'Read',
      summary: 'src/write-target.ts',
      content: 'old file\ncontents',
      details: [
        detail('tool_use_id', 'read-full'),
        detail('content.file.numLines', '2'),
        detail('content.file.totalLines', '2'),
      ],
    }]);
    const write = msg(2, [tool('Write', 'write-1', [
      detail('file_path', 'src/write-target.ts'),
    ], {
      kind: 'diff',
      title: 'src/write-target.ts',
      oldText: '',
      newText: 'new file\ncontents',
      includeWhenEmpty: true,
    })]);
    const multi = msg(3, [tool('MultiEdit', 'multi-1', [
      detail('file_path', 'src/write-target.ts'),
      detail('startLine', '5'),
    ], {
      kind: 'diff',
      title: 'src/write-target.ts',
      oldText: 'unused',
      newText: 'unused',
      edits: [
        { oldText: 'a', newText: 'b', location: 'edit 1' },
        { oldText: '', newText: '', location: 'edit 2', includeWhenEmpty: false },
        { oldText: '', newText: 'created', location: 'edit 3', includeWhenEmpty: true },
      ],
    })]);

    const artifacts = getSessionDiffArtifacts([read, readResult, write, multi]);

    expect(artifacts[0]).toMatchObject({
      toolName: 'Write',
      oldText: 'old file\ncontents',
      newText: 'new file\ncontents',
      startLine: 1,
    });
    expect(artifacts.slice(1).map(artifact => artifact.toolId)).toEqual(['multi-1:1', 'multi-1:3']);
    expect(artifacts[2]).toMatchObject({ oldText: '', newText: 'created', startLine: 5 });
  });
});
