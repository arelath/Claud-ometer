'use client';

import { AlertCircle, RefreshCw } from 'lucide-react';
import type { CacheStatus } from '@/lib/hooks';
import { cn } from '@/lib/utils';

function statusText(status: CacheStatus): string {
  if (status.status === 'refreshing') return 'Updating data';
  if (status.status === 'empty') return 'Building data index';
  if (status.status === 'stale') return 'Refreshing stale data';
  if (status.status === 'error') return status.refreshError ? `Index update failed: ${status.refreshError}` : 'Index update failed';
  return '';
}

export function CacheRefreshStatus({
  status,
  className,
}: {
  status?: CacheStatus;
  className?: string;
}) {
  if (!status || status.status === 'fresh') return null;

  const isError = status.status === 'error';
  const text = statusText(status);
  const detailParts = [
    status.staleCount > 0 ? `${status.staleCount} stale` : '',
    status.unindexedCount > 0 ? `${status.unindexedCount} new` : '',
    status.missingCount > 0 ? `${status.missingCount} removed` : '',
  ].filter(Boolean);

  return (
    <div
      className={cn(
        'inline-flex items-center gap-2 rounded-md border px-2.5 py-1 text-xs',
        isError
          ? 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300'
          : 'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300',
        className,
      )}
    >
      {isError ? <AlertCircle className="h-3.5 w-3.5" /> : <RefreshCw className="h-3.5 w-3.5 animate-spin" />}
      <span className="font-medium">{text}</span>
      {detailParts.length > 0 && (
        <span className="text-muted-foreground">{detailParts.join(', ')}</span>
      )}
    </div>
  );
}
