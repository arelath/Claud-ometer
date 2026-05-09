import type { DashboardStats, ProjectInfo, SessionDetail, SessionInfo } from '@/lib/claude-data/types';
import { addCosts, zeroCosts } from '@/lib/claude-data/cost-utils';
import { DEFAULT_COST_MODE } from '@/config/pricing';
import { makeRouteId, parseRouteId, qualifyProjectId } from '@/lib/agent-data/route-id';
import { AgentDataCache } from '@/lib/agent-data/cache';
import { discoverCodexSessionFiles, type CodexSessionFileInfo } from './session-index';
import { getFileSignature } from './io';
import { parseCodexSessionFile, type CodexParsedSession } from './transcript-parser';
import { buildCodexDashboardStats } from './stats';

const parsedCache = new AgentDataCache<CodexParsedSession>();
const infoCache = new AgentDataCache<SessionInfo>();

async function parseDiscoveredSession(fileInfo: CodexSessionFileInfo): Promise<CodexParsedSession> {
  const signature = getFileSignature(fileInfo.filePath);
  const cached = parsedCache.get({ provider: 'codex', filePath: fileInfo.filePath, signature, scope: 'detail' });
  if (cached) return cached;

  const parsed = await parseCodexSessionFile(fileInfo.filePath, fileInfo);
  parsedCache.set({ provider: 'codex', filePath: fileInfo.filePath, signature, scope: 'detail' }, parsed);
  return parsed;
}

async function getParsedSessions(): Promise<CodexParsedSession[]> {
  const files = await discoverCodexSessionFiles();
  const parsed = await Promise.all(files.map(parseDiscoveredSession));
  return parsed.sort((left, right) => right.info.timestamp.localeCompare(left.info.timestamp));
}

function routeNativeId(id: string): string {
  return parseRouteId(id).nativeId;
}

function getProjectNativeId(cwd: string, fallbackFilePath: string): string {
  const source = cwd || fallbackFilePath;
  return source.replace(/^[A-Za-z]:/, match => match[0]).replace(/[\\/:]+/g, '-').replace(/^-+|-+$/g, '') || 'codex';
}

function buildLightweightSessionInfo(fileInfo: CodexSessionFileInfo): SessionInfo {
  const signature = getFileSignature(fileInfo.filePath);
  const cached = infoCache.get({ provider: 'codex', filePath: fileInfo.filePath, signature, scope: 'list' });
  if (cached) return cached;

  const nativeProjectId = getProjectNativeId(fileInfo.cwd, fileInfo.filePath);
  const projectRouteId = qualifyProjectId('codex', nativeProjectId);
  const routeId = makeRouteId('codex', fileInfo.nativeId);
  const timestamp = fileInfo.updatedAt || fileInfo.createdAt || new Date(0).toISOString();
  const duration = fileInfo.createdAt && fileInfo.updatedAt
    ? Math.max(0, new Date(fileInfo.updatedAt).getTime() - new Date(fileInfo.createdAt).getTime())
    : 0;
  const model = fileInfo.model || 'unknown';
  const info: SessionInfo = {
    id: routeId,
    agentKind: 'codex',
    nativeId: fileInfo.nativeId,
    routeId,
    projectId: projectRouteId,
    nativeProjectId,
    projectRouteId,
    projectName: fileInfo.cwd ? fileInfo.cwd.split(/[\\/]/).filter(Boolean).at(-1) || nativeProjectId : nativeProjectId,
    title: fileInfo.title,
    sourceFilePath: fileInfo.filePath,
    timestamp,
    duration,
    messageCount: 0,
    userMessageCount: 0,
    assistantMessageCount: 0,
    toolCallCount: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    estimatedCost: 0,
    estimatedCosts: zeroCosts(),
    model,
    models: model === 'unknown' ? [] : [model],
    gitBranch: fileInfo.gitBranch || '',
    cwd: fileInfo.cwd,
    version: fileInfo.version || '',
    toolsUsed: {},
    compaction: {
      compactions: 0,
      microcompactions: 0,
      totalTokensSaved: 0,
      compactionTimestamps: [],
    },
  };
  infoCache.set({ provider: 'codex', filePath: fileInfo.filePath, signature, scope: 'list' }, info);
  return info;
}

async function getLightweightSessions(): Promise<SessionInfo[]> {
  const files = await discoverCodexSessionFiles();
  return files
    .map(buildLightweightSessionInfo)
    .sort((left, right) => right.timestamp.localeCompare(left.timestamp));
}

export async function getSessions(limit = 50, offset = 0): Promise<SessionInfo[]> {
  return (await getLightweightSessions()).slice(offset, offset + limit);
}

export async function getProjects(): Promise<ProjectInfo[]> {
  const sessions = await getLightweightSessions();
  const projects = new Map<string, ProjectInfo>();

  for (const session of sessions) {
    const project = projects.get(session.projectId) || {
      id: session.projectId,
      agentKind: 'codex' as const,
      nativeId: session.nativeProjectId,
      routeId: session.projectRouteId,
      name: session.projectName,
      path: session.cwd || session.projectName,
      sessionCount: 0,
      totalMessages: 0,
      totalTokens: 0,
      estimatedCost: 0,
      estimatedCosts: zeroCosts(),
      lastActive: '',
      models: [],
    };

    project.sessionCount += 1;
    project.totalMessages += session.messageCount;
    project.totalTokens += session.totalInputTokens + session.totalOutputTokens + session.totalCacheReadTokens + session.totalCacheWriteTokens;
    project.estimatedCosts = addCosts(project.estimatedCosts, session.estimatedCosts);
    project.estimatedCost = project.estimatedCosts[DEFAULT_COST_MODE];
    project.lastActive = project.lastActive && project.lastActive > session.timestamp ? project.lastActive : session.timestamp;
    project.models = Array.from(new Set([...project.models, ...session.models]));
    projects.set(session.projectId, project);
  }

  return Array.from(projects.values()).sort((left, right) => right.lastActive.localeCompare(left.lastActive));
}

export async function getProjectSessions(projectId: string): Promise<SessionInfo[]> {
  const nativeProjectId = routeNativeId(projectId);
  return (await getLightweightSessions())
    .filter(session => session.nativeProjectId === nativeProjectId || session.projectId === projectId)
    .sort((left, right) => right.timestamp.localeCompare(left.timestamp));
}

export async function getSessionDetail(routeOrNativeId: string): Promise<SessionDetail | null> {
  const nativeId = routeNativeId(routeOrNativeId);
  const fileInfo = (await discoverCodexSessionFiles()).find(session => session.nativeId === nativeId || makeRouteId('codex', session.nativeId) === routeOrNativeId);
  if (!fileInfo) return null;
  return (await parseDiscoveredSession(fileInfo)).detail;
}

export async function searchSessions(query: string, limit = 50): Promise<SessionInfo[]> {
  if (!query.trim()) return getSessions(limit, 0);
  const lowerQuery = query.toLowerCase();
  return (await getParsedSessions())
    .filter(parsed => parsed.searchableText.includes(lowerQuery))
    .map(parsed => parsed.info)
    .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
    .slice(0, limit);
}

export async function getDashboardStats(): Promise<DashboardStats> {
  return buildCodexDashboardStats(await getParsedSessions());
}

export function resetCodexReaderCacheForTests(): void {
  parsedCache.clear();
  infoCache.clear();
}
