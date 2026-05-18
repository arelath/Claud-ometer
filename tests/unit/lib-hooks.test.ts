import { beforeEach, describe, expect, it, vi } from 'vitest';

const swrMock = vi.hoisted(() => vi.fn());

vi.mock('swr', () => ({
  default: swrMock,
}));

describe('lib hook URL builders', () => {
  beforeEach(() => {
    swrMock.mockReset();
    swrMock.mockReturnValue({ data: undefined });
  });

  it('builds SWR keys for dashboard, projects, sessions, details, data source, and live sessions', async () => {
    const hooks = await import('@/lib/hooks');
    const fallback = { totalSessions: 0 };

    hooks.useStats(fallback as never);
    hooks.useProjects([]);
    hooks.useSessions(25, 10, '', []);
    hooks.useSessions(25, 10, 'hello world', []);
    hooks.useProjectSessions('project-1', []);
    hooks.useSessionDetail('session-1');
    hooks.useDataSourceInfo();
    hooks.useLiveSessions();
    hooks.useLiveSessionBinding('session-1');

    const fallbackPage = { sessions: [], total: 0, limit: 25, offset: 10 };
    expect(swrMock).toHaveBeenNthCalledWith(1, '/api/stats', expect.any(Function), { fallbackData: fallback });
    expect(swrMock).toHaveBeenNthCalledWith(2, '/api/projects', expect.any(Function), { fallbackData: [] });
    expect(swrMock).toHaveBeenNthCalledWith(3, '/api/sessions?limit=25&offset=10&includeTotal=1', expect.any(Function), { fallbackData: fallbackPage });
    expect(swrMock).toHaveBeenNthCalledWith(4, '/api/sessions?q=hello+world&limit=25&offset=10&includeTotal=1', expect.any(Function), { fallbackData: fallbackPage });
    expect(swrMock).toHaveBeenNthCalledWith(5, '/api/sessions?projectId=project-1', expect.any(Function), { fallbackData: [] });
    expect(swrMock).toHaveBeenNthCalledWith(6, '/api/sessions/session-1', expect.any(Function), {
      refreshInterval: expect.any(Function),
      dedupingInterval: 2000,
      keepPreviousData: true,
      compare: expect.any(Function),
    });
    expect(swrMock).toHaveBeenNthCalledWith(7, '/api/data-source', expect.any(Function), { refreshInterval: 5000 });
    expect(swrMock).toHaveBeenNthCalledWith(8, '/api/live-sessions', expect.any(Function), { refreshInterval: 1000 });
    expect(swrMock).toHaveBeenNthCalledWith(9, '/api/live-sessions/by-session/session-1', expect.any(Function), { refreshInterval: 1000 });

    const detailOptions = swrMock.mock.calls[5][2] as { refreshInterval: (data?: { isLive?: boolean }) => number };
    expect(detailOptions.refreshInterval({ isLive: true })).toBe(2500);
    expect(detailOptions.refreshInterval({ isLive: false })).toBe(0);
  });

  it('throws API errors from the shared fetcher', async () => {
    const hooks = await import('@/lib/hooks');
    hooks.useStats();
    const fetcher = swrMock.mock.calls[0][1] as (url: string) => Promise<unknown>;

    global.fetch = vi.fn().mockResolvedValue(new Response('nope', { status: 503 }));
    await expect(fetcher('/api/stats')).rejects.toThrow('API error: 503');

    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await expect(fetcher('/api/stats')).resolves.toEqual({ ok: true });
  });

  it('builds filtered analytics SWR keys', async () => {
    const hooks = await import('@/lib/hooks');
    const range = { start: '2026-04-01', end: '2026-05-01' };

    hooks.useStats({ totalSessions: 99 } as never, range);
    hooks.useProjects([], range);
    hooks.useSessions(25, 0, 'hello world', [], range);

    expect(swrMock).toHaveBeenNthCalledWith(1, '/api/stats?start=2026-04-01&end=2026-05-01', expect.any(Function), { fallbackData: undefined });
    expect(swrMock).toHaveBeenNthCalledWith(2, '/api/projects?start=2026-04-01&end=2026-05-01', expect.any(Function), { fallbackData: undefined });
    expect(swrMock).toHaveBeenNthCalledWith(3, '/api/sessions?q=hello+world&limit=25&offset=0&includeTotal=1&start=2026-04-01&end=2026-05-01', expect.any(Function), { fallbackData: undefined });
  });
});
