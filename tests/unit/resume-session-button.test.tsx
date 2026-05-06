import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResumeSessionButton } from '@/components/session/resume-session-button';
import { TooltipProvider } from '@/components/ui/tooltip';

describe('ResumeSessionButton', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts to the resume endpoint and shows launched state', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <TooltipProvider>
        <ResumeSessionButton sessionId="00000000-0000-4000-8000-000000000123" showLabel />
      </TooltipProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Resume session in Claude' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/sessions/00000000-0000-4000-8000-000000000123/resume', { method: 'POST' });
    });
    expect(await screen.findByText('Launched')).toBeInTheDocument();
  });

  it('does not send duplicate launches while a launch is already pending', async () => {
    let resolveResponse: (response: Response) => void = () => undefined;
    const fetchMock = vi.fn().mockReturnValue(new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    }));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <TooltipProvider>
        <ResumeSessionButton sessionId="00000000-0000-4000-8000-000000000123" showLabel />
      </TooltipProvider>,
    );

    const button = screen.getByRole('button', { name: 'Resume session in Claude' });
    fireEvent.click(button);
    fireEvent.click(button);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolveResponse(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    expect(await screen.findByText('Launched')).toBeInTheDocument();
  });
});
