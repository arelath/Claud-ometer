import { DashboardClient } from '@/components/pages/dashboard-client';
import { getDashboardStats } from '@/lib/claude-data/reader';

export default async function DashboardPage() {
  const stats = await getDashboardStats();
  return <DashboardClient initialStats={stats} />;
}
