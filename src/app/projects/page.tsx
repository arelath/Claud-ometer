import { ProjectsClient } from '@/components/pages/projects-client';
import { getProjects } from '@/lib/claude-data/reader';

export default async function ProjectsPage() {
  const projects = await getProjects();
  return <ProjectsClient initialProjects={projects} />;
}
