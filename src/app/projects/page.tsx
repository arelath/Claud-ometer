import { ProjectsClient } from '@/components/pages/projects-client';
import { getActiveProviders } from '@/lib/agent-data/registry';
import { sortProjectsByLastActive } from '@/lib/agent-data/aggregate';

export default async function ProjectsPage() {
  const projects = sortProjectsByLastActive((await Promise.all(getActiveProviders().map(provider => provider.getProjects()))).flat());
  return <ProjectsClient initialProjects={projects} />;
}
