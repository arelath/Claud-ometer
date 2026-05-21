import os from 'os';
import { AGENT_ARCHIVE_ROOT, toZipPath } from './archive';
import type { AgentDataProvider } from './provider';
import { getProvider } from './registry';
import type { AgentKind } from './types';
import type { ProjectInfo, SessionDetail, SessionInfo } from '@/lib/claude-data/types';

export const STANDARDIZED_ARCHIVE_ROOT = toZipPath(AGENT_ARCHIVE_ROOT, 'standardized');
export const STANDARDIZED_EXPORT_SCHEMA = 'agentscope.standardized.v1';
export const STANDARDIZED_EXPORT_VERSION = 1;

interface ArchiveWriter {
  append(source: string | Buffer, data: { name: string }): void;
}

export interface StandardizedExportError {
  agentKind: AgentKind;
  sessionId?: string;
  message: string;
}

export interface StandardizedExportMeta {
  standardizedExportVersion: number;
  schema: string;
  exportedAt: string;
  exportedFrom: string;
  platform: string;
  agents: AgentKind[];
  projectCount: number;
  sessionCount: number;
  sessionDetailCount: number;
  agentCounts: Partial<Record<AgentKind, {
    projectCount: number;
    sessionCount: number;
    sessionDetailCount: number;
  }>>;
  files: {
    projects: string;
    sessions: string;
    sessionDetailsIndex: string;
    sessionDetailsRoot: string;
  };
  errors: StandardizedExportError[];
}

interface SessionDetailIndexEntry {
  id: string;
  agentKind: AgentKind;
  projectId: string;
  nativeId?: string;
  routeId?: string;
  path: string;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function appendJson(archive: ArchiveWriter, name: string, value: unknown): void {
  archive.append(JSON.stringify(value, null, 2), { name });
}

function safeArchiveFileName(value: string): string {
  return encodeURIComponent(value || 'session').replace(/[!'()*]/g, character => (
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  ));
}

function withProjectAgentKind(project: ProjectInfo, agentKind: AgentKind): ProjectInfo {
  return { ...project, agentKind: project.agentKind || agentKind };
}

function withSessionAgentKind(session: SessionInfo, agentKind: AgentKind): SessionInfo {
  return { ...session, agentKind: session.agentKind || agentKind };
}

function withSessionDetailAgentKind(session: SessionDetail, agentKind: AgentKind): SessionDetail {
  return { ...session, agentKind: session.agentKind || agentKind };
}

async function readProviderData(provider: AgentDataProvider): Promise<{
  projects: ProjectInfo[];
  sessions: SessionInfo[];
}> {
  const [projects, sessions] = await Promise.all([
    provider.getProjects(),
    provider.getSessions(Number.MAX_SAFE_INTEGER, 0),
  ]);

  return {
    projects: projects.map(project => withProjectAgentKind(project, provider.kind)),
    sessions: sessions.map(session => withSessionAgentKind(session, provider.kind)),
  };
}

export async function addStandardizedDataToArchive(
  archive: ArchiveWriter,
  agents: AgentKind[],
  exportedAt = new Date().toISOString(),
): Promise<StandardizedExportMeta> {
  const projects: ProjectInfo[] = [];
  const sessions: SessionInfo[] = [];
  const sessionDetailIndex: SessionDetailIndexEntry[] = [];
  const errors: StandardizedExportError[] = [];
  const agentCounts: StandardizedExportMeta['agentCounts'] = {};

  for (const agentKind of agents) {
    const provider = getProvider(agentKind);
    if (!provider) {
      errors.push({ agentKind, message: 'Provider is not registered.' });
      continue;
    }

    let providerProjects: ProjectInfo[] = [];
    let providerSessions: SessionInfo[] = [];

    try {
      const providerData = await readProviderData(provider);
      providerProjects = providerData.projects;
      providerSessions = providerData.sessions;
    } catch (error) {
      errors.push({ agentKind, message: toErrorMessage(error) });
      continue;
    }

    projects.push(...providerProjects);
    sessions.push(...providerSessions);

    let sessionDetailCount = 0;
    for (const session of providerSessions) {
      try {
        const detail = await provider.getSessionDetail(session.routeId || session.id);
        if (!detail) continue;

        const normalizedDetail = withSessionDetailAgentKind(detail, agentKind);
        const detailPath = toZipPath(
          STANDARDIZED_ARCHIVE_ROOT,
          'session-details',
          agentKind,
          `${safeArchiveFileName(normalizedDetail.id || session.id)}.json`,
        );
        appendJson(archive, detailPath, normalizedDetail);
        sessionDetailIndex.push({
          id: normalizedDetail.id,
          agentKind,
          projectId: normalizedDetail.projectId,
          nativeId: normalizedDetail.nativeId,
          routeId: normalizedDetail.routeId,
          path: detailPath,
        });
        sessionDetailCount++;
      } catch (error) {
        errors.push({
          agentKind,
          sessionId: session.id,
          message: toErrorMessage(error),
        });
      }
    }

    agentCounts[agentKind] = {
      projectCount: providerProjects.length,
      sessionCount: providerSessions.length,
      sessionDetailCount,
    };
  }

  const projectsPath = toZipPath(STANDARDIZED_ARCHIVE_ROOT, 'projects.json');
  const sessionsPath = toZipPath(STANDARDIZED_ARCHIVE_ROOT, 'sessions.json');
  const sessionDetailsIndexPath = toZipPath(STANDARDIZED_ARCHIVE_ROOT, 'session-details-index.json');
  const sessionDetailsRoot = toZipPath(STANDARDIZED_ARCHIVE_ROOT, 'session-details');
  const metaPath = toZipPath(STANDARDIZED_ARCHIVE_ROOT, 'export-meta.json');

  appendJson(archive, projectsPath, {
    schema: `${STANDARDIZED_EXPORT_SCHEMA}.projects`,
    projects,
  });
  appendJson(archive, sessionsPath, {
    schema: `${STANDARDIZED_EXPORT_SCHEMA}.sessions`,
    sessions,
  });
  appendJson(archive, sessionDetailsIndexPath, {
    schema: `${STANDARDIZED_EXPORT_SCHEMA}.session-details-index`,
    sessionDetails: sessionDetailIndex,
  });

  const meta: StandardizedExportMeta = {
    standardizedExportVersion: STANDARDIZED_EXPORT_VERSION,
    schema: STANDARDIZED_EXPORT_SCHEMA,
    exportedAt,
    exportedFrom: os.hostname(),
    platform: process.platform,
    agents,
    projectCount: projects.length,
    sessionCount: sessions.length,
    sessionDetailCount: sessionDetailIndex.length,
    agentCounts,
    files: {
      projects: projectsPath,
      sessions: sessionsPath,
      sessionDetailsIndex: sessionDetailsIndexPath,
      sessionDetailsRoot,
    },
    errors,
  };
  appendJson(archive, metaPath, meta);

  return meta;
}
