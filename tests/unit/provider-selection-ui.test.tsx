import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DataPage from '@/app/data/page';

const state = vi.hoisted(() => ({
  data: new Map<string, unknown>(),
  mutate: vi.fn(),
  globalMutate: vi.fn(),
}));

vi.mock('swr', () => ({
  default: (key: string) => ({
    data: state.data.get(key),
    mutate: state.mutate,
  }),
  mutate: state.globalMutate,
}));

function dataSource() {
  return {
    active: 'imported',
    agents: ['claude'],
    detectedAgents: ['claude', 'codex'],
    hasImportedData: true,
    importMeta: {
      importedAt: '2026-05-08T12:00:00.000Z',
      exportedAt: '2026-05-08T10:00:00.000Z',
      exportedFrom: 'mixed fixture',
      projectCount: 5,
      sessionCount: 6,
      fileCount: 12,
      totalSize: 4096,
      agents: ['claude', 'codex'],
      agentCounts: {
        claude: { projectCount: 4, sessionCount: 5 },
        codex: { projectCount: 1, sessionCount: 1 },
      },
    },
  };
}

describe('provider selection UI', () => {
  beforeEach(() => {
    state.data.clear();
    state.mutate.mockReset();
    state.globalMutate.mockReset();
    state.data.set('/api/data-source', dataSource());
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  });

  it('shows detected providers and switches selected agents', async () => {
    render(<DataPage />);

    expect(screen.getByText('Agent Sources')).toBeInTheDocument();
    expect(screen.getAllByLabelText('Claude agent').length).toBeGreaterThan(0);
    expect(screen.getAllByLabelText('Codex agent').length).toBeGreaterThan(0);
    expect(screen.getByText('Claude data detected')).toBeInTheDocument();
    expect(screen.getByText('Codex data detected')).toBeInTheDocument();
    expect(screen.getByText('Use all detected agents')).toBeInTheDocument();
    expect(screen.getByText('mixed fixture')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Codex data detected'));
    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith('/api/data-source', expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ source: 'imported', agents: ['codex'] }),
      }));
    });

    fireEvent.click(screen.getByText('Use all detected agents'));
    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith('/api/data-source', expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ source: 'imported', agents: ['claude', 'codex'] }),
      }));
    });
  });
});
