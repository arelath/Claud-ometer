'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTheme } from 'next-themes';
import useSWR from 'swr';
import { formatDistanceToNowStrict } from 'date-fns';
import {
  LayoutDashboard,
  FolderKanban,
  MessageSquare,
  DollarSign,
  Terminal,
  Database,
  Sun,
  Moon,
  Circle,
  LoaderCircle,
  Settings,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useLiveSessions } from '@/lib/hooks';
import type { DataSourceInfo } from '@/lib/hooks';
import { getAgentLabel } from '@/lib/agent-data/types';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { LiveWorkingIndicator } from '@/components/session/live-working-indicator';
import type { LiveSessionInfo } from '@/lib/claude-data/types';

const navItems = [
  { href: '/', label: 'Overview', icon: LayoutDashboard },
  { href: '/projects', label: 'Projects', icon: FolderKanban },
  { href: '/sessions', label: 'Sessions', icon: MessageSquare },
  { href: '/costs', label: 'Costs', icon: DollarSign },
  { href: '/data', label: 'Data', icon: Database },
  { href: '/settings', label: 'Settings', icon: Settings },
];

const fetcher = (url: string) => fetch(url).then(r => r.json());

function formatLiveRelativeTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'recently';
  try {
    return formatDistanceToNowStrict(date, { addSuffix: true });
  } catch {
    return 'recently';
  }
}

