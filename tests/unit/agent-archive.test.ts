import fs from 'fs';
import path from 'path';
import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  countCodexData,
  countCopilotData,
  countCursorData,
  getSafeImportTarget,
  isExcludedCodexExportPath,
  isExcludedCopilotExportPath,
  isExcludedCursorExportPath,
} from '@/lib/agent-data/archive';

describe('agent archives', () => {
  const root = path.join(process.cwd(), '.test-artifacts', 'agent-archive');
  const codexDir = path.join(root, '.codex');
  const copilotDir = path.join(root, 'Code', 'User');
  const cursorDir = path.join(root, '.cursor');
  const importDir = path.join(root, 'import');

  beforeEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    process.env.CLAUD_OMETER_CODEX_DIR = codexDir;
    process.env.CLAUD_OMETER_COPILOT_DIR = copilotDir;
    process.env.CLAUD_OMETER_CURSOR_DIR = cursorDir;
    process.env.CLAUD_OMETER_IMPORT_DIR = importDir;
    process.env.CLAUD_OMETER_AGENTS = 'codex';
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.CLAUD_OMETER_CODEX_DIR;
    delete process.env.CLAUD_OMETER_COPILOT_DIR;
    delete process.env.CLAUD_OMETER_CURSOR_DIR;
    delete process.env.CLAUD_OMETER_IMPORT_DIR;
    delete process.env.CLAUD_OMETER_AGENTS;
    vi.resetModules();
  });

  it('identifies excluded Codex secret and transient paths', () => {
    expect(isExcludedCodexExportPath('auth.json')).toBe(true);
    expect(isExcludedCodexExportPath('cap_sid')).toBe(true);
    expect(isExcludedCodexExportPath('.sandbox/state.json')).toBe(true);
    expect(isExcludedCodexExportPath('plugins/cache/file.json')).toBe(true);
    expect(isExcludedCodexExportPath('logs_2.sqlite')).toBe(true);
    expect(isExcludedCodexExportPath('sessions/2026/05/08/rollout.jsonl')).toBe(false);
  });

  it('identifies excluded Copilot index, memory, and debug paths', () => {
    expect(isExcludedCopilotExportPath('workspaceStorage/hash/GitHub.copilot-chat/codebase-external.sqlite')).toBe(true);
    expect(isExcludedCopilotExportPath('workspaceStorage/hash/GitHub.copilot-chat/debug-logs/session/main.jsonl')).toBe(true);
    expect(isExcludedCopilotExportPath('globalStorage/github.copilot-chat/memory-tool/state.json')).toBe(true);
    expect(isExcludedCopilotExportPath('globalStorage/github.copilot-chat/projectEmbeddings.db')).toBe(true);
    expect(isExcludedCopilotExportPath('workspaceStorage/hash/GitHub.copilot-chat/transcripts/session.jsonl')).toBe(false);
    expect(isExcludedCopilotExportPath('workspaceStorage/hash/chatSessions/session.jsonl')).toBe(false);
  });

  it('identifies excluded Cursor sidecar and database paths', () => {
    expect(isExcludedCursorExportPath('ai-tracking/ai-code-tracking.db')).toBe(true);
    expect(isExcludedCursorExportPath('projects/project/agent-tools/tool.txt')).toBe(true);
    expect(isExcludedCursorExportPath('projects/project/assets/image.png')).toBe(true);
    expect(isExcludedCursorExportPath('projects/project/mcps/server/metadata.json')).toBe(true);
    expect(isExcludedCursorExportPath('projects/project/agent-transcripts/session/subagents/subagent.jsonl')).toBe(true);
    expect(isExcludedCursorExportPath('projects/project/agent-transcripts/session/session.jsonl')).toBe(false);
  });

  it('prevents archive path traversal on import', () => {
    expect(getSafeImportTarget(importDir, 'agent-data/codex/session_index.jsonl')).toBe(path.join(importDir, 'agent-data', 'codex', 'session_index.jsonl'));
    expect(getSafeImportTarget(importDir, '../outside.txt')).toBeNull();
    expect(getSafeImportTarget(importDir, 'agent-data/../../outside.txt')).toBeNull();
  });

  it('exports Codex sessions while excluding secrets', async () => {
    const sessionsDir = path.join(codexDir, 'sessions', '2026', '05', '08');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, 'rollout.jsonl'), '{}\n');
    fs.writeFileSync(path.join(sessionsDir, 'notes.txt'), 'do not export');
    fs.writeFileSync(path.join(codexDir, 'session_index.jsonl'), '{}\n');
    fs.writeFileSync(path.join(codexDir, 'version.json'), '{"version":"0.9.0"}');
    fs.writeFileSync(path.join(codexDir, 'auth.json'), '{"secret":true}');
    fs.mkdirSync(path.join(codexDir, 'plugins'), { recursive: true });
    fs.writeFileSync(path.join(codexDir, 'plugins', 'cached.json'), '{}');

    vi.resetModules();
    const { GET } = await import('@/app/api/export/route');
    const response = await GET();
    const zip = await JSZip.loadAsync(await response.arrayBuffer());
    const names = Object.keys(zip.files);

    expect(response.status).toBe(200);
    expect(names).toContain('agent-data/export-meta.json');
    expect(names).toContain('agent-data/codex/sessions/2026/05/08/rollout.jsonl');
    expect(names).not.toContain('agent-data/codex/sessions/2026/05/08/notes.txt');
    expect(names).toContain('agent-data/codex/session_index.jsonl');
    expect(names).toContain('agent-data/codex/version.json');
    expect(names).not.toContain('agent-data/codex/auth.json');
    expect(names).not.toContain('agent-data/codex/plugins/cached.json');

    const meta = JSON.parse(await zip.file('agent-data/export-meta.json')!.async('string'));
    expect(meta).toMatchObject({
      exportVersion: 2,
      agents: ['codex'],
      agentCounts: { codex: { sessionCount: 1 } },
    });
  });

  it('exports Copilot transcripts while excluding indexes and debug logs', async () => {
    fs.cpSync(path.join(process.cwd(), 'tests', 'fixtures', 'copilot'), copilotDir, { recursive: true });
    const workspaceDir = path.join(copilotDir, 'workspaceStorage', '48bc27b295ea103e3d172520b17fc2e5', 'GitHub.copilot-chat');
    fs.writeFileSync(path.join(workspaceDir, 'codebase-external.sqlite'), 'index');
    fs.mkdirSync(path.join(workspaceDir, 'debug-logs', 'session'), { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, 'debug-logs', 'session', 'main.jsonl'), '{}\n');
    process.env.CLAUD_OMETER_AGENTS = 'copilot';

    vi.resetModules();
    const { GET } = await import('@/app/api/export/route');
    const response = await GET();
    const zip = await JSZip.loadAsync(await response.arrayBuffer());
    const names = Object.keys(zip.files);

    expect(response.status).toBe(200);
    expect(names).toContain('agent-data/copilot/workspaceStorage/48bc27b295ea103e3d172520b17fc2e5/workspace.json');
    expect(names).toContain('agent-data/copilot/workspaceStorage/48bc27b295ea103e3d172520b17fc2e5/GitHub.copilot-chat/transcripts/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl');
    expect(names).toContain('agent-data/copilot/workspaceStorage/48bc27b295ea103e3d172520b17fc2e5/GitHub.copilot-chat/transcripts/cccccccc-cccc-4ccc-8ccc-cccccccccccc.jsonl');
    expect(names).toContain('agent-data/copilot/workspaceStorage/48bc27b295ea103e3d172520b17fc2e5/chatSessions/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl');
    expect(names).toContain('agent-data/copilot/workspaceStorage/48bc27b295ea103e3d172520b17fc2e5/chatSessions/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jsonl');
    expect(names).toContain('agent-data/copilot/workspaceStorage/48bc27b295ea103e3d172520b17fc2e5/chatSessions/cccccccc-cccc-4ccc-8ccc-cccccccccccc.jsonl');
    expect(names).not.toContain('agent-data/copilot/workspaceStorage/48bc27b295ea103e3d172520b17fc2e5/GitHub.copilot-chat/codebase-external.sqlite');
    expect(names).not.toContain('agent-data/copilot/workspaceStorage/48bc27b295ea103e3d172520b17fc2e5/GitHub.copilot-chat/debug-logs/session/main.jsonl');

    const meta = JSON.parse(await zip.file('agent-data/export-meta.json')!.async('string'));
    expect(meta).toMatchObject({
      exportVersion: 2,
      agents: ['copilot'],
      agentCounts: { copilot: { projectCount: 1, sessionCount: 3 } },
    });
  });

  it('exports Cursor parent transcripts while excluding sidecars and subagents', async () => {
    fs.cpSync(path.join(process.cwd(), 'tests', 'fixtures', 'cursor'), cursorDir, { recursive: true });
    process.env.CLAUD_OMETER_AGENTS = 'cursor';

    vi.resetModules();
    const { GET } = await import('@/app/api/export/route');
    const response = await GET();
    const zip = await JSZip.loadAsync(await response.arrayBuffer());
    const names = Object.keys(zip.files);

    expect(response.status).toBe(200);
    expect(names).toContain('agent-data/cursor/projects/d-dev-research-Claudometer/agent-transcripts/cccccccc-cccc-4ccc-8ccc-cccccccccccc/cccccccc-cccc-4ccc-8ccc-cccccccccccc.jsonl');
    expect(names).not.toContain('agent-data/cursor/projects/d-dev-research-Claudometer/agent-transcripts/cccccccc-cccc-4ccc-8ccc-cccccccccccc/subagents/dddddddd-dddd-4ddd-8ddd-dddddddddddd.jsonl');
    expect(names).not.toContain('agent-data/cursor/projects/d-dev-research-Claudometer/agent-tools/tool-sidecar.txt');

    const meta = JSON.parse(await zip.file('agent-data/export-meta.json')!.async('string'));
    expect(meta).toMatchObject({
      exportVersion: 2,
      agents: ['cursor'],
      agentCounts: { cursor: { projectCount: 1, sessionCount: 1 } },
    });
  });

  it('counts Codex projects by distinct cwd values', () => {
    const firstDir = path.join(codexDir, 'sessions', '2026', '05', '08');
    const secondDir = path.join(codexDir, 'sessions', '2026', '05', '09');
    fs.mkdirSync(firstDir, { recursive: true });
    fs.mkdirSync(secondDir, { recursive: true });
    fs.writeFileSync(
      path.join(firstDir, 'one.jsonl'),
      `${JSON.stringify({ type: 'session_meta', payload: { id: 'one', cwd: 'D:/repo/one' } })}\n`,
    );
    fs.writeFileSync(
      path.join(firstDir, 'two.jsonl'),
      `${JSON.stringify({ type: 'turn_context', payload: { cwd: 'D:/repo/one' } })}\n`,
    );
    fs.writeFileSync(
      path.join(secondDir, 'three.jsonl'),
      `${JSON.stringify({ type: 'session_meta', payload: { id: 'three', cwd: 'D:/repo/two' } })}\n`,
    );

    expect(countCodexData(codexDir)).toEqual({ projectCount: 2, sessionCount: 3 });
  });

  it('counts Copilot workspaces with transcripts', () => {
    const firstTranscripts = path.join(copilotDir, 'workspaceStorage', 'workspace-one', 'GitHub.copilot-chat', 'transcripts');
    const secondTranscripts = path.join(copilotDir, 'workspaceStorage', 'workspace-two', 'GitHub.copilot-chat', 'transcripts');
    fs.mkdirSync(firstTranscripts, { recursive: true });
    fs.mkdirSync(secondTranscripts, { recursive: true });
    fs.writeFileSync(path.join(firstTranscripts, 'one.jsonl'), '{}\n');
    fs.writeFileSync(path.join(firstTranscripts, 'two.jsonl'), '{}\n');
    fs.writeFileSync(path.join(secondTranscripts, 'three.jsonl'), '{}\n');

    expect(countCopilotData(copilotDir)).toEqual({ projectCount: 2, sessionCount: 3 });
  });

  it('counts Cursor projects with parent transcripts', () => {
    const firstSession = path.join(cursorDir, 'projects', 'project-one', 'agent-transcripts', 'one');
    const secondSession = path.join(cursorDir, 'projects', 'project-two', 'agent-transcripts', 'two');
    fs.mkdirSync(firstSession, { recursive: true });
    fs.mkdirSync(path.join(firstSession, 'subagents'), { recursive: true });
    fs.mkdirSync(secondSession, { recursive: true });
    fs.writeFileSync(path.join(firstSession, 'one.jsonl'), '{}\n');
    fs.writeFileSync(path.join(firstSession, 'subagents', 'ignored.jsonl'), '{}\n');
    fs.writeFileSync(path.join(secondSession, 'two.jsonl'), '{}\n');

    expect(countCursorData(cursorDir)).toEqual({ projectCount: 2, sessionCount: 2 });
  });

  it('imports legacy claude-data archives as Claude-only imported data', async () => {
    const zip = new JSZip();
    zip.file('claude-data/export-meta.json', JSON.stringify({ exportedAt: '2026-05-08T10:00:00.000Z', exportedFrom: 'legacy' }));
    zip.file('claude-data/projects/project-one/session-one.jsonl', '{}\n');
    const zipBuffer = await zip.generateAsync({ type: 'arraybuffer' });
    const form = new FormData();
    form.append('file', new File([zipBuffer], 'legacy.zip', { type: 'application/zip' }));

    vi.resetModules();
    const { POST } = await import('@/app/api/import/route');
    const response = await POST({ formData: async () => form } as unknown as Request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.meta).toMatchObject({
      exportedFrom: 'legacy',
      agents: ['claude'],
      projectCount: 1,
      sessionCount: 1,
    });
    expect(fs.existsSync(path.join(importDir, 'claude-data', 'projects', 'project-one', 'session-one.jsonl'))).toBe(true);
  });

  it('imports Codex agent-data archives and reads them through the Codex provider', async () => {
    const fixtureDir = path.join(process.cwd(), 'tests', 'fixtures', 'codex');
    const rolloutRelative = 'sessions/2026/05/08/rollout-2026-05-08T10-16-36-00000000-0000-0000-0000-000000000001.jsonl';
    const zip = new JSZip();
    zip.file('agent-data/export-meta.json', JSON.stringify({
      exportVersion: 2,
      exportedAt: '2026-05-08T10:00:00.000Z',
      exportedFrom: 'codex fixture',
      platform: 'test',
      agents: ['codex'],
      agentCounts: { codex: { projectCount: 1, sessionCount: 1 } },
    }));
    zip.file('agent-data/codex/session_index.jsonl', fs.readFileSync(path.join(fixtureDir, 'session_index.jsonl'), 'utf-8'));
    zip.file(`agent-data/codex/${rolloutRelative}`, fs.readFileSync(path.join(fixtureDir, rolloutRelative), 'utf-8'));
    const zipBuffer = await zip.generateAsync({ type: 'arraybuffer' });
    const form = new FormData();
    form.append('file', new File([zipBuffer], 'codex.zip', { type: 'application/zip' }));

    vi.resetModules();
    const { POST } = await import('@/app/api/import/route');
    const response = await POST({ formData: async () => form } as unknown as Request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.meta).toMatchObject({
      exportedFrom: 'codex fixture',
      agents: ['codex'],
      agentCounts: { codex: { projectCount: 1, sessionCount: 1 } },
    });
    expect(fs.existsSync(path.join(importDir, 'agent-data', 'codex', 'session_index.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(importDir, 'agent-data', 'codex', rolloutRelative))).toBe(true);

    vi.resetModules();
    const { getSessions } = await import('@/lib/agent-data/providers/codex/reader');
    await expect(getSessions()).resolves.toEqual([
      expect.objectContaining({
        id: 'codex:00000000-0000-0000-0000-000000000001',
        title: 'Codex fixture support plan',
      }),
    ]);
  });

  it('clears imported data and returns to live mode', async () => {
    fs.mkdirSync(importDir, { recursive: true });
    fs.writeFileSync(path.join(importDir, 'meta.json'), JSON.stringify({ agents: ['codex'] }));
    fs.writeFileSync(path.join(importDir, '.use-imported'), '1');

    vi.resetModules();
    const { DELETE } = await import('@/app/api/import/route');
    const response = await DELETE();

    expect(response.status).toBe(200);
    expect(fs.existsSync(importDir)).toBe(false);
  });
});
