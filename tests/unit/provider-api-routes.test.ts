import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { codexFixtureSessionId, seedImportedData, toolPairFixtureSessionId } from '../shared/seed-imported-data';

describe('provider API routes', () => {
  const root = path.join(process.cwd(), '.test-artifacts', 'provider-api-routes');
  const codexDir = path.join(root, '.codex');
  const importDir = path.join(root, 'import');

  async function setupCodexOnly() {
    fs.rmSync(root, { recursive: true, force: true });
    fs.cpSync(path.join(process.cwd(), 'tests', 'fixtures', 'codex'), codexDir, { recursive: true });
    process.env.CLAUD_OMETER_CODEX_DIR = codexDir;
    process.env.CLAUD_OMETER_CLAUDE_DIR = path.join(root, '.claude-missing');
    process.env.CLAUD_OMETER_IMPORT_DIR = importDir;
    process.env.CLAUD_OMETER_AGENTS = 'codex';
    vi.resetModules();
  }

  beforeEach(async () => {
    await setupCodexOnly();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.CLAUD_OMETER_CODEX_DIR;
    delete process.env.CLAUD_OMETER_CLAUDE_DIR;
    delete process.env.CLAUD_OMETER_IMPORT_DIR;
    delete process.env.CLAUD_OMETER_AGENTS;
    vi.resetModules();
  });

  it('returns selected and detected agents from data-source GET', async () => {
    const { GET } = await import('@/app/api/data-source/route');

    const body = await (await GET()).json();

    expect(body).toMatchObject({
      active: 'live',
      agents: ['codex'],
      detectedAgents: ['codex'],
      hasImportedData: false,
    });
  });

  it('updates selected agents with data-source PUT', async () => {
    delete process.env.CLAUD_OMETER_AGENTS;
    vi.resetModules();
    const { PUT } = await import('@/app/api/data-source/route');

    const response = await PUT(new Request('http://localhost/api/data-source', {
      method: 'PUT',
      body: JSON.stringify({ source: 'live', agents: ['codex'] }),
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.agents).toEqual(['codex']);
  });

  it('returns Codex projects, sessions, details, and stats through provider routes', async () => {
    const [{ GET: getProjects }, { GET: getSessions }, { GET: getSession }, { GET: getStats }] = await Promise.all([
      import('@/app/api/projects/route'),
      import('@/app/api/sessions/route'),
      import('@/app/api/sessions/[id]/route'),
      import('@/app/api/stats/route'),
    ]);

    const projects = await (await getProjects(new Request('http://localhost/api/projects?agent=codex'))).json();
    const sessions = await (await getSessions(new Request('http://localhost/api/sessions?agent=codex'))).json();
    const detail = await (await getSession(
      new Request(`http://localhost/api/sessions/codex:${codexFixtureSessionId}`),
      { params: Promise.resolve({ id: `codex:${codexFixtureSessionId}` }) },
    )).json();
    const stats = await (await getStats(new Request('http://localhost/api/stats?agent=codex'))).json();

    expect(projects[0]).toMatchObject({ agentKind: 'codex', name: 'Claud-ometer' });
    expect(sessions[0]).toMatchObject({ agentKind: 'codex', id: `codex:${codexFixtureSessionId}` });
    expect(detail).toMatchObject({ agentKind: 'codex', messages: expect.any(Array) });
    expect(stats).toMatchObject({ totalSessions: 1, projectCount: 1 });
  });

  it('aggregates mixed providers, searches both, and preserves legacy Claude details', async () => {
    fs.rmSync(root, { recursive: true, force: true });
    seedImportedData(importDir);
    process.env.CLAUD_OMETER_CLAUDE_DIR = path.join(root, '.claude-missing');
    process.env.CLAUD_OMETER_CODEX_DIR = path.join(root, '.codex-missing');
    process.env.CLAUD_OMETER_IMPORT_DIR = importDir;
    process.env.CLAUD_OMETER_AGENTS = 'claude,codex';
    vi.resetModules();

    const [{ GET: getProjects }, { GET: getSessions }, { GET: getSession }, { GET: getStats }] = await Promise.all([
      import('@/app/api/projects/route'),
      import('@/app/api/sessions/route'),
      import('@/app/api/sessions/[id]/route'),
      import('@/app/api/stats/route'),
    ]);

    const projects = await (await getProjects(new Request('http://localhost/api/projects?agent=all'))).json();
    const search = await (await getSessions(new Request('http://localhost/api/sessions?q=Context%20Builder&agent=all&limit=5'))).json();
    const legacyDetail = await (await getSession(
      new Request(`http://localhost/api/sessions/${toolPairFixtureSessionId}`),
      { params: Promise.resolve({ id: toolPairFixtureSessionId }) },
    )).json();
    const codexDetail = await (await getSession(
      new Request(`http://localhost/api/sessions/codex:${codexFixtureSessionId}`),
      { params: Promise.resolve({ id: `codex:${codexFixtureSessionId}` }) },
    )).json();
    const stats = await (await getStats(new Request('http://localhost/api/stats?agent=all'))).json();

    expect(new Set(projects.map((project: { id: string }) => project.id)).size).toBe(projects.length);
    expect(projects.map((project: { agentKind?: string }) => project.agentKind)).toEqual(expect.arrayContaining(['claude', 'codex']));
    expect(search.map((session: { id: string }) => session.id)).toEqual(expect.arrayContaining([
      toolPairFixtureSessionId,
      `codex:${codexFixtureSessionId}`,
    ]));
    expect(legacyDetail).toMatchObject({ id: toolPairFixtureSessionId, agentKind: 'claude' });
    expect(codexDetail).toMatchObject({ id: `codex:${codexFixtureSessionId}`, agentKind: 'codex' });
    expect(stats.totalSessions).toBeGreaterThanOrEqual(5);
    expect(stats.projectCount).toBeGreaterThanOrEqual(4);
  });

  it('rejects invalid provider filters', async () => {
    const { GET } = await import('@/app/api/sessions/route');

    const response = await GET(new Request('http://localhost/api/sessions?agent=other'));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Invalid provider filter' });
  });
});
