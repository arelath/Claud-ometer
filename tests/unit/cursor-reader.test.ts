import fs from 'fs';
import path from 'path';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const requireForSqlite = createRequire(import.meta.url);

describe('Cursor reader', () => {
  const root = path.join(process.cwd(), '.test-artifacts', 'cursor-reader');
  const cursorDir = path.join(root, 'cursor');
  const cursorUserDir = path.join(root, 'Cursor', 'User');
  const importDir = path.join(root, 'import');
  const projectId = 'd-dev-research-Claudometer';
  const sessionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const chatId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

  function createCursorChatDb() {
    const globalStorageDir = path.join(cursorUserDir, 'globalStorage');
    const workspaceDir = path.join(cursorUserDir, 'workspaceStorage', 'workspace-hash');
    fs.mkdirSync(globalStorageDir, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });

    const dbPath = path.join(globalStorageDir, 'state.vscdb');
    const workspaceDbPath = path.join(workspaceDir, 'state.vscdb');
    const { DatabaseSync } = requireForSqlite('node:sqlite') as {
      DatabaseSync: new (filePath: string) => {
        exec(sql: string): void;
        prepare(sql: string): { run(...params: unknown[]): void };
        close(): void;
      };
    };

    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)');
    db.exec('CREATE TABLE conversation_summaries (conversationId TEXT, title TEXT, tldr TEXT, model TEXT, updatedAt INTEGER)');
    const insert = db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)');
    insert.run(`bubbleId:${chatId}:user-1`, JSON.stringify({
      type: 1,
      conversationId: chatId,
      text: 'Summarize this Cursor chat fixture.',
      tokenCount: { inputTokens: 0, outputTokens: 0 },
      createdAt: '2026-05-01T12:00:00.000Z',
      modelInfo: { modelName: 'gpt-5.2' },
    }));
    insert.run(`bubbleId:${chatId}:assistant-1`, JSON.stringify({
      type: 2,
      conversationId: chatId,
      text: 'This fixture exercises Cursor state database parsing.',
      tokenCount: { inputTokens: 0, outputTokens: 0 },
      createdAt: '2026-05-01T12:00:01.000Z',
      modelInfo: { modelName: 'gpt-5.2' },
      codeBlocks: [{ languageId: 'typescript' }],
    }));
    db.prepare('INSERT INTO conversation_summaries (conversationId, title, tldr, model, updatedAt) VALUES (?, ?, ?, ?, ?)')
      .run(chatId, 'Cursor DB fixture', '', 'gpt-5.2', Date.parse('2026-05-01T12:00:01.000Z'));
    db.close();

    fs.writeFileSync(path.join(workspaceDir, 'workspace.json'), JSON.stringify({ folder: 'file:///d:/dev/research/Claudometer' }));
    const workspaceDb = new DatabaseSync(workspaceDbPath);
    workspaceDb.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)');
    workspaceDb.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)')
      .run('composer.composerData', JSON.stringify({ allComposers: [{ composerId: chatId }] }));
    workspaceDb.close();
  }

  async function loadReader() {
    vi.resetModules();
    process.env.CLAUD_OMETER_CURSOR_DIR = cursorDir;
    process.env.CLAUD_OMETER_CURSOR_USER_DIR = cursorUserDir;
    process.env.CLAUD_OMETER_IMPORT_DIR = importDir;
    return import('@/lib/agent-data/providers/cursor/reader');
  }

  beforeEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.cpSync(path.join(process.cwd(), 'tests', 'fixtures', 'cursor'), cursorDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.CLAUD_OMETER_CURSOR_DIR;
    delete process.env.CLAUD_OMETER_CURSOR_USER_DIR;
    delete process.env.CLAUD_OMETER_IMPORT_DIR;
    vi.resetModules();
  });

  it('returns parent Cursor transcripts with provider identity and project-qualified route ids', async () => {
    const reader = await loadReader();

    const sessions = await reader.getSessions();

    expect(sessions).toHaveLength(2);
    const parent = sessions.find(session => session.nativeId === sessionId);
    expect(parent).toMatchObject({
      id: `cursor:${projectId}:${sessionId}`,
      agentKind: 'cursor',
      nativeId: sessionId,
      projectId: `cursor:${projectId}`,
      projectName: 'Claudometer',
      title: 'Add a compact Cursor fixture for the dashboard.',
      messageCount: 4,
      userMessageCount: 2,
      assistantMessageCount: 2,
      model: 'cursor-agent-auto',
    });
    expect(parent?.totalInputTokens).toBeGreaterThan(0);
    expect(parent?.totalOutputTokens).toBeGreaterThan(0);
  });

  it('parses Cursor transcript messages in order', async () => {
    const reader = await loadReader();

    const detail = await reader.getSessionDetail(`cursor:${projectId}:${sessionId}`);

    expect(detail).toMatchObject({
      id: `cursor:${projectId}:${sessionId}`,
      agentKind: 'cursor',
      messageCount: 4,
      userMessageCount: 2,
      assistantMessageCount: 2,
    });
    expect(detail?.messages.map(message => message.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(detail?.messages[2].content).toContain('Also include multiple content blocks.');
    expect(detail?.messages[2].content).toContain('This should remain in order.');
    expect(detail?.messages[1].usage?.output_tokens).toBeGreaterThan(0);
    expect(detail?.messages[3].usage?.output_tokens).toBeGreaterThan(0);
  });

  it('builds summaries with Cursor agent token estimates', async () => {
    const reader = await loadReader();
    const source = (await reader.discoverSessionSummarySources())
      .find(item => item.sourceFilePath.endsWith(`${sessionId}.jsonl`));

    const summary = await reader.buildSessionSummary(source!);

    expect(summary).toMatchObject({
      provider: 'cursor',
      nativeId: sessionId,
      routeId: `cursor:${projectId}:${sessionId}`,
      nativeProjectId: projectId,
      projectRouteId: `cursor:${projectId}`,
      messageCount: 4,
      toolCallCount: 0,
      model: 'cursor-agent-auto',
      models: ['cursor-agent-auto'],
      changeTotals: {
        addedLines: 0,
        removedLines: 0,
        netLineDelta: 0,
        changedLines: 0,
        fileCount: 0,
        editCount: 0,
      },
    });
    expect(summary.tokenTotals.input).toBeGreaterThan(0);
    expect(summary.tokenTotals.output).toBeGreaterThan(0);
    expect(summary.modelUsage['cursor-agent-auto'].inputTokens).toBe(summary.tokenTotals.input);
    expect(summary.searchTextPreview).toContain('compact cursor fixture');
  });

  it('reads regular Cursor chat sessions from state.vscdb', async () => {
    createCursorChatDb();
    const reader = await loadReader();

    const detail = await reader.getSessionDetail(`cursor:${projectId}:chat:${chatId}`);

    expect(detail).toMatchObject({
      id: `cursor:${projectId}:chat:${chatId}`,
      nativeId: `chat:${chatId}`,
      projectId: `cursor:${projectId}`,
      title: 'Cursor DB fixture',
      model: 'gpt-5.2',
      messageCount: 2,
      userMessageCount: 1,
      assistantMessageCount: 1,
      toolCallCount: 1,
    });
    expect(detail?.messages.map(message => message.role)).toEqual(['user', 'assistant']);
    expect(detail?.totalInputTokens).toBeGreaterThan(0);
    expect(detail?.totalOutputTokens).toBeGreaterThan(0);
    expect(detail?.toolsUsed).toMatchObject({ 'cursor:edit': 1, 'lang:typescript': 1 });
  });
});
