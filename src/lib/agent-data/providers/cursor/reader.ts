import type { DashboardStats, ProjectInfo, SessionDetail, SessionInfo } from '@/lib/claude-data/types';
import { zeroCosts } from '@/lib/claude-data/cost-utils';
import { AgentDataCache } from '@/lib/agent-data/cache';
import { makeRouteId, parseRouteId, qualifyProjectId } from '@/lib/agent-data/route-id';
import {
  SESSION_SUMMARY_CACHE_VERSION,
  normalizeSearchText,
  summariesToDashboardStats,
  type CachedSessionSummary,
  type SessionSummarySource,
} from '@/lib/agent-data/session-summary';
import { getFileSignature } from './io';
import { discoverCursorSessionFiles, type CursorSessionFileInfo } from './session-index';
import { resetCursorStateDbCache } from './state-db';
import { parseCursorSessionFile, parseCursorSessionSummaryFile, type CursorParsedSession } from './transcript-parser';

const parsedCache = new AgentDataCache<CursorParsedSession>();
const infoCache = new AgentDataCache<SessionInfo>();
export const CURSOR_SESSION_SUMMARY_PARSER_VERSION = 'cursor-summary-v3';

async function parseDiscoveredSession(fileInfo: CursorSessionFileInfo): Promise<CursorParsedSession> {
  const cached = parsedCache.get({ provider: 'cursor', filePath: fileInfo.filePath, signature: fileInfo.sourceSignature, scope: 'detail' });
  if (cached) return cached;

  const parsed = await parseCursorSessionFile(fileInfo.filePath, fileInfo);
  parsedCache.set({ provider: 'cursor', filePath: fileInfo.filePath, signature: fileInfo.sourceSignature, scope: 'detail' }, parsed);
  return parsed;
}

async function getParsedSessions(): Promise<CursorParsedSession[]> {
  const files = await discoverCursorSessionFiles();
  const parsed = await Promise.all(files.map(parseDiscoveredSession));
  return parsed.sort((left, right) => right.info.timestamp.localeCompare(left.info.timestamp));
}

function routeNativeId(id: string): string {
  return parseRouteId(id).nativeId;
}

function buildLightweightSessionInfo(fileInfo: CursorSessionFileInfo): SessionInfo {
  const cached = infoCache.get({ provider: 'cursor', filePath: fileInfo.filePath, signature: fileInfo.sourceSignature, scope: 'list' });
  if (cached) return cached;

  const summary = parseCursorSessionSummaryFile(fileInfo.filePath, fileInfo);
  const routeId = makeRouteId('cursor', fileInfo.routeNativeId);
  const projectRouteId = qualifyProjectId('cursor', fileInfo.nativeProjectId);
  const info: SessionInfo = {
    id: routeId,
    agentKind: 'cursor',
    nativeId: fileInfo.nativeId,
    routeId,
    projectId: projectRouteId,
    nativeProjectId: fileInfo.nativeProjectId,
    projectRouteId,
    projectName: fileInfo.projectName,
    title: summary.title,
    sourceFilePath: fileInfo.filePath,
    timestamp: summary.createdAt,
    duration: summary.duration,
    messageCount: summary.messageCount,
    userMessageCount: summary.userMessageCount,
    assistantMessageCount: summary.assistantMessageCount,
    toolCallCount: summary.toolCallCount,
    totalInputTokens: summary.tokenUsage.input_tokens,
    totalOutputTokens: summary.tokenUsage.output_tokens,
    totalCacheReadTokens: summary.tokenUsage.cache_read_input_tokens,
    totalCacheWriteTokens: summary.tokenUsage.cache_creation_input_tokens,
    estimatedCost: 0,
    estimatedCosts: zeroCosts(),
    model: summary.model,
    models: summary.models,
    gitBranch: '',
    cwd: fileInfo.cwd,
    version: '',
    toolsUsed: summary.toolsUsed,
    compaction: {
      compactions: 0,
      microcompactions: 0,
      totalTokensSaved: 0,
      compactionTimestamps: [],
    },
  };
  infoCache.set({ provider: 'cursor', filePath: fileInfo.filePath, signature: fileInfo.sourceSignature, scope: 'list' }, info);
  return info;
}

