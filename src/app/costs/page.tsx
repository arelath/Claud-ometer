import { CostsClient } from '@/components/pages/costs-client';
import { getCachedCostAnalytics } from '@/lib/agent-data/analytics';
import { getActiveProviders } from '@/lib/agent-data/registry';

export const dynamic = 'force-dynamic';

export default function CostsPage() {
  const initialAnalytics = getCachedCostAnalytics(getActiveProviders());
  return <CostsClient initialStats={initialAnalytics.stats} initialProjects={initialAnalytics.projects} />;
}
