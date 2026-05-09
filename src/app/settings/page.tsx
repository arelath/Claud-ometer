'use client';

import { useCallback, useState } from 'react';
import useSWR from 'swr';
import { CheckCircle2, AlertCircle, Terminal, Database, RefreshCw, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

const fetcher = (url: string) => fetch(url).then(r => r.json());

type ResumeTransport = 'msys2-launch' | 'pty';

interface LiveModeSettingsInfo {
  resumeTransport: ResumeTransport;
  resumeTransportSource: 'stored' | 'env' | 'default';
  msys2Launch: {
    available: boolean;
    root?: string;
    error?: string;
  };
}

interface CacheStatusInfo {
  cachePath: string;
  exists: boolean;
  generatedAt: string;
  summaryCount: number;
  activeProviders: string[];
  sourceCount: number;
  validCount: number;
  staleCount: number;
  missingCount: number;
  rebuilt?: number;
}

function transportLabel(transport?: ResumeTransport): string {
  return transport === 'msys2-launch' ? 'MSYS2 launch' : 'PTY';
}

export default function SettingsPage() {
  const { data, mutate } = useSWR<LiveModeSettingsInfo>('/api/settings/live-mode', fetcher);
  const { data: cacheStatus, mutate: mutateCache } = useSWR<CacheStatusInfo>('/api/cache', fetcher);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [cacheBusy, setCacheBusy] = useState<'rebuild' | 'clear' | null>(null);
  const envLocked = data?.resumeTransportSource === 'env';

  const handleResumeTransport = useCallback(async (resumeTransport: ResumeTransport) => {
    setMessage(null);
    try {
      const res = await fetch('/api/settings/live-mode', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resumeTransport }),
      });
      const responseData = await res.json();
      if (!res.ok) throw new Error(responseData.error || 'Failed to update live mode settings');
      await mutate(responseData, { revalidate: false });
      setMessage({ type: 'success', text: `Resume transport set to ${transportLabel(resumeTransport)}.` });
    } catch (err) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Failed to update live mode settings.' });
    }
  }, [mutate]);

  const handleCacheAction = useCallback(async (action: 'rebuild' | 'clear') => {
    setMessage(null);
    setCacheBusy(action);
    try {
      const res = await fetch('/api/cache', { method: action === 'rebuild' ? 'POST' : 'DELETE' });
      const responseData = await res.json();
      if (!res.ok) throw new Error(responseData.error || `Failed to ${action} cache`);
      await mutateCache(responseData, { revalidate: false });
      setMessage({
        type: 'success',
        text: action === 'rebuild'
          ? `Data cache rebuilt with ${responseData.rebuilt ?? responseData.summaryCount ?? 0} summaries.`
          : 'Data cache cleared.',
      });
    } catch (err) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : `Failed to ${action} cache.` });
    } finally {
      setCacheBusy(null);
    }
  }, [mutateCache]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">Live session controls</p>
      </div>

      {message && (
        <div className={`flex items-center gap-2 rounded-lg px-4 py-3 text-sm ${
          message.type === 'success'
            ? 'border border-green-200 bg-green-50 text-green-700'
            : 'border border-red-200 bg-red-50 text-red-700'
        }`}>
          {message.type === 'success'
            ? <CheckCircle2 className="h-4 w-4 flex-shrink-0" />
            : <AlertCircle className="h-4 w-4 flex-shrink-0" />}
          {message.text}
        </div>
      )}

      <Card className="border-border/50 shadow-sm">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2 text-sm font-semibold">
              <Terminal className="h-4 w-4" />
              Live Session Resume
            </CardTitle>
            <Badge variant={data?.resumeTransport === 'msys2-launch' ? 'default' : 'secondary'}>
              {transportLabel(data?.resumeTransport)}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-3 pt-0">
          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => handleResumeTransport('msys2-launch')}
              disabled={envLocked}
              className={`flex items-center gap-3 rounded-lg border-2 p-4 transition-all ${
                data?.resumeTransport === 'msys2-launch'
                  ? 'border-primary bg-primary/5'
                  : 'border-border hover:border-primary/50'
              } ${envLocked ? 'cursor-not-allowed opacity-60' : ''}`}
            >
              <Terminal className={`h-5 w-5 ${data?.resumeTransport === 'msys2-launch' ? 'text-primary' : 'text-muted-foreground'}`} />
              <span className="min-w-0 flex-1 text-left">
                <span className="block text-sm font-medium">MSYS2 launch</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {data?.msys2Launch.available ? data.msys2Launch.root : 'Not found'}
                </span>
              </span>
              {data?.resumeTransport === 'msys2-launch' && (
                <CheckCircle2 className="h-4 w-4 text-primary" />
              )}
            </button>

            <button
              type="button"
              onClick={() => handleResumeTransport('pty')}
              disabled={envLocked}
              className={`flex items-center gap-3 rounded-lg border-2 p-4 transition-all ${
                data?.resumeTransport === 'pty'
                  ? 'border-primary bg-primary/5'
                  : 'border-border hover:border-primary/50'
              } ${envLocked ? 'cursor-not-allowed opacity-60' : ''}`}
            >
              <Terminal className={`h-5 w-5 ${data?.resumeTransport === 'pty' ? 'text-primary' : 'text-muted-foreground'}`} />
              <span className="flex-1 text-left">
                <span className="block text-sm font-medium">PTY</span>
                <span className="block text-xs text-muted-foreground">Managed terminal and console</span>
              </span>
              {data?.resumeTransport === 'pty' && (
                <CheckCircle2 className="h-4 w-4 text-primary" />
              )}
            </button>
          </div>

          {data?.msys2Launch.error && (
            <p className="text-xs text-muted-foreground">{data.msys2Launch.error}</p>
          )}
          {envLocked && (
            <p className="text-xs text-muted-foreground">Set by environment.</p>
          )}
        </CardContent>
      </Card>

      <Card className="border-border/50 shadow-sm">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2 text-sm font-semibold">
              <Database className="h-4 w-4" />
              Data Cache
            </CardTitle>
            <Badge variant={cacheStatus?.exists ? 'default' : 'secondary'}>
              {cacheStatus?.exists ? 'Ready' : 'Empty'}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4 pt-0">
          <div className="grid gap-3 sm:grid-cols-4">
            <div className="rounded-lg border border-border/60 px-3 py-2">
              <p className="text-[11px] text-muted-foreground">Summaries</p>
              <p className="text-sm font-semibold">{cacheStatus?.summaryCount ?? 0}</p>
            </div>
            <div className="rounded-lg border border-border/60 px-3 py-2">
              <p className="text-[11px] text-muted-foreground">Sources</p>
              <p className="text-sm font-semibold">{cacheStatus?.sourceCount ?? 0}</p>
            </div>
            <div className="rounded-lg border border-border/60 px-3 py-2">
              <p className="text-[11px] text-muted-foreground">Valid</p>
              <p className="text-sm font-semibold">{cacheStatus?.validCount ?? 0}</p>
            </div>
            <div className="rounded-lg border border-border/60 px-3 py-2">
              <p className="text-[11px] text-muted-foreground">Stale</p>
              <p className="text-sm font-semibold">{(cacheStatus?.staleCount ?? 0) + (cacheStatus?.missingCount ?? 0)}</p>
            </div>
          </div>

          <div className="space-y-1 text-xs text-muted-foreground">
            <p className="truncate">{cacheStatus?.cachePath || 'Cache path loading...'}</p>
            <p>{cacheStatus?.generatedAt ? `Updated ${new Date(cacheStatus.generatedAt).toLocaleString()}` : 'Not built yet'}</p>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => handleCacheAction('rebuild')}
              disabled={Boolean(cacheBusy)}
              className="inline-flex items-center gap-2 rounded-md border border-border/60 bg-background px-3 py-2 text-xs font-medium transition-colors hover:bg-muted/50 disabled:opacity-60"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${cacheBusy === 'rebuild' ? 'animate-spin' : ''}`} />
              Rebuild
            </button>
            <button
              type="button"
              onClick={() => handleCacheAction('clear')}
              disabled={Boolean(cacheBusy)}
              className="inline-flex items-center gap-2 rounded-md border border-border/60 bg-background px-3 py-2 text-xs font-medium text-red-600 transition-colors hover:bg-red-50 disabled:opacity-60"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Clear
            </button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
