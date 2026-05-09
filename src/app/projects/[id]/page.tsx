import { ProjectDetailClient } from '@/components/pages/project-detail-client';
import { getActiveProviders, resolveSessionProvider } from '@/lib/agent-data/registry';
import { parseRouteId } from '@/lib/agent-data/route-id';
import { sortSessionsByTimestamp } from '@/lib/agent-data/aggregate';

export default async function ProjectDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const projectId = decodeURIComponent(id);
  const parsed = parseRouteId(projectId);
  const providers = parsed.agentKind
    ? [resolveSessionProvider(projectId)].filter(Boolean)
    : getActiveProviders();
  const sessions = sortSessionsByTimestamp((await Promise.all(providers.map(provider => provider!.getProjectSessions(projectId)))).flat());

  return <ProjectDetailClient projectId={projectId} initialSessions={sessions} />;
}
