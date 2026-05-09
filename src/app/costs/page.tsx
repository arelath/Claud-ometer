import { CostsClient } from '@/components/pages/costs-client';
import { getActiveProviders } from '@/lib/agent-data/registry';
import { mergeDashboardStats, sortProjectsByLastActive } from '@/lib/agent-data/aggregate';

export default async function CostsPage() {
  const providers = getActiveProviders();
  const [stats, projects] = await Promise.all([
    Promise.all(providers.map(provider => provider.getDashboardStats())).then(mergeDashboardStats),
    Promise.all(providers.map(provider => provider.getProjects())).then(results => sortProjectsByLastActive(results.flat())),
  ]);

  return <CostsClient initialStats={stats} initialProjects={projects} />;
}
