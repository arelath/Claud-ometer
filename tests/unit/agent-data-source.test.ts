import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('agent-aware data source helpers', () => {
  const root = path.join(process.cwd(), '.test-artifacts', 'agent-data-source');
  const importDir = path.join(root, 'import');
  const claudeDir = path.join(root, 'home', '.claude');
  const codexDir = path.join(root, 'home', '.codex');

  async function loadModule() {
    vi.resetModules();
    return import('@/lib/agent-data/data-source');
  }

  beforeEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    process.env.CLAUD_OMETER_IMPORT_DIR = importDir;
    process.env.CLAUD_OMETER_CLAUDE_DIR = claudeDir;
    process.env.CLAUD_OMETER_CODEX_DIR = codexDir;
    delete process.env.CLAUD_OMETER_AGENTS;
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.CLAUD_OMETER_IMPORT_DIR;
    delete process.env.CLAUD_OMETER_CLAUDE_DIR;
    delete process.env.CLAUD_OMETER_CODEX_DIR;
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
