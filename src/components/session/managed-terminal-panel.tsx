'use client';

import { useEffect, useRef } from 'react';
import useSWR from 'swr';
import type { ManagedClaudeSessionSnapshot } from '@/lib/claude-data/managed-pty';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

const fetcher = (url: string) => fetch(url).then(response => {
  if (!response.ok) throw new Error(`API error: ${response.status}`);
  return response.json();
});

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

export function ManagedTerminalPanel({ sessionId }: { sessionId: string }) {
  const outputRef = useRef<HTMLPreElement | null>(null);
  const { data } = useSWR<ManagedClaudeSessionSnapshot | null>(
    `/api/live-sessions/${encodeURIComponent(sessionId)}/terminal`,
    fetcher,
    { refreshInterval: 1000 },
  );

  useEffect(() => {
    const element = outputRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
  }, [data?.sequence]);

  if (!data) return null;

  const output = stripAnsi(data.output).trimEnd();
  const fallback = data.isRunning ? 'Starting Claude...' : 'Terminal exited.';

  return (
    <Card className="border-border/50 shadow-sm">
      <CardHeader className="px-3 py-2">
        <CardTitle className="flex items-center justify-between text-xs font-semibold">
          <span>Managed Terminal</span>
          <span className="font-mono text-[10px] font-normal text-muted-foreground">
            {data.isRunning ? 'running' : `exited ${data.exitCode ?? ''}`}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="px-3 pb-3 pt-0">
        <pre ref={outputRef} className="max-h-48 overflow-auto rounded-md bg-black/90 p-2 font-mono text-[11px] leading-4 text-green-100">
          {output || fallback}
        </pre>
      </CardContent>
    </Card>
  );
}
