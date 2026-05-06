import { beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '@/app/api/live-sessions/[id]/send/route';

const {
  getActiveDataSourceMock,
  getLiveSessionByIdMock,
  sendTextToManagedClaudeSessionMock,
  sendTextToTmuxLiveSessionMock,
} = vi.hoisted(() => ({
  getActiveDataSourceMock: vi.fn(),
  getLiveSessionByIdMock: vi.fn(),
  sendTextToManagedClaudeSessionMock: vi.fn(),
  sendTextToTmuxLiveSessionMock: vi.fn(),
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

vi.mock('@/lib/claude-data/tmux-live-input', () => ({
  sendTextToTmuxLiveSession: sendTextToTmuxLiveSessionMock,
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
    getActiveDataSourceMock.mockReset();
    getLiveSessionByIdMock.mockReset();
    sendTextToManagedClaudeSessionMock.mockReset();
    sendTextToTmuxLiveSessionMock.mockReset();
    getActiveDataSourceMock.mockReturnValue('live');
    getLiveSessionByIdMock.mockReturnValue({
      sessionId: 'live-id',
      status: 'idle',
      cwd: 'D:/dev/project',
    });
    sendTextToManagedClaudeSessionMock.mockReturnValue(null);
    sendTextToTmuxLiveSessionMock.mockResolvedValue('%1');
  });

  it('sends text to managed sessions before falling back to tmux', async () => {
    sendTextToManagedClaudeSessionMock.mockReturnValue({ sessionId: 'live-id', output: '', isRunning: true });

    const response = await POST(request('  Continue please.  '), params());

    await expect(response.json()).resolves.toMatchObject({ ok: true, target: 'managed-pty' });
    expect(response.status).toBe(200);
    expect(sendTextToManagedClaudeSessionMock).toHaveBeenCalledWith('live-id', 'Continue please.');
    expect(sendTextToTmuxLiveSessionMock).not.toHaveBeenCalled();
  });

  it('falls back to tmux for external idle sessions', async () => {
    const idleSession = {
      sessionId: 'live-id',
      status: 'idle',
      cwd: 'D:/dev/project',
    };
    getLiveSessionByIdMock.mockReturnValue(idleSession);

    const response = await POST(request('  Continue please.  '), params());

    await expect(response.json()).resolves.toEqual({ ok: true, target: '%1', mode: 'tmux' });
    expect(response.status).toBe(200);
    expect(sendTextToManagedClaudeSessionMock).toHaveBeenCalledWith('live-id', 'Continue please.');
    expect(sendTextToTmuxLiveSessionMock).toHaveBeenCalledWith(idleSession, 'Continue please.');
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
    expect(sendTextToTmuxLiveSessionMock).not.toHaveBeenCalled();
  });

  it('requires live data mode', async () => {
    getActiveDataSourceMock.mockReturnValue('imported');

    const response = await POST(request('Continue please.'), params());

    expect(response.status).toBe(409);
    expect(sendTextToTmuxLiveSessionMock).not.toHaveBeenCalled();
  });

  it('rejects empty messages', async () => {
    const response = await POST(request('   '), params());

    expect(response.status).toBe(400);
    expect(sendTextToTmuxLiveSessionMock).not.toHaveBeenCalled();
  });
});
