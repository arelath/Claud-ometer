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
import { seedSessionSummaryIndex } from '../shared/seed-session-index';

describe('agent archives', () => {
  const root = path.join(process.cwd(), '.test-artifacts', 'agent-archive');
  const codexDir = path.join(root, '.codex');
  const copilotDir = path.join(root, 'Code', 'User');
  const cursorDir = path.join(root, '.cursor');
  const cursorUserDir = path.join(root, 'Cursor', 'User');
  const importDir = path.join(root, 'import');

  beforeEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    process.env.AGENT_SCOPE_CODEX_DIR = codexDir;
    process.env.AGENT_SCOPE_COPILOT_DIR = copilotDir;
    process.env.AGENT_SCOPE_CURSOR_DIR = cursorDir;
    process.env.AGENT_SCOPE_CURSOR_USER_DIR = cursorUserDir;
    process.env.AGENT_SCOPE_IMPORT_DIR = importDir;
    process.env.AGENT_SCOPE_AGENTS = 'codex';
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.AGENT_SCOPE_CODEX_DIR;
    delete process.env.AGENT_SCOPE_COPILOT_DIR;
    delete process.env.AGENT_SCOPE_CURSOR_DIR;
    delete process.env.AGENT_SCOPE_CURSOR_USER_DIR;
    delete process.env.AGENT_SCOPE_IMPORT_DIR;
    delete process.env.AGENT_SCOPE_AGENTS;
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
    expect(isExcludedCursorExportPath('projects/project/agent-transcripts/session/subagents/subagent.jsonl')).toBe(false);
    expect(isExcludedCursorExportPath('projects/project/agent-transcripts/session/session.jsonl')).toBe(false);
    expect(isExcludedCursorExportPath('globalStorage/state.vscdb')).toBe(false);
    expect(isExcludedCursorExportPath('workspaceStorage/hash/workspace.json')).toBe(false);
    expect(isExcludedCursorExportPath('workspaceStorage/hash/state.vscdb')).toBe(false);
    expect(isExcludedCursorExportPath('projects/project/state.vscdb')).toBe(true);
  });

  it('prevents archive path traversal on import', () => {
    expect(getSafeImportTarget(importDir, 'agent-data/codex/session_index.jsonl')).toBe(path.join(importDir, 'agent-data', 'codex', 'session_index.jsonl'));
    expect(getSafeImportTarget(importDir, '../outside.txt')).toBeNull();
    expect(getSafeImportTarget(importDir, 'agent-data/../../outside.txt')).toBeNull();
  });

  it('exports Codex sessions while excluding secrets', async () => {
    fs.cpSync(path.join(process.cwd(), 'tests', 'fixtures', 'codex'), codexDir, { recursive: true });
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
    await seedSessionSummaryIndex();
    const { GET } = await import('@/app/api/export/route');
    const response = await GET();
    const zip = await JSZip.loadAsync(await response.arrayBuffer());
    const names = Object.keys(zip.files);

    expect(response.status).toBe(200);
    expect(names).toContain('agent-data/export-meta.json');
    expect(names).toContain('agent-data/standardized/export-meta.json');
    expect(names).toContain('agent-data/standardized/projects.json');
    expect(names).toContain('agent-data/standardized/sessions.json');
    expect(names).toContain('agent-data/standardized/session-details-index.json');
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
      agentCounts: { codex: { sessionCount: 2 } },
    });

    const standardizedMeta = JSON.parse(await zip.file('agent-data/standardized/export-meta.json')!.async('string'));
    expect(standardizedMeta).toMatchObject({
      standardizedExportVersion: 1,
      schema: 'agentscope.standardized.v1',
      agents: ['codex'],
      files: {
        projects: 'agent-data/standardized/projects.json',
        sessions: 'agent-data/standardized/sessions.json',
        sessionDetailsIndex: 'agent-data/standardized/session-details-index.json',
      },
    });
  });

  it('exports a provider-normalized standardized session layer', async () => {
    fs.cpSync(path.join(process.cwd(), 'tests', 'fixtures', 'codex'), codexDir, { recursive: true });

    vi.resetModules();
    await seedSessionSummaryIndex();
    const { GET } = await import('@/app/api/export/route');
    const response = await GET();
    const zip = await JSZip.loadAsync(await response.arrayBuffer());

    expect(response.status).toBe(200);
    const rawMeta = JSON.parse(await zip.file('agent-data/export-meta.json')!.async('string'));
    const standardizedMeta = JSON.parse(await zip.file('agent-data/standardized/export-meta.json')!.async('string'));
    const projectsPayload = JSON.parse(await zip.file('agent-data/standardized/projects.json')!.async('string'));
    const sessionsPayload = JSON.parse(await zip.file('agent-data/standardized/sessions.json')!.async('string'));
    const detailsIndexPayload = JSON.parse(await zip.file('agent-data/standardized/session-details-index.json')!.async('string'));

    expect(rawMeta).toMatchObject({
      exportVersion: 2,
      agents: ['codex'],
      agentCounts: { codex: { projectCount: 1, sessionCount: 1 } },
    });
    expect(standardizedMeta).toMatchObject({
      standardizedExportVersion: 1,
      schema: 'agentscope.standardized.v1',
      agents: ['codex'],
      projectCount: 1,
      sessionCount: 1,
      sessionDetailCount: 1,
      agentCounts: { codex: { projectCount: 1, sessionCount: 1, sessionDetailCount: 1 } },
      errors: [],
    });
    expect(projectsPayload.projects).toEqual([
      expect.objectContaining({
        agentKind: 'codex',
        id: expect.stringMatching(/^path:/),
        routeId: expect.stringMatching(/^codex:/),
      }),
    ]);
    expect(sessionsPayload.sessions).toEqual([
      expect.objectContaining({
        id: 'codex:00000000-0000-0000-0000-000000000001',
        agentKind: 'codex',
        projectId: expect.stringMatching(/^codex:/),
      }),
    ]);

    const detailEntry = detailsIndexPayload.sessionDetails[0];
    expect(detailEntry).toMatchObject({
      id: 'codex:00000000-0000-0000-0000-000000000001',
      agentKind: 'codex',
      path: expect.stringMatching(/^agent-data\/standardized\/session-details\/codex\//),
    });

    const detail = JSON.parse(await zip.file(detailEntry.path)!.async('string'));
    expect(detail).toMatchObject({
      id: 'codex:00000000-0000-0000-0000-000000000001',
      agentKind: 'codex',
      messages: expect.arrayContaining([
        expect.objectContaining({ role: 'user' }),
        expect.objectContaining({ role: 'assistant' }),
      ]),
    });
  });

  it('exports standardized-only archives without raw provider files', async () => {
    fs.cpSync(path.join(process.cwd(), 'tests', 'fixtures', 'codex'), codexDir, { recursive: true });

    vi.resetModules();
    await seedSessionSummaryIndex();
    const { GET } = await import('@/app/api/export/route');
    const response = await GET(new Request('http://localhost/api/export?format=standardized'));
    const zip = await JSZip.loadAsync(await response.arrayBuffer());
    const names = Object.keys(zip.files);

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Disposition')).toContain('agent-data-standardized-');
    expect(names).toContain('agent-data/standardized/export-meta.json');
    expect(names).toContain('agent-data/standardized/projects.json');
    expect(names).toContain('agent-data/standardized/sessions.json');
    expect(names).toContain('agent-data/standardized/session-details-index.json');
    expect(names).not.toContain('agent-data/export-meta.json');
    expect(names.some(name => name.startsWith('agent-data/codex/'))).toBe(false);

    const standardizedMeta = JSON.parse(await zip.file('agent-data/standardized/export-meta.json')!.async('string'));
    expect(standardizedMeta).toMatchObject({
      standardizedExportVersion: 1,
      schema: 'agentscope.standardized.v1',
      agents: ['codex'],
      projectCount: 1,
      sessionCount: 1,
      sessionDetailCount: 1,
    });
  });

  it('rejects unknown export formats', async () => {
    fs.cpSync(path.join(process.cwd(), 'tests', 'fixtures', 'codex'), codexDir, { recursive: true });

    vi.resetModules();
    await seedSessionSummaryIndex();
    const { GET } = await import('@/app/api/export/route');
    const response = await GET(new Request('http://localhost/api/export?format=raw'));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({ error: 'Invalid export format' });
  });

  it('exports Copilot transcripts while excluding indexes and debug logs', async () => {
    fs.cpSync(path.join(process.cwd(), 'tests', 'fixtures', 'copilot'), copilotDir, { recursive: true });
    const workspaceDir = path.join(copilotDir, 'workspaceStorage', '48bc27b295ea103e3d172520b17fc2e5', 'GitHub.copilot-chat');
    fs.writeFileSync(path.join(workspaceDir, 'codebase-external.sqlite'), 'index');
    fs.mkdirSync(path.join(workspaceDir, 'debug-logs', 'session'), { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, 'debug-logs', 'session', 'main.jsonl'), '{}\n');
    const legacyDir = path.join(copilotDir, 'session-state', 'legacy-session-1');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'workspace.yaml'), 'cwd: D:/repo/legacy-app\n');
    fs.writeFileSync(path.join(legacyDir, 'events.jsonl'), '{}\n');
    process.env.AGENT_SCOPE_AGENTS = 'copilot';

    vi.resetModules();
    await seedSessionSummaryIndex();
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
    expect(names).toContain('agent-data/copilot/session-state/legacy-session-1/events.jsonl');
    expect(names).toContain('agent-data/copilot/session-state/legacy-session-1/workspace.yaml');
    expect(names).not.toContain('agent-data/copilot/workspaceStorage/48bc27b295ea103e3d172520b17fc2e5/GitHub.copilot-chat/codebase-external.sqlite');
    expect(names).not.toContain('agent-data/copilot/workspaceStorage/48bc27b295ea103e3d172520b17fc2e5/GitHub.copilot-chat/debug-logs/session/main.jsonl');

    const meta = JSON.parse(await zip.file('agent-data/export-meta.json')!.async('string'));
    expect(meta).toMatchObject({
      exportVersion: 2,
      agents: ['copilot'],
      agentCounts: { copilot: { projectCount: 2, sessionCount: 4 } },
    });
  });

  it('exports Cursor transcripts and chat databases while excluding sidecars', async () => {
    fs.cpSync(path.join(process.cwd(), 'tests', 'fixtures', 'cursor'), cursorDir, { recursive: true });
    fs.mkdirSync(path.join(cursorUserDir, 'globalStorage'), { recursive: true });
    fs.writeFileSync(path.join(cursorUserDir, 'globalStorage', 'state.vscdb'), 'db');
    fs.mkdirSync(path.join(cursorUserDir, 'workspaceStorage', 'workspace-hash'), { recursive: true });
    fs.writeFileSync(path.join(cursorUserDir, 'workspaceStorage', 'workspace-hash', 'workspace.json'), '{}');
    fs.writeFileSync(path.join(cursorUserDir, 'workspaceStorage', 'workspace-hash', 'state.vscdb'), 'workspace-db');
    process.env.AGENT_SCOPE_AGENTS = 'cursor';

    vi.resetModules();
    await seedSessionSummaryIndex();
    const { GET } = await import('@/app/api/export/route');
    const response = await GET();
    const zip = await JSZip.loadAsync(await response.arrayBuffer());
    const names = Object.keys(zip.files);

    expect(response.status).toBe(200);
    expect(names).toContain('agent-data/cursor/projects/d-dev-research-AgentScope/agent-transcripts/cccccccc-cccc-4ccc-8ccc-cccccccccccc/cccccccc-cccc-4ccc-8ccc-cccccccccccc.jsonl');
    expect(names).toContain('agent-data/cursor/projects/d-dev-research-AgentScope/agent-transcripts/cccccccc-cccc-4ccc-8ccc-cccccccccccc/subagents/dddddddd-dddd-4ddd-8ddd-dddddddddddd.jsonl');
    expect(names).toContain('agent-data/cursor/globalStorage/state.vscdb');
    expect(names).toContain('agent-data/cursor/workspaceStorage/workspace-hash/workspace.json');
    expect(names).toContain('agent-data/cursor/workspaceStorage/workspace-hash/state.vscdb');
    expect(names).not.toContain('agent-data/cursor/projects/d-dev-research-AgentScope/agent-tools/tool-sidecar.txt');

    const meta = JSON.parse(await zip.file('agent-data/export-meta.json')!.async('string'));
    expect(meta).toMatchObject({
      exportVersion: 2,
      agents: ['cursor'],
      agentCounts: { cursor: { projectCount: 1, sessionCount: 2 } },
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

  it('counts Copilot legacy session-state events', () => {
    const firstSession = path.join(copilotDir, 'session-state', 'legacy-one');
    const secondSession = path.join(copilotDir, 'session-state', 'legacy-two');
    fs.mkdirSync(firstSession, { recursive: true });
    fs.mkdirSync(secondSession, { recursive: true });
    fs.writeFileSync(path.join(firstSession, 'workspace.yaml'), 'cwd: D:/repo/one\n');
    fs.writeFileSync(path.join(firstSession, 'events.jsonl'), '{}\n');
    fs.writeFileSync(path.join(secondSession, 'workspace.yaml'), 'cwd: D:/repo/two\n');
    fs.writeFileSync(path.join(secondSession, 'events.jsonl'), '{}\n');

    expect(countCopilotData(copilotDir)).toEqual({ projectCount: 2, sessionCount: 2 });
  });

  it('counts Cursor projects with transcripts and subagents', () => {
    const firstSession = path.join(cursorDir, 'projects', 'project-one', 'agent-transcripts', 'one');
    const secondSession = path.join(cursorDir, 'projects', 'project-two', 'agent-transcripts', 'two');
    fs.mkdirSync(firstSession, { recursive: true });
    fs.mkdirSync(path.join(firstSession, 'subagents'), { recursive: true });
    fs.mkdirSync(secondSession, { recursive: true });
    fs.writeFileSync(path.join(firstSession, 'one.jsonl'), '{}\n');
    fs.writeFileSync(path.join(firstSession, 'subagents', 'ignored.jsonl'), '{}\n');
    fs.writeFileSync(path.join(secondSession, 'two.jsonl'), '{}\n');

    expect(countCursorData(cursorDir)).toEqual({ projectCount: 2, sessionCount: 3 });
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
