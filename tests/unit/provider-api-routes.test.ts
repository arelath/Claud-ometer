import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { codexFixtureSessionId, seedImportedData, toolPairFixtureSessionId } from '../shared/seed-imported-data';

describe('provider API routes', () => {
  const root = path.join(process.cwd(), '.test-artifacts', 'provider-api-routes');
  const codexDir = path.join(root, '.codex');
  const copilotDir = path.join(root, 'copilot');
  const importDir = path.join(root, 'import');
  const copilotFixtureSessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const copilotFixtureWorkspaceHash = '48bc27b295ea103e3d172520b17fc2e5';

  async function setupCodexOnly() {
    fs.rmSync(root, { recursive: true, force: true });
    fs.cpSync(path.join(process.cwd(), 'tests', 'fixtures', 'codex'), codexDir, { recursive: true });
    process.env.CLAUD_OMETER_CODEX_DIR = codexDir;
    process.env.CLAUD_OMETER_COPILOT_DIR = path.join(root, 'copilot-missing');
    process.env.CLAUD_OMETER_CURSOR_DIR = path.join(root, 'cursor-missing');
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
    delete process.env.CLAUD_OMETER_COPILOT_DIR;
    delete process.env.CLAUD_OMETER_CURSOR_DIR;
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

  it('allows no selected agents and returns empty active-provider route payloads', async () => {
    delete process.env.CLAUD_OMETER_AGENTS;
    vi.resetModules();
    const [{ PUT }, { GET: getStats }, { GET: getProjects }, { GET: getSessions }] = await Promise.all([
      import('@/app/api/data-source/route'),
      import('@/app/api/stats/route'),
      import('@/app/api/projects/route'),
      import('@/app/api/sessions/route'),
    ]);

    const response = await PUT(new Request('http://localhost/api/data-source', {
      method: 'PUT',
      body: JSON.stringify({ source: 'live', agents: [] }),
    }));
    const body = await response.json();
    const stats = await (await getStats(new Request('http://localhost/api/stats?agent=active'))).json();
    const projects = await (await getProjects(new Request('http://localhost/api/projects?agent=active'))).json();
    const sessions = await (await getSessions(new Request('http://localhost/api/sessions?agent=active&includeTotal=1'))).json();

    expect(response.status).toBe(200);
    expect(body.agents).toEqual([]);
    expect(stats).toMatchObject({ totalSessions: 0, totalMessages: 0, projectCount: 0 });
    expect(projects).toEqual([]);
    expect(sessions).toMatchObject({ sessions: [], total: 0 });
  });

  it('returns Codex projects, sessions, details, and stats through provider routes', async () => {
    const [{ POST: rebuildCache }, { GET: getProjects }, { GET: getSessions }, { GET: getSession }, { GET: getStats }] = await Promise.all([
      import('@/app/api/cache/route'),
      import('@/app/api/projects/route'),
      import('@/app/api/sessions/route'),
      import('@/app/api/sessions/[id]/route'),
      import('@/app/api/stats/route'),
    ]);
    await rebuildCache();

    const projects = await (await getProjects(new Request('http://localhost/api/projects?agent=codex'))).json();
    const sessions = await (await getSessions(new Request('http://localhost/api/sessions?agent=codex'))).json();
    const pagedSessions = await (await getSessions(new Request('http://localhost/api/sessions?agent=codex&limit=1&offset=0&includeTotal=1'))).json();
    const detail = await (await getSession(
      new Request(`http://localhost/api/sessions/codex:${codexFixtureSessionId}`),
      { params: Promise.resolve({ id: `codex:${codexFixtureSessionId}` }) },
    )).json();
    const stats = await (await getStats(new Request('http://localhost/api/stats?agent=codex'))).json();
    const filteredStats = await (await getStats(new Request('http://localhost/api/stats?agent=codex&start=2026-05-09&end=2026-05-10'))).json();
    const filteredProjects = await (await getProjects(new Request('http://localhost/api/projects?agent=codex&start=2026-05-09&end=2026-05-10'))).json();
    const matchingStats = await (await getStats(new Request('http://localhost/api/stats?agent=codex&start=2026-05-08&end=2026-05-08'))).json();

    expect(projects[0]).toMatchObject({ agentKind: 'codex', name: 'Claud-ometer' });
    expect(sessions[0]).toMatchObject({ agentKind: 'codex', id: `codex:${codexFixtureSessionId}` });
    expect(pagedSessions).toMatchObject({ total: 1, limit: 1, offset: 0 });
    expect(pagedSessions.sessions[0]).toMatchObject({ agentKind: 'codex', id: `codex:${codexFixtureSessionId}` });
    expect(detail).toMatchObject({ agentKind: 'codex', messages: expect.any(Array) });
    expect(stats).toMatchObject({ totalSessions: 1, projectCount: 1 });
    expect(filteredStats).toMatchObject({ totalSessions: 0, projectCount: 0 });
    expect(filteredProjects).toEqual([]);
    expect(matchingStats).toMatchObject({ totalSessions: 1, projectCount: 1 });
  });

  it('returns Copilot projects, sessions, details, and stats through provider routes', async () => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.cpSync(path.join(process.cwd(), 'tests', 'fixtures', 'copilot'), copilotDir, { recursive: true });
    process.env.CLAUD_OMETER_CODEX_DIR = path.join(root, '.codex-missing');
    process.env.CLAUD_OMETER_COPILOT_DIR = copilotDir;
    process.env.CLAUD_OMETER_CURSOR_DIR = path.join(root, 'cursor-missing');
    process.env.CLAUD_OMETER_CLAUDE_DIR = path.join(root, '.claude-missing');
    process.env.CLAUD_OMETER_IMPORT_DIR = importDir;
    process.env.CLAUD_OMETER_AGENTS = 'copilot';
    vi.resetModules();

    const [{ POST: rebuildCache }, { GET: getProjects }, { GET: getSessions }, { GET: getSession }, { GET: getStats }] = await Promise.all([
      import('@/app/api/cache/route'),
      import('@/app/api/projects/route'),
      import('@/app/api/sessions/route'),
      import('@/app/api/sessions/[id]/route'),
      import('@/app/api/stats/route'),
    ]);
    await rebuildCache();

    const routeId = `copilot:${copilotFixtureWorkspaceHash}:${copilotFixtureSessionId}`;
    const projects = await (await getProjects(new Request('http://localhost/api/projects?agent=copilot'))).json();
    const sessions = await (await getSessions(new Request('http://localhost/api/sessions?agent=copilot'))).json();
    const detail = await (await getSession(
      new Request(`http://localhost/api/sessions/${routeId}`),
      { params: Promise.resolve({ id: routeId }) },
    )).json();
    const stats = await (await getStats(new Request('http://localhost/api/stats?agent=copilot'))).json();
    const session = sessions.find((item: { id: string }) => item.id === routeId);

    expect(projects[0]).toMatchObject({ agentKind: 'copilot', id: `copilot:${copilotFixtureWorkspaceHash}`, name: 'Claud-ometer' });
    expect(session).toMatchObject({ agentKind: 'copilot', id: routeId, toolCallCount: 2 });
    expect(detail).toMatchObject({ agentKind: 'copilot', id: routeId, messages: expect.any(Array) });
    expect(stats).toMatchObject({ totalSessions: 3, totalMessages: 10, projectCount: 1 });
  });

  it('lists newly discovered Codex sessions before the summary cache catches up', async () => {
    const [{ POST: rebuildCache }, { GET: getSessions }] = await Promise.all([
      import('@/app/api/cache/route'),
      import('@/app/api/sessions/route'),
    ]);
    await rebuildCache();

    const liveId = '11111111-1111-4111-8111-111111111111';
    const liveTimestamp = '2026-05-12T18:03:00.000Z';
    const liveCwd = 'D:\\dev\\research\\LiveCodex';
    const sessionsDir = path.join(codexDir, 'sessions', '2026', '05', '12');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionsDir, `rollout-2026-05-12T18-03-00-${liveId}.jsonl`),
      [
        JSON.stringify({
          timestamp: liveTimestamp,
          type: 'session_meta',
          payload: { id: liveId, timestamp: liveTimestamp, cwd: liveCwd, cli_version: '0.130.0' },
        }),
        JSON.stringify({
          timestamp: '2026-05-12T18:03:01.000Z',
          type: 'turn_context',
          payload: { cwd: liveCwd, model: 'gpt-5.5' },
        }),
      ].join('\n'),
    );
    fs.appendFileSync(
      path.join(codexDir, 'session_index.jsonl'),
      `\n${JSON.stringify({ id: liveId, thread_name: 'Live Codex Session', updated_at: liveTimestamp })}\n`,
    );

    const page = await (await getSessions(new Request('http://localhost/api/sessions?agent=codex&limit=5&includeTotal=1'))).json();
    const liveSession = page.sessions.find((session: { id: string }) => session.id === `codex:${liveId}`);

    expect(page.total).toBe(2);
    expect(liveSession).toMatchObject({
      agentKind: 'codex',
      title: 'Live Codex Session',
      projectName: 'LiveCodex',
      model: 'gpt-5.5',
    });
  });

  it('aggregates mixed providers, searches both, and preserves legacy Claude details', async () => {
    fs.rmSync(root, { recursive: true, force: true });
    seedImportedData(importDir);
    process.env.CLAUD_OMETER_CLAUDE_DIR = path.join(root, '.claude-missing');
    process.env.CLAUD_OMETER_CODEX_DIR = path.join(root, '.codex-missing');
    process.env.CLAUD_OMETER_COPILOT_DIR = path.join(root, 'copilot-missing');
    process.env.CLAUD_OMETER_CURSOR_DIR = path.join(root, 'cursor-missing');
    process.env.CLAUD_OMETER_IMPORT_DIR = importDir;
    process.env.CLAUD_OMETER_AGENTS = 'claude,codex';
    vi.resetModules();

    const [{ POST: rebuildCache }, { GET: getProjects }, { GET: getSessions }, { GET: getSession }, { GET: getStats }] = await Promise.all([
      import('@/app/api/cache/route'),
      import('@/app/api/projects/route'),
      import('@/app/api/sessions/route'),
      import('@/app/api/sessions/[id]/route'),
      import('@/app/api/stats/route'),
    ]);
    await rebuildCache();

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
