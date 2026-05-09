import { DashboardClient } from '@/components/pages/dashboard-client';
import { getActiveProviders } from '@/lib/agent-data/registry';
import { mergeDashboardStats } from '@/lib/agent-data/aggregate';

export default async function DashboardPage() {
  const stats = mergeDashboardStats(await Promise.all(getActiveProviders().map(provider => provider.getDashboardStats())));
  return <DashboardClient initialStats={stats} />;
}
