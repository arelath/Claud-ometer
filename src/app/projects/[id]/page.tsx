import { ProjectDetailClient } from '@/components/pages/project-detail-client';

export default async function ProjectDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const projectId = decodeURIComponent(id);
  return <ProjectDetailClient projectId={projectId} />;
}
