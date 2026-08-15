import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('Cursor session discovery', () => {
  const root = path.join(process.cwd(), '.test-artifacts', 'cursor-session-index');
  const cursorDir = path.join(root, 'cursor');
  const cursorUserDir = path.join(root, 'Cursor', 'User');
  const projectId = 'd-dev-research-AgentScope';
  const sessionId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

  async function loadModule() {
    vi.resetModules();
    process.env.AGENT_SCOPE_CURSOR_DIR = cursorDir;
    process.env.AGENT_SCOPE_CURSOR_USER_DIR = cursorUserDir;
    process.env.AGENT_SCOPE_IMPORT_DIR = path.join(root, 'import');
    return import('@/lib/agent-data/providers/cursor/session-index');
  }

  function transcriptPath(name = `${sessionId}.jsonl`): string {
    return path.join(cursorDir, 'projects', projectId, 'agent-transcripts', name);
  }

  beforeEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(transcriptPath()), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.AGENT_SCOPE_CURSOR_DIR;
    delete process.env.AGENT_SCOPE_CURSOR_USER_DIR;
    delete process.env.AGENT_SCOPE_IMPORT_DIR;
    vi.resetModules();
  });

  it('reads Cursor JSONL titles from a bounded prefix only', async () => {
    const assistantLine = JSON.stringify({
      role: 'assistant',
      message: { content: 'assistant filler '.repeat(128) },
    });
    const userLine = JSON.stringify({
      role: 'user',
      message: { content: 'This title is intentionally beyond the discovery prefix.' },
    });
    fs.writeFileSync(
      transcriptPath(),
      [
        assistantLine,
        ...Array.from({ length: 140 }, () => assistantLine),
        userLine,
      ].join('\n'),
    );
    const sessionIndex = await loadModule();

    const sessions = await sessionIndex.discoverCursorSessionFiles();

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      nativeId: sessionId,
      title: undefined,
    });
  });
});
