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
    const now = new Date('2026-05-06T12:00:00.000Z');
    const busySinceMs = now.getTime() - 90_000;
    vi.useFakeTimers();
    vi.setSystemTime(now);

    writeMetadata('session-b', {
      sessionId: 'busy-session',
      cwd: 'D:\\dev\\repo\\busy',
      status: 'busy',
      updatedAt: busySinceMs,
    });

    const { getLiveSessionBySessionId } = await importLiveModule();
    const session = getLiveSessionBySessionId('busy-session');

    expect(session?.status).toBe('busy');
    expect(session?.statusReason).toBe('metadata status is busy');
    expect(session?.busySinceAtMs).toBe(busySinceMs);
    expect(session?.cachePaused).toBeUndefined();
    expect(session?.cacheExpiresAtMs).toBeUndefined();

    vi.setSystemTime(now.getTime() + (2 * 60 * 1000));
    const laterSession = getLiveSessionBySessionId('busy-session');

    expect(laterSession?.busySinceAtMs).toBe(busySinceMs);
    expect(laterSession?.cacheExpiresAtMs).toBeUndefined();
  });

  it('does not expose cache expiry before any user or assistant transcript message exists', async () => {
    const now = new Date('2026-05-06T12:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);

    writeMetadata('empty-session', {
      sessionId: 'empty-session',
      cwd: 'D:\\dev\\repo\\empty',
      status: 'idle',
      updatedAt: now.getTime(),
    });

    const { getLiveSessionBySessionId } = await importLiveModule();
    const session = getLiveSessionBySessionId('empty-session');

    expect(session?.messageCount).toBe(0);
    expect(session?.cacheLastActivityAtMs).toBeUndefined();
    expect(session?.cacheExpiresAtMs).toBeUndefined();
    expect(session?.cachePaused).toBeUndefined();
  });

  it('pauses cache expiry while busy after a user or assistant transcript message exists', async () => {
    const now = new Date('2026-05-06T12:00:00.000Z');
    const sessionId = '00000000-0000-4000-8000-000000000789';
    const messageTimeMs = now.getTime() - (2 * 60 * 1000);
    const projectDir = path.join(projectsDir, 'busy-cache-project');
    vi.useFakeTimers();
    vi.setSystemTime(now);
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, `${sessionId}.jsonl`),
      JSON.stringify({
        type: 'user',
        sessionId,
        timestamp: new Date(messageTimeMs).toISOString(),
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Start the work.' }],
        },
      }),
    );

    writeMetadata('session-busy-cache', {
      sessionId,
      cwd: 'D:\\dev\\repo\\busy-cache',
      status: 'busy',
      updatedAt: now.getTime(),
    });

    const { getLiveSessionBySessionId } = await importLiveModule();
    const session = getLiveSessionBySessionId(sessionId);

    expect(session?.cacheLastActivityAtMs).toBe(messageTimeMs);
    expect(session?.cachePaused).toBe(true);
    expect(session?.cacheExpiresAtMs).toBe(now.getTime() + (5 * 60 * 1000));
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

  it('supports id lookups, transcript revisions, unknown statuses, and cached transcript path refresh', async () => {
    const sessionId = 'lookup-session';
    const projectDir = path.join(projectsDir, 'lookup-project');
    fs.mkdirSync(projectDir, { recursive: true });
    const transcriptPath = path.join(projectDir, `${sessionId}.jsonl`);
    fs.writeFileSync(
      transcriptPath,
      [
        JSON.stringify({
          type: 'assistant',
          sessionId,
          timestamp: '2026-05-06T12:00:00.000Z',
          message: {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'npm test' } },
              { type: 'text', text: 'Running tests.' },
            ],
          },
        }),
        '{bad json',
      ].join('\n'),
    );
    writeMetadata('session-lookup', {
      sessionId,
      cwd: '',
      status: 'paused',
      startedAt: 1_778_067_334,
      updatedAt: '2026-05-06T12:01:00.000Z',
    });

    const {
      getLiveSessionById,
      getLiveSessionBySessionId,
      getLiveTranscriptFilePath,
      getLiveTranscriptRevision,
      resetLiveSessionsForTests,
    } = await importLiveModule();

    const session = getLiveSessionById(sessionId);
    expect(session).toMatchObject({
      id: sessionId,
      projectName: 'lookup-s',
      status: 'unknown',
      statusReason: 'unrecognized metadata status: paused',
      toolCallCount: 1,
      activeToolName: undefined,
    });
    expect(session?.lastPreview).toBe('Bash tool call Running tests.');
    expect(getLiveSessionBySessionId(sessionId)?.metadataFilePath).toContain('session-lookup');
    expect(getLiveTranscriptFilePath(sessionId)).toBe(transcriptPath);
    expect(getLiveTranscriptRevision(sessionId)).toBeDefined();

    fs.unlinkSync(transcriptPath);
    resetLiveSessionsForTests();
    expect(getLiveTranscriptFilePath(sessionId)).toBeNull();
    expect(getLiveTranscriptRevision(sessionId)).toBeUndefined();
  });

  it('refreshes cached live metadata and keeps busy-since timestamps stable', async () => {
    const now = new Date('2026-05-06T12:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);

    writeMetadata('session-refresh', {
      sessionId: 'refresh-session',
      cwd: 'D:/dev/repo/refresh',
      status: 'busy',
      updatedAt: now.getTime(),
    });

    const { getLiveSessionBySessionId } = await importLiveModule();
    const first = getLiveSessionBySessionId('refresh-session');
    expect(first?.busySinceAtMs).toBe(now.getTime());

    vi.setSystemTime(now.getTime() + 90_000);
    const second = getLiveSessionBySessionId('refresh-session');
    expect(second?.busySinceAtMs).toBe(first?.busySinceAtMs);
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

  it('returns an empty list for missing live directories and tolerates watcher setup failures', async () => {
    fs.rmSync(sessionsDir, { recursive: true, force: true });
    const { ensureLiveSessionWatcher, getLiveSessions, resetLiveSessionsForTests } = await importLiveModule();

    expect(getLiveSessions()).toEqual([]);
    expect(() => ensureLiveSessionWatcher()).not.toThrow();

    resetLiveSessionsForTests();
  });
});
