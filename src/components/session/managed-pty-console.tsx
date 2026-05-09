'use client';

import { useEffect, useRef } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal as XTerm } from '@xterm/xterm';
import useSWR from 'swr';
import { useToast } from '@/components/ui/toast';

type ManagedTerminalSnapshot = {
  sessionId: string;
  cwd?: string;
  output?: string;
  sequence: number;
  isRunning: boolean;
  exitCode?: number;
  transport?: 'managed-pty';
};

const fetcher = async (url: string) => {
  const response = await fetch(url);
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(data?.error || `API error: ${response.status}`);
  }
  return response.json();
};

async function postTerminalPayload(url: string, body: Record<string, unknown>): Promise<void> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(data?.error || `API error: ${response.status}`);
  }
}

function getOverlayText(data: ManagedTerminalSnapshot | null | undefined): string {
  if (!data) return 'Connecting to managed PTY...';
  if (data.transport !== 'managed-pty') return 'Console is available for managed PTY sessions.';
  if (!data.isRunning) return `Terminal exited${data.exitCode == null ? '.' : ` with code ${data.exitCode}.`}`;
  if (!data.output) return 'Starting Claude...';
  return '';
}

export function ManagedPtyConsole({ sessionId }: { sessionId: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<XTerm | null>(null);
  const fitAndResizeRef = useRef<() => void>(() => undefined);
  const isWritableRef = useRef(false);
  const lastResizeRef = useRef('');
  const outputCursorRef = useRef('');
  const lastErrorRef = useRef('');
  const toast = useToast();
  const terminalUrl = `/api/live-sessions/${encodeURIComponent(sessionId)}/terminal`;
  const { data, error } = useSWR<ManagedTerminalSnapshot | null, Error>(
    terminalUrl,
    fetcher,
    { refreshInterval: 250 },
  );

  useEffect(() => {
    if (!error?.message || lastErrorRef.current === error.message) return;
    lastErrorRef.current = error.message;
    toast.error('Console unavailable', error.message);
  }, [error, toast]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    const terminal = new XTerm({
      allowProposedApi: false,
      convertEol: false,
      cursorBlink: true,
      disableStdin: true,
      fontFamily: 'var(--font-geist-mono), Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      letterSpacing: 0,
      lineHeight: 1.12,
      scrollback: 10_000,
      tabStopWidth: 8,
      theme: {
        background: '#000000',
        foreground: '#d8d8d8',
        cursor: '#f5f5f5',
        selectionBackground: '#3a3d41',
      },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(element);
    terminal.focus();
    terminalRef.current = terminal;

    const sendPayload = async (body: Record<string, unknown>) => {
      try {
        await postTerminalPayload(terminalUrl, body);
      } catch (sendError) {
        const message = sendError instanceof Error ? sendError.message : 'Could not send terminal input';
        if (lastErrorRef.current !== message) {
          lastErrorRef.current = message;
          toast.error('Console input failed', message);
        }
      }
    };

    const inputSubscription = terminal.onData((rawInput) => {
      if (!rawInput || !isWritableRef.current) return;
      void sendPayload({ data: rawInput });
    });

    const fitAndResize = () => {
      try {
        fitAddon.fit();
      } catch {
        return;
      }

      if (!isWritableRef.current) return;
      const signature = `${terminal.cols}x${terminal.rows}`;
      if (signature === lastResizeRef.current) return;
      lastResizeRef.current = signature;
      void sendPayload({ cols: terminal.cols, rows: terminal.rows });
    };
    fitAndResizeRef.current = fitAndResize;

    const animationFrame = window.requestAnimationFrame(fitAndResize);
    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(fitAndResize);
    resizeObserver?.observe(element);
    window.addEventListener('resize', fitAndResize);

    return () => {
      window.cancelAnimationFrame(animationFrame);
      window.removeEventListener('resize', fitAndResize);
      resizeObserver?.disconnect();
      inputSubscription.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitAndResizeRef.current = () => undefined;
      outputCursorRef.current = '';
      lastResizeRef.current = '';
      isWritableRef.current = false;
    };
  }, [terminalUrl, toast]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal || !data) return;

    const isManagedPty = data.transport === 'managed-pty';
    isWritableRef.current = Boolean(isManagedPty && data.isRunning);
    terminal.options.disableStdin = !isWritableRef.current;

    if (!isManagedPty) {
      terminal.reset();
      outputCursorRef.current = '';
      return;
    }

    const output = data.output || '';
    const previousOutput = outputCursorRef.current;
    if (output.startsWith(previousOutput)) {
      const nextChunk = output.slice(previousOutput.length);
      if (nextChunk) terminal.write(nextChunk);
    } else {
      terminal.reset();
      if (output) terminal.write(output);
    }
    outputCursorRef.current = output;
    terminal.focus();
    fitAndResizeRef.current();
  }, [data]);

  const overlayText = getOverlayText(data);

  return (
    <section data-testid="managed-pty-console" className="relative h-screen w-screen overflow-hidden bg-black">
      <div
        ref={containerRef}
        className="h-full w-full [&_.xterm]:h-full [&_.xterm-screen]:outline-none"
      />
      {overlayText && (
        <div
          role="status"
          className="pointer-events-none absolute left-3 top-3 rounded bg-black/80 px-2 py-1 font-mono text-xs text-neutral-300"
        >
          {overlayText}
        </div>
      )}
    </section>
  );
}
