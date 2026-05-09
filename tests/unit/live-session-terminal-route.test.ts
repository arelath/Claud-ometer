import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET, POST } from '@/app/api/live-sessions/[id]/terminal/route';

const {
  getManagedClaudeSessionMock,
  resizeManagedClaudeSessionMock,
  sendTextToManagedClaudeSessionMock,
  writeDataToManagedClaudeSessionMock,
} = vi.hoisted(() => ({
  getManagedClaudeSessionMock: vi.fn(),
  resizeManagedClaudeSessionMock: vi.fn(),
  sendTextToManagedClaudeSessionMock: vi.fn(),
  writeDataToManagedClaudeSessionMock: vi.fn(),
}));

vi.mock('@/lib/claude-data/managed-pty', () => ({
  getManagedClaudeSession: getManagedClaudeSessionMock,
  resizeManagedClaudeSession: resizeManagedClaudeSessionMock,
  sendTextToManagedClaudeSession: sendTextToManagedClaudeSessionMock,
  writeDataToManagedClaudeSession: writeDataToManagedClaudeSessionMock,
}));

function params(id = '00000000-0000-4000-8000-000000000123') {
  return { params: Promise.resolve({ id }) };
}

describe('live session terminal route', () => {
  beforeEach(() => {
    getManagedClaudeSessionMock.mockReset();
    resizeManagedClaudeSessionMock.mockReset();
    sendTextToManagedClaudeSessionMock.mockReset();
    writeDataToManagedClaudeSessionMock.mockReset();
  });

  it('returns the managed terminal snapshot for a session', async () => {
    getManagedClaudeSessionMock.mockReturnValue({
      sessionId: '00000000-0000-4000-8000-000000000123',
      output: 'Claude is ready',
      isRunning: true,
      sequence: 2,
    });

    const response = await GET(new Request('http://localhost/api/live-sessions/id/terminal'), params());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      sessionId: '00000000-0000-4000-8000-000000000123',
      output: 'Claude is ready',
      isRunning: true,
    });
    expect(getManagedClaudeSessionMock).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000123');
  });

  it('uses native ids for qualified Claude terminal requests', async () => {
    getManagedClaudeSessionMock.mockReturnValue({
      sessionId: '00000000-0000-4000-8000-000000000123',
      output: 'Claude is ready',
      isRunning: true,
    });

    const response = await GET(new Request('http://localhost/api/live-sessions/id/terminal'), params('claude:00000000-0000-4000-8000-000000000123'));

    expect(response.status).toBe(200);
    expect(getManagedClaudeSessionMock).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000123');
  });

  it('rejects Codex terminal output and input requests', async () => {
    const getResponse = await GET(new Request('http://localhost/api/live-sessions/id/terminal'), params('codex:00000000-0000-4000-8000-000000000123'));
    const postResponse = await POST(new Request('http://localhost/api/live-sessions/id/terminal', {
      method: 'POST',
      body: JSON.stringify({ text: 'Continue please.' }),
    }), params('codex:00000000-0000-4000-8000-000000000123'));

    expect(getResponse.status).toBe(501);
    await expect(getResponse.json()).resolves.toEqual({ error: 'Codex terminal output is not supported yet.' });
    expect(postResponse.status).toBe(501);
    await expect(postResponse.json()).resolves.toEqual({ error: 'Codex terminal input is not supported yet.' });
    expect(getManagedClaudeSessionMock).not.toHaveBeenCalled();
    expect(sendTextToManagedClaudeSessionMock).not.toHaveBeenCalled();
  });

  it('returns null when the session is not app-managed', async () => {
    getManagedClaudeSessionMock.mockReturnValue(null);

    const response = await GET(new Request('http://localhost/api/live-sessions/id/terminal'), params());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toBeNull();
  });

  it('sends input directly to a running managed PTY session', async () => {
    sendTextToManagedClaudeSessionMock.mockReturnValue({
      sessionId: '00000000-0000-4000-8000-000000000123',
      output: '',
      isRunning: true,
      sequence: 3,
    });

    const response = await POST(new Request('http://localhost/api/live-sessions/id/terminal', {
      method: 'POST',
      body: JSON.stringify({ text: 'Continue please.' }),
    }), params());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      managed: {
        sessionId: '00000000-0000-4000-8000-000000000123',
        transport: 'managed-pty',
      },
    });
    expect(sendTextToManagedClaudeSessionMock).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000123', 'Continue please.');
  });

  it('sends raw terminal data without trimming or adding Enter', async () => {
    writeDataToManagedClaudeSessionMock.mockReturnValue({
      sessionId: '00000000-0000-4000-8000-000000000123',
      output: '',
      isRunning: true,
      sequence: 3,
    });

    const response = await POST(new Request('http://localhost/api/live-sessions/id/terminal', {
      method: 'POST',
      body: JSON.stringify({ data: '\u001b[A' }),
    }), params());

    expect(response.status).toBe(200);
    expect(writeDataToManagedClaudeSessionMock).toHaveBeenCalledWith(
      '00000000-0000-4000-8000-000000000123',
      '\u001b[A',
    );
    expect(sendTextToManagedClaudeSessionMock).not.toHaveBeenCalled();
  });

  it('resizes a running managed PTY session', async () => {
    resizeManagedClaudeSessionMock.mockReturnValue({
      sessionId: '00000000-0000-4000-8000-000000000123',
      output: '',
      isRunning: true,
      sequence: 3,
      cols: 132,
      rows: 43,
    });

    const response = await POST(new Request('http://localhost/api/live-sessions/id/terminal', {
      method: 'POST',
      body: JSON.stringify({ cols: 132, rows: 43 }),
    }), params());

    expect(response.status).toBe(200);
    expect(resizeManagedClaudeSessionMock).toHaveBeenCalledWith(
      '00000000-0000-4000-8000-000000000123',
      132,
      43,
    );
  });

  it('rejects terminal input when no managed PTY is running', async () => {
    sendTextToManagedClaudeSessionMock.mockReturnValue(null);

    const response = await POST(new Request('http://localhost/api/live-sessions/id/terminal', {
      method: 'POST',
      body: JSON.stringify({ text: 'Continue please.' }),
    }), params());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: 'No running managed PTY session was found.' });
  });
});
