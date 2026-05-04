import fs from 'fs';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { fixtureSessionIds } from '../shared/seed-imported-data';

describe('reader imported-data fixtures', () => {
  it('loads projects and sessions from seeded imported data', async () => {
    vi.resetModules();
    const { getProjects, getSessions } = await import('@/lib/claude-data/reader');

    const projects = await getProjects();
    const sessions = await getSessions(10, 0);

    expect(projects.length).toBeGreaterThan(0);
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions.some((session) => fixtureSessionIds.includes(session.id as (typeof fixtureSessionIds)[number]))).toBe(true);
  });

  it('preserves multiline block content in session detail', async () => {
    vi.resetModules();
    const { getSessionDetail } = await import('@/lib/claude-data/reader');

    const detail = await getSessionDetail(fixtureSessionIds[0]);
    expect(detail).not.toBeNull();

    const multilineBlock = detail?.messages
      .flatMap((message) => message.blocks || [])
      .find((block) => typeof block.content === 'string' && block.content.includes('\n'));

    expect(multilineBlock).toBeDefined();
    expect(multilineBlock?.content).toContain('Context Builder Subagent');
  });

  it('preserves edit tool artifacts for diff previews', async () => {
    vi.resetModules();
    const { getSessionDetail } = await import('@/lib/claude-data/reader');

    const detail = await getSessionDetail(fixtureSessionIds[0]);
    expect(detail).not.toBeNull();

    const editTool = detail?.messages
      .flatMap((message) => message.toolCalls || [])
      .find((tool) => tool.name === 'Edit' && tool.artifact?.kind === 'diff');

    expect(editTool?.artifact?.oldText).toContain('## Input');
    expect(editTool?.artifact?.newText).toContain('hints');
  });

  it('parses command messages from local command output', async () => {
    vi.resetModules();
    const { getSessionDetail } = await import('@/lib/claude-data/reader');

    const detail = await getSessionDetail(fixtureSessionIds[0]);
    expect(detail).not.toBeNull();

    const commandMessages = detail?.messages.filter((message) => message.role === 'command') || [];
    expect(commandMessages.length).toBeGreaterThan(0);
    expect(commandMessages.some((message) => message.content.includes('Set model to') || message.content.includes('/model'))).toBe(true);
  });

  it('persists prompt breakdown snapshots for assistant turns', async () => {
    vi.resetModules();
    const { getSessionDetail } = await import('@/lib/claude-data/reader');

    const detail = await getSessionDetail(fixtureSessionIds[0]);
    expect(detail).not.toBeNull();

    const assistantMessages = detail?.messages.filter((message) => message.role === 'assistant') || [];
    expect(assistantMessages.length).toBeGreaterThan(1);
    expect(assistantMessages.every((message) => Boolean(message.promptBreakdown))).toBe(true);

    const firstBreakdown = assistantMessages[0]?.promptBreakdown;
    const secondBreakdown = assistantMessages[1]?.promptBreakdown;
    const latestBreakdown = assistantMessages.at(-1)?.promptBreakdown;

    expect(firstBreakdown).toEqual(secondBreakdown);
    expect(latestBreakdown).toEqual({
      totalTokens: 46215,
      systemTokens: 2258,
      conversationTokens: 833,
      filesTokens: 4933,
      thinkingTokens: 14594,
      toolTokens: 23294,
      otherTokens: 303,
    });
    expect(latestBreakdown).toBeDefined();
    expect(
      (latestBreakdown?.systemTokens || 0)
      + (latestBreakdown?.conversationTokens || 0)
      + (latestBreakdown?.filesTokens || 0)
      + (latestBreakdown?.thinkingTokens || 0)
      + (latestBreakdown?.toolTokens || 0)
      + (latestBreakdown?.otherTokens || 0),
    ).toBe(latestBreakdown?.totalTokens);
  });

  it('captures file-heavy and tool-heavy prompt composition from imported fixtures', async () => {
    vi.resetModules();
    const { getSessionDetail } = await import('@/lib/claude-data/reader');

    const detail = await getSessionDetail(fixtureSessionIds[1]);
    expect(detail).not.toBeNull();

    const latestBreakdown = detail?.messages
      .filter((message) => message.role === 'assistant' && message.promptBreakdown)
      .at(-1)?.promptBreakdown;

    expect(latestBreakdown).toEqual({
      totalTokens: 51896,
      systemTokens: 2243,
      conversationTokens: 147,
      filesTokens: 9140,
      thinkingTokens: 24343,
      toolTokens: 16023,
      otherTokens: 0,
    });
    expect(latestBreakdown?.filesTokens).toBeGreaterThan(0);
    expect(latestBreakdown?.toolTokens).toBeGreaterThan(0);
  });

  it('does not count raw image payload bytes when reconciling prompt totals to usage', async () => {
    const importDir = path.join(process.cwd(), '.test-artifacts', 'reader-prompt-breakdown-import');
    const previousImportDir = process.env.CLAUD_OMETER_IMPORT_DIR;
    const sessionId = '00000000-0000-4000-8000-000000000001';
    const projectId = 'prompt-breakdown-project';
    const projectDir = path.join(importDir, 'claude-data', 'projects', projectId);

    fs.rmSync(importDir, { recursive: true, force: true });
    fs.mkdirSync(projectDir, { recursive: true });

    const lines = [
      {
        type: 'user',
        sessionId,
        timestamp: '2026-05-03T10:00:00.000Z',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'Please review this screenshot.' },
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: 'A'.repeat(20_000),
              },
            },
          ],
        },
      },
      {
        type: 'assistant',
        sessionId,
        timestamp: '2026-05-03T10:00:05.000Z',
        message: {
          role: 'assistant',
          model: 'claude-opus-4',
          usage: {
            input_tokens: 24,
            output_tokens: 12,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
          stop_reason: 'end_turn',
          content: [
            { type: 'thinking', thinking: '', signature: 'S'.repeat(800) },
            { type: 'tool_use', id: 'tool-1', name: 'Read', input: { filePath: 'src/app.ts' } },
            { type: 'text', text: 'I found the relevant file.' },
          ],
        },
      },
      {
        type: 'user',
        sessionId,
        timestamp: '2026-05-03T10:00:08.000Z',
        message: {
          role: 'user',
          content: 'Please continue.',
        },
      },
      {
        type: 'assistant',
        sessionId,
        timestamp: '2026-05-03T10:00:10.000Z',
        message: {
          role: 'assistant',
          model: 'claude-opus-4',
          usage: {
            input_tokens: 80,
            output_tokens: 8,
            cache_creation_input_tokens: 40,
            cache_read_input_tokens: 200,
          },
          stop_reason: 'end_turn',
          content: [
            { type: 'text', text: 'Done.' },
          ],
        },
      },
    ].map((entry) => JSON.stringify(entry)).join('\n');

    fs.writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), lines);
    fs.writeFileSync(
      path.join(importDir, 'claude-data', 'export-meta.json'),
      JSON.stringify({ exportedAt: '2026-05-03T00:00:00.000Z', exportedFrom: 'Unit test' }, null, 2),
    );
    fs.writeFileSync(
      path.join(importDir, 'meta.json'),
      JSON.stringify({
        importedAt: '2026-05-03T00:00:00.000Z',
        exportedAt: '2026-05-03T00:00:00.000Z',
        exportedFrom: 'Unit test',
        projectCount: 1,
        sessionCount: 1,
        fileCount: 2,
        totalSize: lines.length,
      }, null, 2),
    );
    fs.writeFileSync(path.join(importDir, '.use-imported'), '1');

    process.env.CLAUD_OMETER_IMPORT_DIR = importDir;
    vi.resetModules();

    try {
      const { getSessionDetail } = await import('@/lib/claude-data/reader');
      const detail = await getSessionDetail(sessionId);
      const latestBreakdown = detail?.messages
        .filter((message) => message.role === 'assistant' && message.promptBreakdown)
        .at(-1)?.promptBreakdown;

      expect(latestBreakdown).toBeDefined();
      expect(latestBreakdown?.totalTokens).toBe(320);
      expect(latestBreakdown?.conversationTokens).toBeGreaterThan(0);
      expect(latestBreakdown?.otherTokens).toBeLessThan(1_000);
    } finally {
      process.env.CLAUD_OMETER_IMPORT_DIR = previousImportDir;
      fs.rmSync(importDir, { recursive: true, force: true });
      vi.resetModules();
    }
  });
});