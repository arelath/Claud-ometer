import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('reader synthetic display parsing', () => {
  const importDir = path.join(process.cwd(), '.test-artifacts', 'reader-synthetic-display');
  const projectId = 'D-dev-Synthetic';
  const sessionId = '11111111-1111-4111-8111-111111111111';
  const projectDir = path.join(importDir, 'claude-data', 'projects', projectId);
  const sessionPath = path.join(projectDir, `${sessionId}.jsonl`);
  const previousImportDir = process.env.CLAUD_OMETER_IMPORT_DIR;

  beforeEach(() => {
    fs.rmSync(importDir, { recursive: true, force: true });
    fs.mkdirSync(projectDir, { recursive: true });
    process.env.CLAUD_OMETER_IMPORT_DIR = importDir;
    vi.resetModules();
  });

  afterEach(() => {
    fs.rmSync(importDir, { recursive: true, force: true });
    if (previousImportDir == null) delete process.env.CLAUD_OMETER_IMPORT_DIR;
    else process.env.CLAUD_OMETER_IMPORT_DIR = previousImportDir;
    vi.resetModules();
  });

  function writeSession(lines: unknown[]) {
    fs.writeFileSync(sessionPath, lines.map(line => JSON.stringify(line)).join('\n'));
    fs.writeFileSync(
      path.join(importDir, 'meta.json'),
      JSON.stringify({
        importedAt: '2026-05-08T12:00:00.000Z',
        exportedAt: '2026-05-08T12:00:00.000Z',
        exportedFrom: 'Synthetic fixture',
        projectCount: 1,
        sessionCount: 1,
        fileCount: 2,
        totalSize: 1234,
      }),
    );
    fs.writeFileSync(path.join(importDir, '.use-imported'), '1');
  }

  it('parses commands, tool results, assistant blocks, attachments, search, and dashboard aggregates', async () => {
    writeSession([
      {
        type: 'user',
        sessionId,
        timestamp: '2026-05-08T12:00:00.000Z',
        cwd: 'D:/dev/Synthetic',
        gitBranch: 'feature/synthetic',
        version: '2.1.130',
        message: {
          role: 'user',
          content: '<command-name>/model</command-name><command-args>opus</command-args>',
        },
      },
      {
        type: 'user',
        sessionId,
        timestamp: '2026-05-08T12:00:01.000Z',
        isMeta: true,
        message: {
          role: 'user',
          content: '<local-command-stdout>\u001b[31mstdout text\u001b[0m</local-command-stdout>',
        },
      },
      {
        type: 'user',
        sessionId,
        timestamp: '2026-05-08T12:00:02.000Z',
        message: {
          role: 'user',
          content: '<local-command-caveat>command caveat</local-command-caveat>',
        },
      },
      {
        type: 'user',
        sessionId,
        timestamp: '2026-05-08T12:00:03.000Z',
        sourceToolAssistantUUID: 'assistant-source',
        toolUseResult: {
          type: 'file',
          filePath: 'src/app.ts',
          content: { file: { content: 'const value = 1;', numLines: 1, totalLines: 1 } },
        },
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'needle from the user' },
            { type: 'tool_result', tool_use_id: 'read-1', content: [{ type: 'text', text: 'read result body' }] },
          ],
        },
      },
      {
        type: 'user',
        sessionId,
        timestamp: '2026-05-08T12:00:03.500Z',
        toolUseResult: {
          type: 'bash',
          stdout: 'standalone output',
          exitCode: 0,
        },
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'bash-previous', content: 'standalone output' },
          ],
        },
      },
      {
        type: 'assistant',
        sessionId,
        uuid: 'assistant-1a',
        timestamp: '2026-05-08T12:00:04.000Z',
        message: {
          id: 'assistant-1',
          role: 'assistant',
          model: 'claude-opus-4',
          usage: {
            input_tokens: 5000,
            output_tokens: 25,
            cache_creation_input_tokens: 10,
            cache_read_input_tokens: 15,
          },
          stop_reason: 'tool_use',
          content: [
            { type: 'thinking', thinking: 'thinking line one\nthinking line two', signature: 'abc123' },
            { type: 'text', text: 'needle from the assistant' },
            {
              type: 'tool_use',
              id: 'edit-1',
              name: 'Edit',
              input: {
                file_path: 'src/app.ts',
                old_string: 'const value = 1;',
                new_string: 'const value = 2;',
                startLine: 1,
              },
            },
          ],
        },
      },
      {
        type: 'assistant',
        sessionId,
        uuid: 'assistant-tool-only',
        timestamp: '2026-05-08T12:00:05.000Z',
        message: {
          id: 'assistant-2',
          role: 'assistant',
          model: 'claude-sonnet-4',
          usage: {
            input_tokens: 6000,
            output_tokens: 5,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
          stop_reason: 'tool_use',
          content: [
            { type: 'tool_use', id: 'bash-1', name: 'Bash', input: { command: 'npm test\nnpm run lint', goal: 'verify', mode: 'safe' } },
          ],
        },
      },
      {
        type: 'attachment',
        sessionId,
        timestamp: '2026-05-08T12:00:06.000Z',
        attachment: {
          type: 'file',
          displayPath: 'src/context.ts',
          content: { file: { filePath: 'src/context.ts', content: 'context file', totalLines: 1 } },
        },
      },
      {
        type: 'system',
        subtype: 'hook',
        sessionId,
        timestamp: '2026-05-08T12:00:07.000Z',
        permissionMode: 'acceptEdits',
        level: 'info',
        command: 'post-tool hook',
      },
      {
        type: 'user',
        sessionId,
        timestamp: '2026-05-08T12:00:08.000Z',
        compactMetadata: { trigger: 'manual', preTokens: 9000 },
        message: { role: 'user', content: 'compact summary' },
      },
      {
        type: 'user',
        sessionId,
        timestamp: '2026-05-08T12:00:09.000Z',
        microcompactMetadata: {
          trigger: 'auto',
          preTokens: 9000,
          tokensSaved: 123,
          compactedToolIds: [],
          clearedAttachmentUUIDs: [],
        },
        message: { role: 'user', content: 'micro compact summary' },
      },
    ]);

    const reader = await import('@/lib/claude-data/reader');
    const detail = await reader.getSessionDetail(sessionId);
    const projects = await reader.getProjects();
    const sessions = await reader.getSessions(10, 0);
    const projectSessions = await reader.getProjectSessions(projectId);
    const searchUser = await reader.searchSessions('needle from the user', 10);
    const searchAssistant = await reader.searchSessions('needle from the assistant', 10);
    const dashboard = await reader.getDashboardStats();

    expect(detail?.cwd).toBe('D:/dev/Synthetic');
    expect(detail?.gitBranch).toBe('feature/synthetic');
    expect(detail?.messages.map(message => message.role)).toEqual(expect.arrayContaining([
      'command',
      'user',
      'assistant',
      'tool-use',
      'system',
      'tool-result',
    ]));
    expect(detail?.messages.find(message => message.role === 'command')?.content).toBe('/model opus');
    expect(detail?.messages.find(message => message.role === 'assistant')?.blocks?.some(block => block.type === 'thinking')).toBe(true);
    expect(detail?.messages.flatMap(message => message.toolCalls || []).find(tool => tool.name === 'Edit')?.artifact?.kind).toBe('diff');
    expect(detail?.compaction.compactions).toBe(1);
    expect(detail?.compaction.microcompactions).toBe(1);
    expect(detail?.compaction.totalTokensSaved).toBe(123);

    expect(projects[0]).toMatchObject({ id: projectId, name: 'Synthetic', sessionCount: 1 });
    expect(sessions[0].id).toBe(sessionId);
    expect(projectSessions[0].id).toBe(sessionId);
    expect(searchUser[0].id).toBe(sessionId);
    expect(searchAssistant[0].id).toBe(sessionId);
    expect(dashboard.projectCount).toBe(1);
    expect(dashboard.totalSessions).toBeGreaterThanOrEqual(1);
    expect(dashboard.recentSessions[0].id).toBe(sessionId);
  });

  it('reads stats cache and history files with invalid lines ignored', async () => {
    fs.writeFileSync(path.join(importDir, 'claude-data', 'stats-cache.json'), JSON.stringify({
      version: 3,
      lastComputedDate: '2026-05-07',
      dailyActivity: [{ date: '2026-05-07', messageCount: 1, sessionCount: 1, toolCallCount: 0 }],
      dailyModelTokens: [{ date: '2026-05-07', tokensByModel: { 'claude-opus-4': 100 } }],
      modelUsage: {
        'claude-opus-4': {
          inputTokens: 70,
          outputTokens: 30,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          costUSD: 0,
          contextWindow: 200000,
          maxOutputTokens: 4096,
          webSearchRequests: 0,
        },
      },
      totalSessions: 1,
      totalMessages: 1,
      longestSession: { sessionId, duration: 1, messageCount: 1, timestamp: '2026-05-07T12:00:00.000Z' },
      firstSessionDate: '2026-05-07',
      hourCounts: { '12': 1 },
      totalSpeculationTimeSavedMs: 0,
    }));
    fs.writeFileSync(path.join(importDir, 'claude-data', 'history.jsonl'), [
      JSON.stringify({ display: 'valid', pastedContents: {}, timestamp: 1, project: projectId }),
      '{bad json',
    ].join('\n'));
    fs.writeFileSync(
      path.join(importDir, 'meta.json'),
      JSON.stringify({
        importedAt: '2026-05-08T12:00:00.000Z',
        exportedAt: '2026-05-08T12:00:00.000Z',
        exportedFrom: 'Synthetic fixture',
        projectCount: 0,
        sessionCount: 0,
      }),
    );
    fs.writeFileSync(path.join(importDir, '.use-imported'), '1');

    const reader = await import('@/lib/claude-data/reader');

    expect(reader.getStatsCache()?.lastComputedDate).toBe('2026-05-07');
    expect(reader.getHistory()).toHaveLength(1);
    expect(await reader.searchSessions('', 5)).toEqual([]);
    expect(await reader.getSessionDetail('missing')).toBeNull();
  });

  it('keeps tool calls when prompt breakdown estimation exceeds reported usage', async () => {
    writeSession([
      {
        type: 'user',
        sessionId,
        timestamp: '2026-05-08T12:00:00.000Z',
        cwd: 'D:/dev/Synthetic',
        message: {
          role: 'user',
          content: 'This deliberately long prompt has more than one token, so the synthetic usage below cannot cover the estimated prompt breakdown.',
        },
      },
      {
        type: 'assistant',
        sessionId,
        uuid: 'assistant-write',
        timestamp: '2026-05-08T12:00:01.000Z',
        message: {
          id: 'assistant-write',
          role: 'assistant',
          model: 'claude-opus-4',
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
          stop_reason: 'tool_use',
          content: [
            {
              type: 'tool_use',
              id: 'write-1',
              name: 'Write',
              input: {
                file_path: 'src/generated.md',
                content: '# Generated\n\nbody',
              },
            },
          ],
        },
      },
    ]);

    const reader = await import('@/lib/claude-data/reader');
    const { getSessionDiffSummary } = await import('@/lib/session-diff');
    const detail = await reader.getSessionDetail(sessionId);
    const writeTool = detail?.messages.flatMap(message => message.toolCalls || []).find(tool => tool.name === 'Write');
    const diffSummary = getSessionDiffSummary(detail?.messages || []);

    expect(writeTool?.artifact).toMatchObject({
      kind: 'diff',
      newText: '# Generated\n\nbody',
    });
    expect(diffSummary).toMatchObject({
      fileCount: 1,
      editCount: 1,
      addedLines: 3,
    });
    expect(diffSummary.files[0].path).toBe('src/generated.md');
  });
});
