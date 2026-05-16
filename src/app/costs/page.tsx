import { Suspense } from 'react';
import { CostsClient } from '@/components/pages/costs-client';
import { getCachedCostAnalytics } from '@/lib/agent-data/analytics';
import { getActiveProviders } from '@/lib/agent-data/registry';

export const dynamic = 'force-dynamic';

export default function CostsPage() {
  const initialAnalytics = getCachedCostAnalytics(getActiveProviders());
  return (
    <Suspense fallback={<PageLoading label="Loading cost data..." />}>
      <CostsClient initialStats={initialAnalytics.stats} initialProjects={initialAnalytics.projects} />
    </Suspense>
  );
}

function PageLoading({ label }: { label: string }) {
  return (
    <div className="flex h-[80vh] items-center justify-center">
      <div className="space-y-3 text-center">
        <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        <p className="text-sm text-muted-foreground">{label}</p>
      </div>
    </div>
  );
}