async function getLightweightSessions(): Promise<SessionInfo[]> {
  return (await discoverCursorSessionFiles())
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
      agentKind: 'cursor' as const,
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
  const fileInfo = (await discoverCursorSessionFiles()).find(session => (
    session.routeNativeId === nativeId
    || session.nativeId === nativeId
    || makeRouteId('cursor', session.routeNativeId) === routeOrNativeId
  ));
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

export async function discoverSessionSummarySources(): Promise<SessionSummarySource[]> {
  return (await discoverCursorSessionFiles()).map(fileInfo => ({
    provider: 'cursor',
    parserVersion: CURSOR_SESSION_SUMMARY_PARSER_VERSION,
    sourceFilePath: fileInfo.filePath,
    sourceSignature: fileInfo.sourceSignature,
    nativeProjectId: fileInfo.nativeProjectId,
    projectName: fileInfo.projectName,
    metadata: fileInfo,
  }));
}

function getSourceFileInfo(source: SessionSummarySource): CursorSessionFileInfo {
  const metadata = source.metadata as CursorSessionFileInfo | undefined;
  if (metadata?.filePath === source.sourceFilePath) return metadata;

  const fallbackSignature = getFileSignature(source.sourceFilePath);
  const nativeId = source.sourceFilePath.split(/[\\/]/).at(-2) || source.sourceFilePath;
  const nativeProjectId = source.nativeProjectId || 'cursor';
  const timestamp = fallbackSignature.mtimeMs > 0 ? new Date(fallbackSignature.mtimeMs).toISOString() : new Date(0).toISOString();
  return {
    sourceKind: 'agent',
    filePath: source.sourceFilePath,
    nativeId,
    routeNativeId: `${nativeProjectId}:${nativeId}`,
    projectId: nativeProjectId,
    projectDir: '',
    nativeProjectId,
    projectName: source.projectName || nativeProjectId,
    cwd: '',
    createdAt: timestamp,
    updatedAt: timestamp,
    signature: `${source.sourceSignature.mtimeMs}:${source.sourceSignature.size}`,
    sourceSignature: source.sourceSignature,
  };
}

export async function buildSessionSummary(source: SessionSummarySource): Promise<CachedSessionSummary> {
  const fileInfo = getSourceFileInfo(source);
  const summary = parseCursorSessionSummaryFile(source.sourceFilePath, fileInfo);
  const routeId = makeRouteId('cursor', summary.routeNativeId);
  const projectRouteId = qualifyProjectId('cursor', summary.nativeProjectId);

  return {
    cacheVersion: SESSION_SUMMARY_CACHE_VERSION,
    parserVersion: source.parserVersion,
    provider: 'cursor',
    nativeId: summary.nativeId,
    routeId,
    nativeProjectId: summary.nativeProjectId,
    projectRouteId,
    projectName: summary.projectName,
    sourceFilePath: source.sourceFilePath,
    sourceSignature: source.sourceSignature,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    title: summary.title,
    cwd: summary.cwd,
    gitBranch: '',
    version: '',
    model: summary.model,
    models: summary.models,
    messageCount: summary.messageCount,
    userMessageCount: summary.userMessageCount,
    assistantMessageCount: summary.assistantMessageCount,
    toolCallCount: summary.toolCallCount,
    tokenTotals: {
      input: summary.tokenUsage.input_tokens,
      output: summary.tokenUsage.output_tokens,
      cacheRead: summary.tokenUsage.cache_read_input_tokens,
      cacheWrite: summary.tokenUsage.cache_creation_input_tokens,
      reasoningOutput: summary.reasoningOutputTokens,
    },
    modelUsage: summary.modelUsage,
    toolsUsed: summary.toolsUsed,
    compaction: {
      compactions: 0,
      microcompactions: 0,
      totalTokensSaved: 0,
      compactionTimestamps: [],
    },
    searchTextPreview: normalizeSearchText([
      summary.searchTextPreview,
      summary.title,
      summary.projectName,
      summary.cwd,
    ]),
  };
}

export function buildLightweightSessionSummary(source: SessionSummarySource): CachedSessionSummary {
  const fileInfo = getSourceFileInfo(source);
  const summary = parseCursorSessionSummaryFile(source.sourceFilePath, fileInfo);
  return {
    cacheVersion: SESSION_SUMMARY_CACHE_VERSION,
    parserVersion: source.parserVersion,
    provider: 'cursor',
    nativeId: summary.nativeId,
    routeId: makeRouteId('cursor', summary.routeNativeId),
    nativeProjectId: summary.nativeProjectId,
    projectRouteId: qualifyProjectId('cursor', summary.nativeProjectId),
    projectName: summary.projectName,
    sourceFilePath: source.sourceFilePath,
    sourceSignature: source.sourceSignature,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    title: summary.title,
    cwd: summary.cwd,
    gitBranch: '',
    version: '',
    model: summary.model,
    models: summary.models,
    messageCount: summary.messageCount,
    userMessageCount: summary.userMessageCount,
    assistantMessageCount: summary.assistantMessageCount,
    toolCallCount: summary.toolCallCount,
    tokenTotals: {
      input: summary.tokenUsage.input_tokens,
      output: summary.tokenUsage.output_tokens,
      cacheRead: summary.tokenUsage.cache_read_input_tokens,
      cacheWrite: summary.tokenUsage.cache_creation_input_tokens,
      reasoningOutput: summary.reasoningOutputTokens,
    },
    modelUsage: summary.modelUsage,
    toolsUsed: summary.toolsUsed,
    compaction: {
      compactions: 0,
      microcompactions: 0,
      totalTokensSaved: 0,
      compactionTimestamps: [],
    },
    searchTextPreview: normalizeSearchText([
      summary.searchTextPreview,
      summary.title,
      summary.projectName,
      summary.cwd,
    ]),
  };
}

export async function getDashboardStats(): Promise<DashboardStats> {
  const summaries = await Promise.all((await discoverSessionSummarySources()).map(buildSessionSummary));
  return summariesToDashboardStats(summaries);
}

export function resetCursorReaderCache(): void {
  parsedCache.clear();
  infoCache.clear();
  resetCursorStateDbCache();
}

export function resetCursorReaderCacheForTests(): void {
  resetCursorReaderCache();
}
