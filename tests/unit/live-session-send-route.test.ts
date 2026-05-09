import { beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '@/app/api/live-sessions/[id]/send/route';

const {
  getAppSettingsMock,
  getActiveDataSourceMock,
  getLiveSessionByIdMock,
  sendTextToManagedClaudeSessionMock,
} = vi.hoisted(() => ({
  getAppSettingsMock: vi.fn(),
  getActiveDataSourceMock: vi.fn(),
  getLiveSessionByIdMock: vi.fn(),
  sendTextToManagedClaudeSessionMock: vi.fn(),
}));

vi.mock('@/lib/claude-data/app-settings', () => ({
  getAppSettings: getAppSettingsMock,
}));

vi.mock('@/lib/claude-data/data-source', () => ({
  getActiveDataSource: getActiveDataSourceMock,
}));

vi.mock('@/lib/claude-data/live-sessions', () => ({
  getLiveSessionById: getLiveSessionByIdMock,
}));

vi.mock('@/lib/claude-data/managed-pty', () => ({
  sendTextToManagedClaudeSession: sendTextToManagedClaudeSessionMock,
}));

function request(text: string) {
  return new Request('http://localhost/api/live-sessions/live-id/send', {
    method: 'POST',
    body: JSON.stringify({ text }),
  });
}

function params(id = 'live-id') {
  return { params: Promise.resolve({ id }) };
}

describe('live session send route', () => {
  beforeEach(() => {
    getAppSettingsMock.mockReset();
    getActiveDataSourceMock.mockReset();
    getLiveSessionByIdMock.mockReset();
    sendTextToManagedClaudeSessionMock.mockReset();
    getAppSettingsMock.mockReturnValue({ resumeTransport: 'pty', resumeTransportSource: 'default' });
    getActiveDataSourceMock.mockReturnValue('live');
    getLiveSessionByIdMock.mockReturnValue({
      sessionId: 'live-id',
      status: 'idle',
      cwd: 'D:/dev/project',
    });
    sendTextToManagedClaudeSessionMock.mockReturnValue(null);
  });

  it('rejects app-side sends when MSYS2 launch mode is selected', async () => {
    getAppSettingsMock.mockReturnValue({ resumeTransport: 'msys2-launch', resumeTransportSource: 'stored' });

    const response = await POST(request('  Continue please.  '), params());

    await expect(response.json()).resolves.toEqual({
      error: 'MSYS2 launch mode uses the opened Claude window for input.',
    });
    expect(response.status).toBe(409);
    expect(sendTextToManagedClaudeSessionMock).not.toHaveBeenCalled();
  });

  it('sends text to managed PTY sessions when PTY is selected', async () => {
    sendTextToManagedClaudeSessionMock.mockReturnValue({ sessionId: 'live-id', output: '', isRunning: true });

    const response = await POST(request('  Continue please.  '), params());

    await expect(response.json()).resolves.toMatchObject({ ok: true, target: 'managed-pty' });
    expect(response.status).toBe(200);
    expect(sendTextToManagedClaudeSessionMock).toHaveBeenCalledWith('live-id', 'Continue please.');
  });

  it('accepts qualified Claude ids using the native live id', async () => {
    sendTextToManagedClaudeSessionMock.mockReturnValue({ sessionId: 'live-id', output: '', isRunning: true });

    const response = await POST(request('Continue please.'), params('claude:live-id'));

    expect(response.status).toBe(200);
    expect(getLiveSessionByIdMock).toHaveBeenCalledWith('live-id');
    expect(sendTextToManagedClaudeSessionMock).toHaveBeenCalledWith('live-id', 'Continue please.');
  });

  it('rejects qualified Codex ids', async () => {
    const response = await POST(request('Continue please.'), params('codex:live-id'));

    expect(response.status).toBe(501);
    await expect(response.json()).resolves.toEqual({ error: 'Codex live input is not supported yet.' });
    expect(getLiveSessionByIdMock).not.toHaveBeenCalled();
    expect(sendTextToManagedClaudeSessionMock).not.toHaveBeenCalled();
  });

  it('returns the selected PTY error when no managed PTY session exists', async () => {
    const idleSession = {
      sessionId: 'live-id',
      status: 'idle',
      cwd: 'D:/dev/project',
    };
    getLiveSessionByIdMock.mockReturnValue(idleSession);

    const response = await POST(request('  Continue please.  '), params());

    await expect(response.json()).resolves.toEqual({ error: 'No managed PTY session was found for this live session.' });
    expect(response.status).toBe(409);
    expect(sendTextToManagedClaudeSessionMock).toHaveBeenCalledWith('live-id', 'Continue please.');
  });

  it('blocks busy sessions', async () => {
    getLiveSessionByIdMock.mockReturnValue({
      sessionId: 'live-id',
      status: 'busy',
      cwd: 'D:/dev/project',
    });

    const response = await POST(request('Continue please.'), params());

    await expect(response.json()).resolves.toEqual({ error: 'Claude is busy in this session.' });
    expect(response.status).toBe(409);
    expect(sendTextToManagedClaudeSessionMock).not.toHaveBeenCalled();
  });

  it('requires live data mode', async () => {
    getActiveDataSourceMock.mockReturnValue('imported');

    const response = await POST(request('Continue please.'), params());

    expect(response.status).toBe(409);
    expect(sendTextToManagedClaudeSessionMock).not.toHaveBeenCalled();
  });

  it('rejects empty messages', async () => {
    const response = await POST(request('   '), params());

    expect(response.status).toBe(400);
    expect(sendTextToManagedClaudeSessionMock).not.toHaveBeenCalled();
  });
});
