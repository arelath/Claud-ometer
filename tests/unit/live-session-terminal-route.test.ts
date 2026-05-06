import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from '@/app/api/live-sessions/[id]/terminal/route';

const { getManagedClaudeSessionMock } = vi.hoisted(() => ({
  getManagedClaudeSessionMock: vi.fn(),
}));

vi.mock('@/lib/claude-data/managed-pty', () => ({
  getManagedClaudeSession: getManagedClaudeSessionMock,
}));

function params(id = '00000000-0000-4000-8000-000000000123') {
  return { params: Promise.resolve({ id }) };
}

describe('live session terminal route', () => {
  beforeEach(() => {
    getManagedClaudeSessionMock.mockReset();
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

  it('returns null when the session is not app-managed', async () => {
    getManagedClaudeSessionMock.mockReturnValue(null);

    const response = await GET(new Request('http://localhost/api/live-sessions/id/terminal'), params());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toBeNull();
  });
});
