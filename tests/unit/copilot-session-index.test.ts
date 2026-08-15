import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('Copilot session discovery', () => {
  const root = path.join(process.cwd(), '.test-artifacts', 'copilot-session-index');
  const copilotDir = path.join(root, 'copilot');
  const workspaceHash = '48bc27b295ea103e3d172520b17fc2e5';
  const sessionId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

  async function loadModule() {
    vi.resetModules();
    process.env.AGENT_SCOPE_COPILOT_DIR = copilotDir;
    process.env.AGENT_SCOPE_IMPORT_DIR = path.join(root, 'import');
    return import('@/lib/agent-data/providers/copilot/session-index');
  }

  function workspaceDir(): string {
    return path.join(copilotDir, 'workspaceStorage', workspaceHash);
  }

  function transcriptPath(id = sessionId): string {
    return path.join(workspaceDir(), 'GitHub.copilot-chat', 'transcripts', `${id}.jsonl`);
  }

  beforeEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(transcriptPath()), { recursive: true });
    fs.writeFileSync(path.join(workspaceDir(), 'workspace.json'), JSON.stringify({ folder: 'file:///d:/dev/research/AgentScope' }));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.AGENT_SCOPE_COPILOT_DIR;
    delete process.env.AGENT_SCOPE_IMPORT_DIR;
    vi.resetModules();
  });

  it('uses bounded prefix and tail metadata for large transcript discovery', async () => {
    fs.writeFileSync(transcriptPath(), [
      JSON.stringify({
        type: 'session.start',
        data: {
          sessionId,
          producer: 'copilot-agent',
          copilotVersion: '0.46.2',
          vscodeVersion: '1.99.0',
          startTime: '2026-05-04T09:00:00.000Z',
        },
        timestamp: '2026-05-04T09:00:00.000Z',
      }),
      'x'.repeat(140 * 1024),
      JSON.stringify({
        type: 'user.message',
        data: { content: 'This middle title should not be read during discovery.' },
        timestamp: '2026-05-04T09:01:00.000Z',
      }),
      'y'.repeat(140 * 1024),
      JSON.stringify({
        type: 'assistant.message',
        data: { content: 'tail' },
        timestamp: '2026-05-04T09:02:00.000Z',
      }),
    ].join('\n'));
    const sessionIndex = await loadModule();

    const sessions = await sessionIndex.discoverCopilotSessionFiles();

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      nativeId: sessionId,
      createdAt: '2026-05-04T09:00:00.000Z',
      updatedAt: '2026-05-04T09:02:00.000Z',
      producer: 'copilot-agent',
      version: '0.46.2',
      vscodeVersion: '1.99.0',
      title: '',
    });
  });
});
