import fs from 'fs';
import path from 'path';

export const fixtureSessionIds = [
  '5f599278-e7e6-4a18-b54f-e4f1c4f6b834',
  'f94b3f9a-85de-4730-877a-7edf4d2244a7',
] as const;

export const toolPairFixtureSessionId = '00000000-0000-4000-8000-00000000e2e1';
export const filteredToolCollapseFixtureSessionId = '00000000-0000-4000-8000-00000000e2e2';

const seededSessionIds = [
  ...fixtureSessionIds,
  toolPairFixtureSessionId,
  filteredToolCollapseFixtureSessionId,
] as const;

function getFixtureSessionPath(sessionId: string): string {
  return path.join(process.cwd(), 'exampleData', `${sessionId}.jsonl`);
}

function writeJsonl(filePath: string, rows: unknown[]): void {
  fs.writeFileSync(filePath, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`);
}

function buildSyntheticSession(sessionId: string, index: number): unknown[] {
  const baseTime = Date.UTC(2026, 4, 3, 16 + index, 0, 0);
  const timestamp = (offsetSeconds: number) => new Date(baseTime + offsetSeconds * 1000).toISOString();

  const rows: unknown[] = [
    {
      type: 'attachment',
      sessionId,
      timestamp: timestamp(0),
      attachment: {
        type: 'file',
        displayPath: 'src/context-builder.ts',
        filename: 'context-builder.ts',
        content: {
          file: {
            filePath: 'src/context-builder.ts',
            numLines: 120,
            totalLines: 240,
            content: Array.from({ length: 12 }, (_, lineIndex) => `export const contextLine${lineIndex} = ${lineIndex};`).join('\n'),
          },
        },
      },
    },
    {
      type: 'user',
      sessionId,
      timestamp: timestamp(1),
      cwd: 'D:/dev/research/Claud-ometer',
      gitBranch: 'main',
      version: '2.1.126',
      message: {
        role: 'user',
        content: 'Context Builder needs review. Please inspect the relevant files and update the transcript notes.',
      },
    },
  ];

  for (let turn = 0; turn < 12; turn += 1) {
    const readId = `read-${index}-${turn}`;
    const editId = `edit-${index}-${turn}`;
    const editFollowupId = `edit-followup-${index}-${turn}`;
    const grepId = `grep-${index}-${turn}`;
    const startLine = 20 + turn * 15;
    const assistantContent = turn === 2
      ? [
        {
          type: 'tool_use',
          id: editId,
          name: 'Edit',
          input: {
            file_path: 'docs/VisualCleanupTasks2.md',
            old_string: [
              '## Notes',
              'The map needs coverage.',
              'Everything else is deferred until a real run demands it.',
              'Keep this preview long enough to expand.',
              'Line five is still collapsed at first.',
              'Line six appears after expansion.',
            ].join('\n'),
            new_string: [
              '## Notes',
              'The map needs coverage.',
              'Everything else is deferred until a real run demands it.',
              'The minimap now gets an e2e guard.',
              'Line five is still collapsed at first.',
              'Line six appears after expansion.',
            ].join('\n'),
            startLine: 41,
          },
        },
        {
          type: 'tool_use',
          id: editFollowupId,
          name: 'Edit',
          input: {
            file_path: 'docs/VisualCleanupTasks2.md',
            old_string: [
              '## Notes',
              'The map needs coverage.',
              'Everything else is deferred until a real run demands it.',
              'The minimap now gets an e2e guard.',
              'Line five is still collapsed at first.',
              'Line six appears after expansion.',
            ].join('\n'),
            new_string: [
              '## Notes',
              'The map needs coverage.',
              'Everything else is deferred until a real run demands it.',
              'The minimap now gets an e2e guard and a diff tab.',
              'Line five is still collapsed at first.',
              'Line six appears after expansion.',
            ].join('\n'),
            startLine: 41,
          },
        },
        { type: 'text', text: `Context Builder turn ${turn}: I found the visual cleanup note.` },
      ]
      : turn === 5
        ? [
          {
            type: 'tool_use',
            id: grepId,
            name: 'Grep',
            input: {
              query: 'FileCacheRepository',
              path: 'src/**/*.cs',
            },
          },
          { type: 'text', text: `Context Builder turn ${turn}: searching for FileCacheRepository references.` },
        ]
      : [
        {
          type: 'tool_use',
          id: readId,
          name: 'Read',
          input: {
            file_path: 'src/context-builder.ts',
            startLine,
            endLine: startLine + 9,
          },
        },
        ...(turn === 6 ? [] : [{ type: 'text', text: `Context Builder turn ${turn}: reviewed lines ${startLine}-${startLine + 9}.` }]),
      ];

    rows.push({
      type: 'assistant',
      sessionId,
      timestamp: timestamp(5 + turn * 4),
      message: {
        id: `assistant-${index}-${turn}`,
        role: 'assistant',
        model: 'claude-opus-4',
        usage: {
          input_tokens: 2000 + turn * 30,
          output_tokens: 80 + turn,
          cache_creation_input_tokens: 120,
          cache_read_input_tokens: 400,
        },
        stop_reason: turn === 11 ? 'end_turn' : 'tool_use',
        content: assistantContent,
      },
    });

    if (turn === 5) {
      rows.push({
        type: 'system',
        sessionId,
        timestamp: timestamp(6 + turn * 4),
        subtype: 'hook_success',
        data: {
          type: 'system',
          statusMessage: 'A system event between tool input and output should not orphan the result.',
        },
      });

      rows.push({
        type: 'user',
        sessionId,
        timestamp: timestamp(7 + turn * 4),
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: grepId,
              content: [
                'TOOL_PAIR_SENTINEL_OUTPUT',
                'src/FileCacheRepository.cs:17: class FileCacheRepository',
                'src/FileCacheRepositoryTests.cs:42: FileCacheRepository handles cache hits',
              ].join('\n'),
            },
          ],
        },
      });

      rows.push({
        type: 'system',
        sessionId,
        subtype: 'untimestamped_fixture',
        messageId: 'UNTIMESTAMPED_SYSTEM_SENTINEL',
      });

      rows.push({
        type: 'system',
        sessionId,
        timestamp: timestamp(7.5 + turn * 4),
        compactMetadata: {
          trigger: 'manual',
          preTokens: 180000,
        },
      });
    } else if (turn !== 2) {
      rows.push({
        type: 'user',
        sessionId,
        timestamp: timestamp(7 + turn * 4),
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: readId,
              content: `Loaded src/context-builder.ts lines ${startLine}-${startLine + 9}.`,
            },
          ],
        },
        toolUseResult: {
          type: 'text',
          filePath: 'src/context-builder.ts',
          content: {
            file: {
              filePath: 'src/context-builder.ts',
              numLines: 10,
              totalLines: 240,
            },
          },
        },
      });
    }

    rows.push({
      type: 'user',
      sessionId,
      timestamp: timestamp(8 + turn * 4),
      message: {
        role: 'user',
        content: `Continue Context Builder pass ${turn}.`,
      },
    });
  }

  return rows;
}

function buildFilteredToolCollapseSession(sessionId: string, index: number): unknown[] {
  const baseTime = Date.UTC(2026, 4, 4, 9 + index, 0, 0);
  const timestamp = (offsetSeconds: number) => new Date(baseTime + offsetSeconds * 1000).toISOString();
  const readId = 'collapse-read-1';
  const grepId = 'collapse-grep-1';

  return [
    {
      type: 'user',
      sessionId,
      timestamp: timestamp(0),
      cwd: 'D:/dev/research/Claud-ometer',
      gitBranch: 'main',
      version: '2.1.126',
      message: {
        role: 'user',
        content: 'Please inspect the files around the filtered tool collapse case.',
      },
    },
    {
      type: 'assistant',
      sessionId,
      timestamp: timestamp(5),
      message: {
        id: 'assistant-filter-collapse-read',
        role: 'assistant',
        model: 'claude-opus-4',
        usage: {
          input_tokens: 1200,
          output_tokens: 60,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 200,
        },
        stop_reason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: readId,
            name: 'Read',
            input: {
              file_path: 'src/filter-collapse.ts',
              startLine: 10,
              endLine: 30,
            },
          },
        ],
      },
    },
    {
      type: 'system',
      sessionId,
      timestamp: timestamp(6),
      subtype: 'hook_success',
      data: {
        type: 'system',
        statusMessage: 'Hidden hook event between two tool-only Claude turns.',
      },
    },
    {
      type: 'user',
      sessionId,
      timestamp: timestamp(6.5),
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: readId,
            content: 'FILTER_COLLAPSE_READ_OUTPUT',
          },
        ],
      },
    },
    {
      type: 'assistant',
      sessionId,
      timestamp: timestamp(7),
      message: {
        id: 'assistant-filter-collapse-grep',
        role: 'assistant',
        model: 'claude-opus-4',
        usage: {
          input_tokens: 1250,
          output_tokens: 65,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 220,
        },
        stop_reason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: grepId,
            name: 'Grep',
            input: {
              query: 'FILTER_COLLAPSE_SENTINEL',
              path: 'src/**/*.ts',
            },
          },
        ],
      },
    },
    {
      type: 'system',
      sessionId,
      timestamp: timestamp(8),
      subtype: 'hook_success',
      data: {
        type: 'system',
        statusMessage: 'Second hidden hook event before tool outputs arrive.',
      },
    },
    {
      type: 'user',
      sessionId,
      timestamp: timestamp(10),
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: grepId,
            content: 'FILTER_COLLAPSE_GREP_OUTPUT',
          },
        ],
      },
    },
  ];
}

function seedSyntheticImportedData(importDir: string): void {
  const claudeDataDir = path.join(importDir, 'claude-data');
  const projectsDir = path.join(claudeDataDir, 'projects');
  fs.mkdirSync(projectsDir, { recursive: true });

  let totalSize = 0;
  for (const [index, sessionId] of seededSessionIds.entries()) {
    const projectDir = path.join(projectsDir, `fixture-project-${sessionId.slice(0, 8)}`);
    fs.mkdirSync(projectDir, { recursive: true });

    const targetPath = path.join(projectDir, `${sessionId}.jsonl`);
    const rows = sessionId === filteredToolCollapseFixtureSessionId
      ? buildFilteredToolCollapseSession(sessionId, index)
      : buildSyntheticSession(sessionId, index);
    writeJsonl(targetPath, rows);
    totalSize += fs.statSync(targetPath).size;
  }

  const exportMeta = {
    exportedAt: '2026-05-03T00:00:00.000Z',
    exportedFrom: 'Fixture data',
  };

  fs.writeFileSync(
    path.join(claudeDataDir, 'export-meta.json'),
    JSON.stringify(exportMeta, null, 2),
  );

  fs.writeFileSync(
    path.join(importDir, 'meta.json'),
    JSON.stringify({
      importedAt: new Date().toISOString(),
      exportedAt: exportMeta.exportedAt,
      exportedFrom: exportMeta.exportedFrom,
      projectCount: seededSessionIds.length,
      sessionCount: seededSessionIds.length,
      fileCount: seededSessionIds.length + 1,
      totalSize,
    }, null, 2),
  );

  fs.writeFileSync(path.join(importDir, '.use-imported'), '1');
}

export function hasFixtureData(): boolean {
  return fixtureSessionIds.every(sessionId => fs.existsSync(getFixtureSessionPath(sessionId)));
}

export function seedImportedData(importDir: string): void {
  fs.rmSync(importDir, { recursive: true, force: true });

  const claudeDataDir = path.join(importDir, 'claude-data');
  const projectsDir = path.join(claudeDataDir, 'projects');
  fs.mkdirSync(projectsDir, { recursive: true });

  let totalSize = 0;
  for (const sessionId of fixtureSessionIds) {
    const sourcePath = getFixtureSessionPath(sessionId);
    if (!fs.existsSync(sourcePath)) {
      seedSyntheticImportedData(importDir);
      return;
    }
    const projectDir = path.join(projectsDir, `fixture-project-${sessionId.slice(0, 8)}`);
    fs.mkdirSync(projectDir, { recursive: true });

    const targetPath = path.join(projectDir, `${sessionId}.jsonl`);
    fs.writeFileSync(targetPath, fs.readFileSync(sourcePath));
    totalSize += fs.statSync(targetPath).size;
  }

  const syntheticProjectDir = path.join(projectsDir, `fixture-project-${toolPairFixtureSessionId.slice(0, 8)}`);
  fs.mkdirSync(syntheticProjectDir, { recursive: true });
  const syntheticTargetPath = path.join(syntheticProjectDir, `${toolPairFixtureSessionId}.jsonl`);
  writeJsonl(syntheticTargetPath, buildSyntheticSession(toolPairFixtureSessionId, fixtureSessionIds.length));
  totalSize += fs.statSync(syntheticTargetPath).size;

  const filteredCollapseProjectDir = path.join(projectsDir, `fixture-project-${filteredToolCollapseFixtureSessionId.slice(0, 8)}`);
  fs.mkdirSync(filteredCollapseProjectDir, { recursive: true });
  const filteredCollapseTargetPath = path.join(filteredCollapseProjectDir, `${filteredToolCollapseFixtureSessionId}.jsonl`);
  writeJsonl(filteredCollapseTargetPath, buildFilteredToolCollapseSession(filteredToolCollapseFixtureSessionId, fixtureSessionIds.length + 1));
  totalSize += fs.statSync(filteredCollapseTargetPath).size;

  const exportMeta = {
    exportedAt: '2026-05-03T00:00:00.000Z',
    exportedFrom: 'Fixture data',
  };

  fs.writeFileSync(
    path.join(claudeDataDir, 'export-meta.json'),
    JSON.stringify(exportMeta, null, 2),
  );

  fs.writeFileSync(
    path.join(importDir, 'meta.json'),
    JSON.stringify({
      importedAt: new Date().toISOString(),
      exportedAt: exportMeta.exportedAt,
      exportedFrom: exportMeta.exportedFrom,
      projectCount: fixtureSessionIds.length + 2,
      sessionCount: fixtureSessionIds.length + 2,
      fileCount: fixtureSessionIds.length + 3,
      totalSize,
    }, null, 2),
  );

  fs.writeFileSync(path.join(importDir, '.use-imported'), '1');
}
