import { describe, expect, it, beforeEach, vi } from 'vitest';
import { POST } from '@/app/api/sessions/[id]/resume/route';

const {
  getAppSettingsMock,
  getActiveDataSourceMock,
  getLiveSessionBySessionIdMock,
  getSessionDetailMock,
  startManagedClaudeResumeMock,
  startMsys2ClaudeResumeMock,
} = vi.hoisted(() => ({
  getAppSettingsMock: vi.fn(),
  getActiveDataSourceMock: vi.fn(),
  getLiveSessionBySessionIdMock: vi.fn(),
  getSessionDetailMock: vi.fn(),
  startManagedClaudeResumeMock: vi.fn(),
  startMsys2ClaudeResumeMock: vi.fn(),
}));

vi.mock('@/lib/claude-data/app-settings', () => ({
  getAppSettings: getAppSettingsMock,
}));

vi.mock('@/lib/claude-data/data-source', () => ({
  getActiveDataSource: getActiveDataSourceMock,
}));

vi.mock('@/lib/claude-data/live-sessions', () => ({
  getLiveSessionBySessionId: getLiveSessionBySessionIdMock,
}));

vi.mock('@/lib/claude-data/reader', () => ({
  getSessionDetail: getSessionDetailMock,
}));

vi.mock('@/lib/claude-data/managed-pty', () => ({
  startManagedClaudeResume: startManagedClaudeResumeMock,
}));

vi.mock('@/lib/claude-data/msys2-launch', () => ({
  startMsys2ClaudeResume: startMsys2ClaudeResumeMock,
}));

vi.mock('@/lib/claude-data/resume-session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/claude-data/resume-session')>();
  return actual;
});

function params(id = '5abbc741-420b-40fc-9c5d-0a3cc4731b6b') {
  return { params: Promise.resolve({ id }) };
}

function request(body?: unknown) {
  return new Request('http://localhost/api/sessions/id/resume', {
    method: 'POST',
    body: body == null ? undefined : JSON.stringify(body),
  });
}

describe('resume session route', () => {
  beforeEach(() => {
    getAppSettingsMock.mockReset();
    getActiveDataSourceMock.mockReset();
    getLiveSessionBySessionIdMock.mockReset();
    getSessionDetailMock.mockReset();
    startManagedClaudeResumeMock.mockReset();
    startMsys2ClaudeResumeMock.mockReset();

    getAppSettingsMock.mockReturnValue({ resumeTransport: 'pty', resumeTransportSource: 'default' });
    getActiveDataSourceMock.mockReturnValue('live');
    getLiveSessionBySessionIdMock.mockReturnValue(null);
    getSessionDetailMock.mockResolvedValue({ cwd: process.cwd() });
    startManagedClaudeResumeMock.mockResolvedValue({ sessionId: '5abbc741-420b-40fc-9c5d-0a3cc4731b6b', isRunning: true });
    startMsys2ClaudeResumeMock.mockReturnValue({ sessionId: '5abbc741-420b-40fc-9c5d-0a3cc4731b6b', isRunning: true });
  });

  it('launches resume from the historical session cwd', async () => {
    const response = await POST(request(), params());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, mode: 'managed-pty' });
    expect(startManagedClaudeResumeMock).toHaveBeenCalledWith('5abbc741-420b-40fc-9c5d-0a3cc4731b6b', process.cwd());
  });

  it('accepts qualified Claude ids and launches with the native id', async () => {
    const response = await POST(request(), params('claude:5abbc741-420b-40fc-9c5d-0a3cc4731b6b'));

    expect(response.status).toBe(200);
    expect(startManagedClaudeResumeMock).toHaveBeenCalledWith('5abbc741-420b-40fc-9c5d-0a3cc4731b6b', process.cwd());
  });

  it('rejects qualified Codex ids before launching Claude', async () => {
    const response = await POST(request(), params('codex:5abbc741-420b-40fc-9c5d-0a3cc4731b6b'));

    expect(response.status).toBe(501);
    await expect(response.json()).resolves.toEqual({ error: 'Codex resume is not supported yet.' });
    expect(startManagedClaudeResumeMock).not.toHaveBeenCalled();
  });

  it('launches resume through MSYS2 launch when configured', async () => {
    getAppSettingsMock.mockReturnValue({ resumeTransport: 'msys2-launch', resumeTransportSource: 'stored' });

    const response = await POST(request(), params());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, mode: 'msys2-launch' });
    expect(startMsys2ClaudeResumeMock).toHaveBeenCalledWith('5abbc741-420b-40fc-9c5d-0a3cc4731b6b', process.cwd());
    expect(startManagedClaudeResumeMock).not.toHaveBeenCalled();
  });

  it('returns the selected transport error when MSYS2 launch fails', async () => {
    getAppSettingsMock.mockReturnValue({ resumeTransport: 'msys2-launch', resumeTransportSource: 'stored' });
    startMsys2ClaudeResumeMock.mockImplementation(() => {
      throw new Error('MSYS2 was not found');
    });

    const response = await POST(request(), params());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: 'MSYS2 was not found' });
    expect(startManagedClaudeResumeMock).not.toHaveBeenCalled();
  });

  it('rejects sessions without cwd before launching', async () => {
    getSessionDetailMock.mockResolvedValue({ cwd: '' });

    const response = await POST(request(), params());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: 'Session cwd is not available.' });
    expect(startManagedClaudeResumeMock).not.toHaveBeenCalled();
  });

  it('rejects cwd values that are not directories', async () => {
    getSessionDetailMock.mockResolvedValue({ cwd: process.execPath });

    const response = await POST(request(), params());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: 'Session cwd does not exist.' });
    expect(startManagedClaudeResumeMock).not.toHaveBeenCalled();
  });
});
