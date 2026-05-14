import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('agent-aware data source helpers', () => {
  const root = path.join(process.cwd(), '.test-artifacts', 'agent-data-source');
  const importDir = path.join(root, 'import');
  const claudeDir = path.join(root, 'home', '.claude');
  const codexDir = path.join(root, 'home', '.codex');
  const copilotDir = path.join(root, 'home', 'Code', 'User');
  const cursorDir = path.join(root, 'home', '.cursor');

  async function loadModule() {
    vi.resetModules();
    return import('@/lib/agent-data/data-source');
  }

  beforeEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    process.env.CLAUD_OMETER_IMPORT_DIR = importDir;
    process.env.CLAUD_OMETER_CLAUDE_DIR = claudeDir;
    process.env.CLAUD_OMETER_CODEX_DIR = codexDir;
    process.env.CLAUD_OMETER_COPILOT_DIR = copilotDir;
    process.env.CLAUD_OMETER_CURSOR_DIR = cursorDir;
    delete process.env.CLAUD_OMETER_AGENTS;
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.CLAUD_OMETER_IMPORT_DIR;
    delete process.env.CLAUD_OMETER_CLAUDE_DIR;
    delete process.env.CLAUD_OMETER_CODEX_DIR;
    delete process.env.CLAUD_OMETER_COPILOT_DIR;
    delete process.env.CLAUD_OMETER_CURSOR_DIR;
    delete process.env.CLAUD_OMETER_AGENTS;
  });

  it('returns no detected agents when local homes are missing', async () => {
    const dataSource = await loadModule();

    expect(dataSource.getDetectedAgents('live')).toEqual([]);
  });

  it('selects Claude for a Claude-only home', async () => {
    fs.mkdirSync(claudeDir, { recursive: true });
    const dataSource = await loadModule();

    expect(dataSource.getDetectedAgents('live')).toEqual(['claude']);
    expect(dataSource.getSelectedAgents('live')).toEqual(['claude']);
  });

  it('selects Codex for a Codex-only home', async () => {
    fs.mkdirSync(codexDir, { recursive: true });
    const dataSource = await loadModule();

    expect(dataSource.getDetectedAgents('live')).toEqual(['codex']);
    expect(dataSource.getSelectedAgents('live')).toEqual(['codex']);
  });

  it('selects Copilot when VS Code workspace transcripts are present', async () => {
    const transcriptsDir = path.join(copilotDir, 'workspaceStorage', 'workspace-hash', 'GitHub.copilot-chat', 'transcripts');
    fs.mkdirSync(transcriptsDir, { recursive: true });
    fs.writeFileSync(path.join(transcriptsDir, 'session.jsonl'), '{}\n');
    const dataSource = await loadModule();

    expect(dataSource.getDetectedAgents('live')).toEqual(['copilot']);
    expect(dataSource.getSelectedAgents('live')).toEqual(['copilot']);
  });

  it('selects Cursor when parent agent transcripts are present', async () => {
    const sessionDir = path.join(cursorDir, 'projects', 'd-dev-research-Claudometer', 'agent-transcripts', 'session-id');
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, 'session-id.jsonl'), '{"role":"user","message":{"content":[{"type":"text","text":"Hello Cursor"}]}}\n');
    fs.mkdirSync(path.join(sessionDir, 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(sessionDir, 'subagents', 'subagent.jsonl'), '{"role":"user","message":{"content":[{"type":"text","text":"Ignore me"}]}}\n');
    const dataSource = await loadModule();

    expect(dataSource.getDetectedAgents('live')).toEqual(['cursor']);
    expect(dataSource.getSelectedAgents('live')).toEqual(['cursor']);
  });

  it('defaults to Claude when both homes exist without saved settings', async () => {
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.mkdirSync(codexDir, { recursive: true });
    const dataSource = await loadModule();

    expect(dataSource.getDetectedAgents('live')).toEqual(['claude', 'codex']);
    expect(dataSource.getSelectedAgents('live')).toEqual(['claude']);
  });

  it('lets env-selected agents override persisted settings', async () => {
    fs.mkdirSync(importDir, { recursive: true });
    fs.writeFileSync(path.join(importDir, 'source-settings.json'), JSON.stringify({ agents: ['claude'] }));
    process.env.CLAUD_OMETER_AGENTS = 'codex,claude';
    const dataSource = await loadModule();

    expect(dataSource.getSelectedAgents('live')).toEqual(['claude', 'codex']);
  });

  it('preserves an explicit empty selected-agent list', async () => {
    fs.mkdirSync(importDir, { recursive: true });
    const dataSource = await loadModule();

    dataSource.setSelectedAgents([]);

    expect(dataSource.getSelectedAgents('live')).toEqual([]);
    expect(JSON.parse(fs.readFileSync(path.join(importDir, 'source-settings.json'), 'utf-8'))).toEqual({ agents: [] });
  });

  it('allows the environment to explicitly disable all agents', async () => {
    process.env.CLAUD_OMETER_AGENTS = 'none';
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.mkdirSync(codexDir, { recursive: true });
    const dataSource = await loadModule();

    expect(dataSource.getDetectedAgents('live')).toEqual(['claude', 'codex']);
    expect(dataSource.getSelectedAgents('live')).toEqual([]);
  });

  it('keeps imported mode behind the existing use-imported flag', async () => {
    fs.mkdirSync(importDir, { recursive: true });
    fs.writeFileSync(path.join(importDir, 'meta.json'), JSON.stringify({ importedAt: 'now' }));
    const dataSource = await loadModule();

    expect(dataSource.getActiveDataSource()).toBe('live');
    dataSource.setDataSource('imported');

    expect(dataSource.getActiveAgentDataSource()).toMatchObject({
      active: 'imported',
      hasImportedData: true,
    });
  });
});
