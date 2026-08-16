import path from 'path';
import { DEFAULT_COST_MODE } from '@/config/pricing';
import type {
  DashboardStats,
  ProjectInfo,
  SessionDetail,
  SessionInfo,
  SessionSubagentDisplay,
} from '@/lib/claude-data/types';
import { zeroChangeTotals } from '@/lib/claude-data/change-utils';
import { addCosts, zeroCosts } from '@/lib/claude-data/cost-utils';
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
import { getSessionChangeTotals } from '@/lib/session-diff';
import { buildChangeEvents, buildUsageEvents } from '@/lib/agent-data/event-metrics';

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

function getRawSessionFilePaths(fileInfo: CursorSessionFileInfo): string[] {
  const paths = fileInfo.sourceKind === 'chat'
    ? [fileInfo.dbPath]
    : [fileInfo.filePath];

  return Array.from(new Set(paths.filter((filePath): filePath is string => Boolean(filePath))));
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
    sourceFilePaths: getRawSessionFilePaths(fileInfo),
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
  const detail = (await parseDiscoveredSession(fileInfo)).detail;
  return {
    ...detail,
    sourceFilePaths: getRawSessionFilePaths(fileInfo),
  };
}

function isPathInside(parentPath: string, candidatePath: string): boolean {
  const relative = path.relative(parentPath, candidatePath);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function cursorSessionDirectory(filePath: string): string {
  const parentDir = path.dirname(filePath);
  if (path.basename(parentDir).toLowerCase() !== 'subagents') return parentDir;
  return path.join(parentDir, path.basename(filePath, path.extname(filePath)));
}

function cursorSubagentDisplay(
  rootFileInfo: Extract<CursorSessionFileInfo, { sourceKind: 'agent' }>,
  childFileInfo: Extract<CursorSessionFileInfo, { sourceKind: 'agent' }>,
): SessionSubagentDisplay {
  const sessionDir = cursorSessionDirectory(rootFileInfo.filePath);
  const relativePath = path.relative(sessionDir, childFileInfo.filePath).replace(/\\/g, '/');
  const segments = relativePath.split('/');
  const depth = Math.max(1, segments.filter(segment => segment === 'subagents').length);
  const parentBoundary = segments.lastIndexOf('subagents');
  const parentId = parentBoundary > 0
    ? segments[parentBoundary - 1].replace(/\.(?:jsonl|txt)$/i, '')
    : rootFileInfo.nativeId;
  return {
    id: childFileInfo.nativeId,
    parentId,
    path: relativePath,
    depth,
  };
}

function mergeCursorSessionDetails(
  rootFileInfo: Extract<CursorSessionFileInfo, { sourceKind: 'agent' }>,
  members: Array<{ fileInfo: Extract<CursorSessionFileInfo, { sourceKind: 'agent' }>; parsed: CursorParsedSession }>,
): SessionDetail {
  const root = members[0].parsed.detail;
  const messages = members.flatMap(({ fileInfo, parsed }, memberIndex) => {
    const subagent = memberIndex === 0 ? undefined : cursorSubagentDisplay(rootFileInfo, fileInfo);
    return parsed.detail.messages.map((message, messageIndex) => ({
      message: subagent ? { ...message, subagent } : message,
      memberIndex,
      messageIndex,
    }));
  }).sort((left, right) => {
    const leftTime = new Date(left.message.timestamp).getTime();
    const rightTime = new Date(right.message.timestamp).getTime();
    if (!Number.isNaN(leftTime) && !Number.isNaN(rightTime) && leftTime !== rightTime) return leftTime - rightTime;
    return left.memberIndex - right.memberIndex || left.messageIndex - right.messageIndex;
  }).map(item => item.message);

  const toolsUsed: Record<string, number> = {};
  let estimatedCosts = zeroCosts();
  let updatedAtMs = new Date(root.timestamp).getTime() + root.duration;
  for (const { parsed } of members) {
    estimatedCosts = addCosts(estimatedCosts, parsed.info.estimatedCosts);
    const memberUpdatedAtMs = new Date(parsed.info.timestamp).getTime() + parsed.info.duration;
    if (!Number.isNaN(memberUpdatedAtMs)) updatedAtMs = Math.max(updatedAtMs, memberUpdatedAtMs);
    for (const [tool, count] of Object.entries(parsed.info.toolsUsed)) {
      toolsUsed[tool] = (toolsUsed[tool] || 0) + count;
    }
  }

  return {
    ...root,
    sourceFilePath: rootFileInfo.filePath,
    sourceFilePaths: members.map(member => member.fileInfo.filePath),
    duration: Math.max(0, updatedAtMs - new Date(root.timestamp).getTime()),
    messageCount: members.reduce((sum, member) => sum + member.parsed.info.messageCount, 0),
    userMessageCount: members.reduce((sum, member) => sum + member.parsed.info.userMessageCount, 0),
    assistantMessageCount: members.reduce((sum, member) => sum + member.parsed.info.assistantMessageCount, 0),
    toolCallCount: members.reduce((sum, member) => sum + member.parsed.info.toolCallCount, 0),
    totalInputTokens: members.reduce((sum, member) => sum + member.parsed.info.totalInputTokens, 0),
    totalOutputTokens: members.reduce((sum, member) => sum + member.parsed.info.totalOutputTokens, 0),
    totalCacheReadTokens: members.reduce((sum, member) => sum + member.parsed.info.totalCacheReadTokens, 0),
    totalCacheWriteTokens: members.reduce((sum, member) => sum + member.parsed.info.totalCacheWriteTokens, 0),
    estimatedCost: estimatedCosts[DEFAULT_COST_MODE],
    estimatedCosts,
    models: Array.from(new Set(members.flatMap(member => member.parsed.info.models))),
    toolsUsed,
    compaction: {
      compactions: members.reduce((sum, member) => sum + member.parsed.info.compaction.compactions, 0),
      microcompactions: members.reduce((sum, member) => sum + member.parsed.info.compaction.microcompactions, 0),
      totalTokensSaved: members.reduce((sum, member) => sum + member.parsed.info.compaction.totalTokensSaved, 0),
      compactionTimestamps: members.flatMap(member => member.parsed.info.compaction.compactionTimestamps).sort(),
    },
    messages,
  };
}

export async function getSessionDetailWithDescendants(routeOrNativeId: string): Promise<SessionDetail | null> {
  const nativeId = routeNativeId(routeOrNativeId);
  const files = await discoverCursorSessionFiles();
  const fileInfo = files.find(session => (
    session.routeNativeId === nativeId
    || session.nativeId === nativeId
    || makeRouteId('cursor', session.routeNativeId) === routeOrNativeId
  ));
  if (!fileInfo) return null;
  if (fileInfo.sourceKind === 'chat') {
    const detail = (await parseDiscoveredSession(fileInfo)).detail;
    return { ...detail, sourceFilePaths: getRawSessionFilePaths(fileInfo) };
  }

  const descendantRoot = path.join(cursorSessionDirectory(fileInfo.filePath), 'subagents');
  const descendants = files
    .filter((candidate): candidate is Extract<CursorSessionFileInfo, { sourceKind: 'agent' }> => (
      candidate.sourceKind === 'agent' && isPathInside(descendantRoot, candidate.filePath)
    ))
    .sort((left, right) => left.filePath.localeCompare(right.filePath));
  const members = [fileInfo, ...descendants];
  const parsedMembers = await Promise.all(members.map(async member => ({
    fileInfo: member,
    parsed: await parseDiscoveredSession(member),
  })));
  return mergeCursorSessionDetails(fileInfo, parsedMembers);
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
  const parsed = await parseCursorSessionFile(source.sourceFilePath, fileInfo);
  const changeTotals = getSessionChangeTotals(parsed.detail.messages);
  const routeId = makeRouteId('cursor', summary.routeNativeId);
  const projectRouteId = qualifyProjectId('cursor', summary.nativeProjectId);
  const summaryMetrics = {
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    model: summary.model,
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
  };

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
    changeTotals,
    usageEvents: buildUsageEvents(parsed.detail.messages, summaryMetrics),
    changeEvents: buildChangeEvents(parsed.detail.messages),
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
    changeTotals: zeroChangeTotals(),
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
