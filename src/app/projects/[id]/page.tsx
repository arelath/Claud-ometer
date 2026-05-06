import { ProjectDetailClient } from '@/components/pages/project-detail-client';
import { getProjectSessions } from '@/lib/claude-data/reader';

export default async function ProjectDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const projectId = decodeURIComponent(id);
  const sessions = await getProjectSessions(projectId);

  return <ProjectDetailClient projectId={projectId} initialSessions={sessions} />;
}
