import { describe, expect, it, beforeEach, vi } from 'vitest';
import { POST } from '@/app/api/sessions/[id]/resume/route';

const {
  getActiveDataSourceMock,
  getLiveSessionBySessionIdMock,
  getSessionDetailMock,
  startManagedClaudeResumeMock,
} = vi.hoisted(() => ({
  getActiveDataSourceMock: vi.fn(),
  getLiveSessionBySessionIdMock: vi.fn(),
  getSessionDetailMock: vi.fn(),
  startManagedClaudeResumeMock: vi.fn(),
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

vi.mock('@/lib/claude-data/resume-session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/claude-data/resume-session')>();
  return actual;
});

function params(id = '5abbc741-420b-40fc-9c5d-0a3cc4731b6b') {
  return { params: Promise.resolve({ id }) };
}

describe('resume session route', () => {
  beforeEach(() => {
    getActiveDataSourceMock.mockReset();
    getLiveSessionBySessionIdMock.mockReset();
    getSessionDetailMock.mockReset();
    startManagedClaudeResumeMock.mockReset();

    getActiveDataSourceMock.mockReturnValue('live');
    getLiveSessionBySessionIdMock.mockReturnValue(null);
    getSessionDetailMock.mockResolvedValue({ cwd: process.cwd() });
    startManagedClaudeResumeMock.mockResolvedValue({ sessionId: '5abbc741-420b-40fc-9c5d-0a3cc4731b6b', isRunning: true });
  });

  it('launches resume from the historical session cwd', async () => {
    const response = await POST(new Request('http://localhost/api/sessions/id/resume', { method: 'POST' }), params());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, mode: 'managed-pty' });
    expect(startManagedClaudeResumeMock).toHaveBeenCalledWith('5abbc741-420b-40fc-9c5d-0a3cc4731b6b', process.cwd());
  });

  it('rejects sessions without cwd before launching', async () => {
    getSessionDetailMock.mockResolvedValue({ cwd: '' });

    const response = await POST(new Request('http://localhost/api/sessions/id/resume', { method: 'POST' }), params());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: 'Session cwd is not available.' });
    expect(startManagedClaudeResumeMock).not.toHaveBeenCalled();
  });

  it('rejects cwd values that are not directories', async () => {
    getSessionDetailMock.mockResolvedValue({ cwd: process.execPath });

    const response = await POST(new Request('http://localhost/api/sessions/id/resume', { method: 'POST' }), params());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: 'Session cwd does not exist.' });
    expect(startManagedClaudeResumeMock).not.toHaveBeenCalled();
  });
});
