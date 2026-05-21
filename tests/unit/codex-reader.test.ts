import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('Codex reader', () => {
  const root = path.join(process.cwd(), '.test-artifacts', 'codex-reader');
  const codexDir = path.join(root, '.codex');

  async function loadReader() {
    vi.resetModules();
    process.env.AGENT_SCOPE_CODEX_DIR = codexDir;
    process.env.AGENT_SCOPE_IMPORT_DIR = path.join(root, 'import');
    return import('@/lib/agent-data/providers/codex/reader');
  }

  beforeEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.cpSync(path.join(process.cwd(), 'tests', 'fixtures', 'codex'), codexDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.AGENT_SCOPE_CODEX_DIR;
    delete process.env.AGENT_SCOPE_IMPORT_DIR;
  });

  it('returns sessions sorted by timestamp with provider identity', async () => {
    const reader = await loadReader();

    const sessions = await reader.getSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: 'codex:00000000-0000-0000-0000-000000000001',
      agentKind: 'codex',
      nativeId: '00000000-0000-0000-0000-000000000001',
      title: 'Codex fixture support plan',
      model: 'gpt-5.5',
      gitBranch: 'main',
      version: '0.9.0',
      toolCallCount: 0,
      totalInputTokens: 0,
      totalCacheReadTokens: 0,
      totalOutputTokens: 0,
    });
  });

  it('parses full transcript metrics when loading session detail', async () => {
    const reader = await loadReader();

    const detail = await reader.getSessionDetail('codex:00000000-0000-0000-0000-000000000001');

    expect(detail).toMatchObject({
      id: 'codex:00000000-0000-0000-0000-000000000001',
      toolCallCount: 2,
      totalInputTokens: 125,
      totalCacheReadTokens: 25,
      totalOutputTokens: 18,
      messageCount: 3,
    });
  });

  it('groups projects by cwd and aggregates totals', async () => {
    const reader = await loadReader();

    const projects = await reader.getProjects();

    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({
      agentKind: 'codex',
      name: 'AgentScope',
      sessionCount: 1,
      totalMessages: 0,
      totalTokens: 0,
      models: ['gpt-5.5'],
    });
  });

  it('filters project sessions by qualified project id', async () => {
    const reader = await loadReader();
    const project = (await reader.getProjects())[0];

    await expect(reader.getProjectSessions(project.id)).resolves.toHaveLength(1);
  });

  it('searches user and assistant content', async () => {
    const reader = await loadReader();

    await expect(reader.searchSessions('fixture user text')).resolves.toHaveLength(1);
    await expect(reader.searchSessions('Codex provider and parser')).resolves.toHaveLength(1);
  });
});
