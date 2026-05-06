import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('live session metadata helpers', () => {
  const rootDir = path.join(process.cwd(), '.test-artifacts', 'live-sessions');
  const sessionsDir = path.join(rootDir, 'sessions');
  const projectsDir = path.join(rootDir, 'projects');
  const previousSessionsDir = process.env.CLAUD_OMETER_LIVE_SESSIONS_DIR;
  const previousProjectsDir = process.env.CLAUD_OMETER_LIVE_PROJECTS_DIR;
  let liveModule: typeof import('@/lib/claude-data/live-sessions') | null = null;

  beforeEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.mkdirSync(projectsDir, { recursive: true });
    process.env.CLAUD_OMETER_LIVE_SESSIONS_DIR = sessionsDir;
    process.env.CLAUD_OMETER_LIVE_PROJECTS_DIR = projectsDir;
    vi.resetModules();
    liveModule = null;
  });

  afterEach(() => {
    liveModule?.resetLiveSessionsForTests();
    vi.useRealTimers();
    fs.rmSync(rootDir, { recursive: true, force: true });
    if (previousSessionsDir == null) delete process.env.CLAUD_OMETER_LIVE_SESSIONS_DIR;
    else process.env.CLAUD_OMETER_LIVE_SESSIONS_DIR = previousSessionsDir;
    if (previousProjectsDir == null) delete process.env.CLAUD_OMETER_LIVE_PROJECTS_DIR;
    else process.env.CLAUD_OMETER_LIVE_PROJECTS_DIR = previousProjectsDir;
    vi.resetModules();
  });

  async function importLiveModule() {
    liveModule = await import('@/lib/claude-data/live-sessions');
    return liveModule;
  }

  function writeMetadata(name: string, metadata: Record<string, unknown>) {
    fs.writeFileSync(path.join(sessionsDir, name), JSON.stringify(metadata));
  }

  it('parses single JSON metadata files into live session summaries', async () => {
    writeMetadata('session-a', {
      pid: 50188,
      sessionId: '5abbc741-420b-40fc-9c5d-0a3cc4731b6b',
      cwd: 'D:\\dev\\repo\\FR01',
      startedAt: 1778067334637,
      version: '2.1.128',
      kind: 'interactive',
      entrypoint: 'cli',
      status: 'idle',
      updatedAt: Date.now(),
    });

    const { getLiveSessions } = await importLiveModule();
    const sessions = getLiveSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      sessionId: '5abbc741-420b-40fc-9c5d-0a3cc4731b6b',
      pid: 50188,
      projectName: 'FR01',
      version: '2.1.128',
      status: 'idle',
      rawStatus: 'idle',
    });
    expect(sessions[0].updatedAtMs).toBeGreaterThan(0);
  });

  it('uses explicit busy metadata as the source of truth', async () => {
    writeMetadata('session-b', {
      sessionId: 'busy-session',
      cwd: 'D:\\dev\\repo\\busy',
      status: 'busy',
      updatedAt: Date.now() - 60 * 60 * 1000,
    });

    const { getLiveSessionBySessionId } = await importLiveModule();
    const session = getLiveSessionBySessionId('busy-session');

    expect(session?.status).toBe('busy');
    expect(session?.statusReason).toBe('metadata status is busy');
  });

  it('keeps status idle when cache expires and bases cache expiry on transcript messages', async () => {
    const now = new Date('2026-05-06T12:00:00.000Z');
    const sessionId = '00000000-0000-4000-8000-000000000456';
    const messageTimeMs = now.getTime() - (4 * 60 * 1000);
    const projectDir = path.join(projectsDir, 'cache-project');
    vi.useFakeTimers();
    vi.setSystemTime(now);
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, `${sessionId}.jsonl`),
      JSON.stringify({
        type: 'assistant',
        sessionId,
        timestamp: new Date(messageTimeMs).toISOString(),
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Cache anchor message.' }],
        },
      }),
    );

    writeMetadata('session-cache', {
      sessionId,
      cwd: 'D:\\dev\\repo\\cache',
      status: 'idle',
      updatedAt: now.getTime(),
    });

    const { getLiveSessionBySessionId } = await importLiveModule();
    const initialSession = getLiveSessionBySessionId(sessionId);
    expect(initialSession?.status).toBe('idle');
    expect(initialSession?.cacheLastActivityAtMs).toBe(messageTimeMs);
    expect(initialSession?.cacheExpiresAtMs).toBe(now.getTime() + (60 * 1000));

    vi.setSystemTime(now.getTime() + (2 * 60 * 1000));
    const session = getLiveSessionBySessionId(sessionId);

    expect(session?.status).toBe('idle');
    expect(session?.cacheExpiresAtMs).toBe(now.getTime() + (60 * 1000));
  });

  it('maps the session id to a project transcript when available', async () => {
    const sessionId = '00000000-0000-4000-8000-000000000123';
    const projectDir = path.join(projectsDir, 'repo-project');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, `${sessionId}.jsonl`),
      JSON.stringify({
        type: 'assistant',
        sessionId,
        timestamp: '2026-05-06T12:00:00.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Latest live response.' }],
        },
      }),
    );
    writeMetadata('session-c', {
      sessionId,
      cwd: 'D:\\dev\\repo\\project',
      status: 'idle',
      updatedAt: Date.now(),
    });

    const { getLiveSessionBySessionId } = await importLiveModule();
    const session = getLiveSessionBySessionId(sessionId);

    expect(session?.transcriptFilePath).toBe(path.join(projectDir, `${sessionId}.jsonl`));
    expect(session?.messageCount).toBe(1);
    expect(session?.lastPreview).toBe('Latest live response.');
    expect(session?.transcriptRevision).toBeDefined();
  });

  it('keeps the last valid metadata record during a partial rewrite', async () => {
    const filePath = path.join(sessionsDir, 'session-d');
    fs.writeFileSync(filePath, JSON.stringify({
      sessionId: 'partial-session',
      cwd: 'D:\\dev\\repo\\partial',
      status: 'idle',
      updatedAt: Date.now(),
    }));

    const { getLiveSessionBySessionId, getLiveSessions } = await importLiveModule();
    expect(getLiveSessionBySessionId('partial-session')?.status).toBe('idle');

    fs.writeFileSync(filePath, '{"sessionId":');
    const sessions = getLiveSessions();

    expect(sessions.find(session => session.sessionId === 'partial-session')?.status).toBe('idle');
  });
});
