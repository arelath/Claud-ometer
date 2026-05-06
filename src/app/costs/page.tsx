import { CostsClient } from '@/components/pages/costs-client';
import { getDashboardStats, getProjects } from '@/lib/claude-data/reader';

export default async function CostsPage() {
  const [stats, projects] = await Promise.all([
    getDashboardStats(),
    getProjects(),
  ]);

  return <CostsClient initialStats={stats} initialProjects={projects} />;
}
