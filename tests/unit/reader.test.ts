import fs from 'fs';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { fixtureSessionIds, hasFixtureData } from '../shared/seed-imported-data';

describe('reader imported-data fixtures', () => {
  const fixtureIt = hasFixtureData() ? it : it.skip;

  fixtureIt('loads projects and sessions from seeded imported data', async () => {
    vi.resetModules();
    const { getProjects, getSessions } = await import('@/lib/claude-data/reader');

    const projects = await getProjects();
    const sessions = await getSessions(10, 0);

    expect(projects.length).toBeGreaterThan(0);
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions.some((session) => fixtureSessionIds.includes(session.id as (typeof fixtureSessionIds)[number]))).toBe(true);
  });

  fixtureIt('preserves multiline block content in session detail', async () => {
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

  fixtureIt('preserves edit tool artifacts for diff previews', async () => {
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

  fixtureIt('parses command messages from local command output', async () => {
    vi.resetModules();
    const { getSessionDetail } = await import('@/lib/claude-data/reader');

    const detail = await getSessionDetail(fixtureSessionIds[0]);
    expect(detail).not.toBeNull();

    const commandMessages = detail?.messages.filter((message) => message.role === 'command') || [];
    expect(commandMessages.length).toBeGreaterThan(0);
    expect(commandMessages.some((message) => message.content.includes('Set model to') || message.content.includes('/model'))).toBe(true);
  });

  fixtureIt('persists prompt breakdown snapshots for assistant turns', async () => {
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

  fixtureIt('captures file-heavy and tool-heavy prompt composition from imported fixtures', async () => {
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

  it('preserves cache writes from hidden thinking snapshots on completed assistant turns', async () => {
    const importDir = path.join(process.cwd(), '.test-artifacts', 'reader-hidden-thinking-cache-write-import');
    const previousImportDir = process.env.CLAUD_OMETER_IMPORT_DIR;
    const sessionId = '00000000-0000-4000-8000-000000000003';
    const projectId = 'hidden-thinking-cache-write-project';
    const projectDir = path.join(importDir, 'claude-data', 'projects', projectId);

    fs.rmSync(importDir, { recursive: true, force: true });
    fs.mkdirSync(projectDir, { recursive: true });

    const mainSessionLines = [
      {
        type: 'user',
        sessionId,
        timestamp: '2026-05-03T10:30:00.000Z',
        message: {
          role: 'user',
          content: 'Please summarize the file.',
        },
      },
      {
        type: 'assistant',
        sessionId,
        timestamp: '2026-05-03T10:30:05.000Z',
        uuid: 'assistant-thinking',
        message: {
          id: 'assistant-turn-hidden-thinking',
          role: 'assistant',
          model: 'claude-opus-4',
          usage: {
            input_tokens: 10,
            output_tokens: 15,
            cache_creation_input_tokens: 120,
            cache_read_input_tokens: 25,
          },
          stop_reason: 'end_turn',
          content: [
            { type: 'thinking', thinking: 'Planning the response.' },
          ],
        },
      },
      {
        type: 'assistant',
        sessionId,
        timestamp: '2026-05-03T10:30:06.000Z',
        uuid: 'assistant-visible',
        message: {
          id: 'assistant-turn-hidden-thinking',
          role: 'assistant',
          model: 'claude-opus-4',
          usage: {
            input_tokens: 10,
            output_tokens: 15,
            cache_creation_input_tokens: 120,
            cache_read_input_tokens: 25,
          },
          stop_reason: 'end_turn',
          content: [
            { type: 'text', text: 'Here is the summary.' },
          ],
        },
      },
    ].map((entry) => JSON.stringify(entry)).join('\n');

    fs.writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), mainSessionLines);
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
        totalSize: mainSessionLines.length,
      }, null, 2),
    );
    fs.writeFileSync(path.join(importDir, '.use-imported'), '1');

    process.env.CLAUD_OMETER_IMPORT_DIR = importDir;
    vi.resetModules();

    try {
      const { getProjects, getSessions, getDashboardStats } = await import('@/lib/claude-data/reader');
      const { calculateCostAllModes } = await import('@/config/pricing');

      const sessions = await getSessions(10, 0);
      const session = sessions.find((candidate) => candidate.id === sessionId);
      const projects = await getProjects();
      const project = projects.find((candidate) => candidate.id === projectId);
      const dashboard = await getDashboardStats();
      const expectedCosts = calculateCostAllModes('claude-opus-4', 10, 15, 240, 25);

      expect(session).toBeDefined();
      expect(session?.assistantMessageCount).toBe(1);
      expect(session?.totalInputTokens).toBe(10);
      expect(session?.totalOutputTokens).toBe(15);
      expect(session?.totalCacheReadTokens).toBe(25);
      expect(session?.totalCacheWriteTokens).toBe(240);
      expect(session?.estimatedCosts.subscription).toBeCloseTo(expectedCosts.subscription, 12);

      expect(project).toBeDefined();
      expect(project?.totalTokens).toBe(290);
      expect(project?.estimatedCosts.subscription).toBeCloseTo(expectedCosts.subscription, 12);

      expect(dashboard.totalTokens).toBe(290);
    } finally {
      process.env.CLAUD_OMETER_IMPORT_DIR = previousImportDir;
      fs.rmSync(importDir, { recursive: true, force: true });
      vi.resetModules();
    }
  });

  it('deduplicates repeated assistant usage and includes subagent models in aggregates', async () => {
    const importDir = path.join(process.cwd(), '.test-artifacts', 'reader-session-aggregate-import');
    const previousImportDir = process.env.CLAUD_OMETER_IMPORT_DIR;
    const sessionId = '00000000-0000-4000-8000-000000000002';
    const projectId = 'session-aggregate-project';
    const projectDir = path.join(importDir, 'claude-data', 'projects', projectId);
    const subagentDir = path.join(projectDir, sessionId, 'subagents');

    fs.rmSync(importDir, { recursive: true, force: true });
    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(subagentDir, { recursive: true });

    const mainSessionLines = [
      {
        type: 'user',
        sessionId,
        timestamp: '2026-05-03T11:00:00.000Z',
        cwd: 'D:/dev/research/Claud-ometer',
        gitBranch: 'main',
        version: '2.1.126',
        message: {
          role: 'user',
          content: 'Use the subagent if needed.',
        },
      },
      {
        type: 'assistant',
        sessionId,
        timestamp: '2026-05-03T11:00:05.000Z',
        uuid: 'assistant-1a',
        message: {
          id: 'assistant-turn-1',
          role: 'assistant',
          model: 'claude-opus-4-7',
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            cache_creation_input_tokens: 30,
            cache_read_input_tokens: 40,
          },
          stop_reason: 'tool_use',
          content: [
            { type: 'tool_use', id: 'tool-1', name: 'Read', input: { filePath: 'src/app.tsx' } },
          ],
        },
      },
      {
        type: 'assistant',
        sessionId,
        timestamp: '2026-05-03T11:00:06.000Z',
        uuid: 'assistant-1b',
        message: {
          id: 'assistant-turn-1',
          role: 'assistant',
          model: 'claude-opus-4-7',
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_creation_input_tokens: 30,
            cache_read_input_tokens: 40,
          },
          stop_reason: 'end_turn',
          content: [
            { type: 'text', text: 'Done with the read.' },
          ],
        },
      },
      {
        type: 'assistant',
        sessionId,
        timestamp: '2026-05-03T11:00:07.000Z',
        uuid: 'assistant-2',
        message: {
          id: 'assistant-turn-2',
          role: 'assistant',
          model: '<synthetic>',
          usage: {
            input_tokens: 5,
            output_tokens: 5,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
          stop_reason: 'end_turn',
          content: [
            { type: 'text', text: 'Synthetic summary.' },
          ],
        },
      },
    ].map((entry) => JSON.stringify(entry)).join('\n');

    const subagentLines = [
      {
        type: 'assistant',
        sessionId,
        timestamp: '2026-05-03T11:00:08.000Z',
        uuid: 'subagent-1',
        message: {
          id: 'subagent-turn-1',
          role: 'assistant',
          model: 'claude-haiku-4-5-20251001',
          usage: {
            input_tokens: 7,
            output_tokens: 3,
            cache_creation_input_tokens: 2,
            cache_read_input_tokens: 11,
          },
          stop_reason: 'end_turn',
          content: [
            { type: 'text', text: 'Subagent result.' },
          ],
        },
      },
    ].map((entry) => JSON.stringify(entry)).join('\n');

    fs.writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), mainSessionLines);
    fs.writeFileSync(path.join(subagentDir, 'agent-haiku.jsonl'), subagentLines);
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
        fileCount: 3,
        totalSize: mainSessionLines.length + subagentLines.length,
      }, null, 2),
    );
    fs.writeFileSync(path.join(importDir, '.use-imported'), '1');

    process.env.CLAUD_OMETER_IMPORT_DIR = importDir;
    vi.resetModules();

    try {
      const { getProjects, getSessions, getDashboardStats } = await import('@/lib/claude-data/reader');
      const { calculateCostAllModes } = await import('@/config/pricing');

      const sessions = await getSessions(10, 0);
      const session = sessions.find((candidate) => candidate.id === sessionId);
      const projects = await getProjects();
      const project = projects.find((candidate) => candidate.id === projectId);
      const dashboard = await getDashboardStats();

      const opusCosts = calculateCostAllModes('claude-opus-4-7', 100, 50, 30, 40);
      const haikuCosts = calculateCostAllModes('claude-haiku-4-5-20251001', 7, 3, 2, 11);

      expect(session).toBeDefined();
      expect(session?.assistantMessageCount).toBe(2);
      expect(session?.toolCallCount).toBe(1);
      expect(session?.totalInputTokens).toBe(112);
      expect(session?.totalOutputTokens).toBe(58);
      expect(session?.totalCacheWriteTokens).toBe(32);
      expect(session?.totalCacheReadTokens).toBe(51);
      expect(session?.models).toEqual(expect.arrayContaining(['Opus', 'Haiku', 'Synthetic']));
      expect(session?.estimatedCosts.subscription).toBeCloseTo(opusCosts.subscription + haikuCosts.subscription, 12);

      expect(project).toBeDefined();
      expect(project?.totalTokens).toBe(253);
      expect(project?.models).toEqual(expect.arrayContaining(['Opus', 'Haiku', 'Synthetic']));
      expect(project?.estimatedCosts.subscription).toBeCloseTo(opusCosts.subscription + haikuCosts.subscription, 12);

      expect(dashboard.totalTokens).toBe(253);
      expect(Object.keys(dashboard.modelUsage)).toEqual(expect.arrayContaining(['claude-opus-4-7', 'claude-haiku-4-5-20251001', '<synthetic>']));
    } finally {
      process.env.CLAUD_OMETER_IMPORT_DIR = previousImportDir;
      fs.rmSync(importDir, { recursive: true, force: true });
      vi.resetModules();
    }
  });
});