function formatCacheCountdown(session: LiveSessionInfo, nowMs: number): string {
  if (session.cachePaused) return 'Cache 5m paused';
  if (!session.cacheExpiresAtMs) return '';

  const remainingMs = session.cacheExpiresAtMs - nowMs;
  if (remainingMs <= 0) return 'Cache expired';

  const totalSeconds = Math.ceil(remainingMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `Cache ${seconds}s`;
  return `Cache ${minutes}m ${seconds.toString().padStart(2, '0')}s`;
}

function formatCacheExpiryTooltip(session: LiveSessionInfo, nowMs: number): string {
  if (session.cachePaused) {
    return 'Cache countdown is paused at 5 minutes while Claude is working. It will restart from the next user or Claude message.';
  }
  if (!session.cacheExpiresAtMs || !session.cacheLastActivityAtMs) {
    return 'No prompt cache has been created for this session yet.';
  }

  const expiresAt = new Date(session.cacheExpiresAtMs);
  const lastActivityAt = new Date(session.cacheLastActivityAtMs);
  const time = Number.isNaN(expiresAt.getTime())
    ? 'the cache expiry time'
    : new Intl.DateTimeFormat(undefined, {
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
    }).format(expiresAt);
  const lastActivityTime = Number.isNaN(lastActivityAt.getTime())
    ? 'the last Claude message'
    : new Intl.DateTimeFormat(undefined, {
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
    }).format(lastActivityAt);

  if (session.cacheExpiresAtMs <= nowMs) {
    return `Cache expired at ${time}, based on the last user or Claude message at ${lastActivityTime}. Sending now may resend the whole prompt at a much higher price.`;
  }

  return `Cache expires at ${time}, based on the last user or Claude message at ${lastActivityTime}. After that, sending may resend the whole prompt at a much higher price.`;
}

function LiveStatusIcon({ session }: { session: LiveSessionInfo }) {
  if (session.status === 'busy') {
    return <LoaderCircle className="mt-0.5 h-3 w-3 shrink-0 animate-spin text-blue-500" aria-label="Busy" />;
  }

  const className = session.status === 'idle'
      ? 'text-green-600 dark:text-green-400'
      : 'text-amber-600 dark:text-amber-400';

  return <Circle className={`mt-0.5 h-3 w-3 shrink-0 fill-current ${className}`} aria-label={session.status} />;
}

function LiveSessionsNav({ pathname }: { pathname: string }) {
  const { data: liveSessions } = useLiveSessions();
  const sessions = liveSessions || [];
  const [nowMs, setNowMs] = useState(0);

  useEffect(() => {
    const updateNow = () => setNowMs(Date.now());
    updateNow();
    const interval = window.setInterval(updateNow, 1000);
    return () => window.clearInterval(interval);
  }, []);

  return (
    <div className="mt-4 border-t border-border/60 pt-3">
      <div className="mb-1.5 flex items-center justify-between px-3">
        <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Live Sessions</span>
        {sessions.length > 0 && (
          <span className="font-mono text-[10px] text-muted-foreground">{sessions.length}</span>
        )}
      </div>
      {sessions.length === 0 ? (
        <p className="px-3 py-2 text-[11px] text-muted-foreground">No live sessions</p>
      ) : (
        <div className="max-h-[34vh] space-y-1 overflow-y-auto pr-1">
          {sessions.map(session => {
            const href = `/sessions/${session.sessionId}`;
            const isActive = pathname === href;
            const preview = session.lastPreview || session.statusReason;
            const effectiveNowMs = nowMs || session.updatedAtMs;
            const hasCacheExpiry = session.cacheExpiresAtMs != null && session.cacheLastActivityAtMs != null;
            return (
              <Link
                key={`${session.metadataFilePath}-${session.sessionId}`}
                href={href}
                title={`${session.projectName} - ${session.statusReason}`}
                className={cn(
                  'group flex gap-2 rounded-lg px-3 py-2 text-left transition-colors',
                  isActive
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                )}
              >
                <LiveStatusIcon session={session} />
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate text-xs font-medium">{session.projectName}</span>
                    <span className="shrink-0 rounded-full border border-border/50 px-1 py-0 text-[8px] uppercase leading-3 text-muted-foreground">
                      {session.status}
                    </span>
                    {session.status === 'busy' && (
                      <LiveWorkingIndicator
                        activeToolName={session.activeToolName}
                        busySinceAtMs={session.busySinceAtMs}
                        compact
                      />
                    )}
                  </span>
                  <span className="mt-0.5 block truncate text-[10px] leading-3 text-muted-foreground">
                    {preview}
                  </span>
                  <span className="mt-0.5 flex min-w-0 items-center gap-1.5 font-mono text-[9px] leading-3 text-muted-foreground/80">
                    <span className="truncate">{formatLiveRelativeTime(session.lastActivityAt)}</span>
                    {hasCacheExpiry && (
                      <>
                        <span className="shrink-0 opacity-50">·</span>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className={cn(
                              'shrink-0 rounded-full border px-1 py-0 leading-3',
                              session.cachePaused
                                ? 'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300'
                                : session.cacheExpiresAtMs! <= effectiveNowMs
                                ? 'border-yellow-500/40 bg-yellow-500/10 text-yellow-700 dark:text-yellow-300'
                                : 'border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-300',
                            )}>
                              {formatCacheCountdown(session, effectiveNowMs)}
                            </span>
                          </TooltipTrigger>
                          <TooltipContent side="right" className="max-w-[240px]">
                            {formatCacheExpiryTooltip(session, effectiveNowMs)}
                          </TooltipContent>
                        </Tooltip>
                      </>
                    )}
                  </span>
                </span>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function Sidebar() {
  const pathname = usePathname();
  const { data: sourceInfo } = useSWR<DataSourceInfo>('/api/data-source', fetcher, { refreshInterval: 5000 });
  const { resolvedTheme, setTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';

  const isImported = sourceInfo?.active === 'imported';
  const activeAgentLabel = sourceInfo
    ? sourceInfo.agents.length > 0
      ? `Reading ${sourceInfo.agents.map(getAgentLabel).join(' + ')} data`
      : 'No agent data selected'
    : 'Loading agent data';

  return (
    <aside className="fixed left-0 top-0 z-40 flex h-screen w-60 flex-col border-r border-border bg-card">
      <div className="flex h-14 items-center gap-2.5 border-b border-border px-5">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary">
          <Terminal className="h-4 w-4 text-primary-foreground" />
        </div>
        <div>
          <h1 className="text-sm font-semibold tracking-tight">AgentScope</h1>
          <p className="text-[10px] text-muted-foreground">Agent Analytics</p>
        </div>
      </div>

      <nav className="flex-1 space-y-1 px-3 py-4">
        {navItems.map((item) => {
          const isActive = pathname === item.href ||
            (item.href !== '/' && pathname.startsWith(item.href));
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                isActive
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground'
              )}
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </Link>
          );
        })}
        <LiveSessionsNav pathname={pathname} />
      </nav>

      <div className="border-t border-border px-5 py-3 space-y-2">
        <button
          onClick={() => setTheme(isDark ? 'light' : 'dark')}
          className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
        >
          {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          {isDark ? 'Light Mode' : 'Dark Mode'}
        </button>
        {isImported ? (
          <div className="flex items-center gap-1.5">
            <Badge variant="secondary" className="text-[9px] px-1.5 py-0 bg-amber-100 text-amber-700 border-amber-200">
              Imported
            </Badge>
            <p className="text-[10px] text-muted-foreground truncate">
              {sourceInfo?.importMeta?.exportedFrom || 'snapshot'}
            </p>
          </div>
        ) : (
          <p className="text-[10px] text-muted-foreground">
            {activeAgentLabel}
          </p>
        )}
      </div>
    </aside>
  );
}
