import type { DashboardStats, ProjectInfo, SessionDetail, SessionInfo } from '@/lib/claude-data/types';
import { addCosts, zeroCosts } from '@/lib/claude-data/cost-utils';
import { zeroChangeTotals } from '@/lib/claude-data/change-utils';
import { DEFAULT_COST_MODE } from '@/config/pricing';
import { makeRouteId, parseRouteId, qualifyProjectId } from '@/lib/agent-data/route-id';
import { AgentDataCache } from '@/lib/agent-data/cache';
import {
  SESSION_SUMMARY_CACHE_VERSION,
  normalizeSearchText,
  type CachedSessionSummary,
  type SessionSummarySource,
} from '@/lib/agent-data/session-summary';
import { discoverCodexSessionFiles, type CodexSessionFileInfo } from './session-index';
import { getFileSignature } from './io';
import { parseCodexSessionFile, parseCodexSessionSummaryFile, type CodexParsedSession } from './transcript-parser';
import { buildCodexDashboardStats } from './stats';
import { getSessionChangeTotals } from '@/lib/session-diff';
import { buildChangeEvents, buildUsageEvents } from '@/lib/agent-data/event-metrics';

const parsedCache = new AgentDataCache<CodexParsedSession>();
const infoCache = new AgentDataCache<SessionInfo>();
export const CODEX_SESSION_SUMMARY_PARSER_VERSION = 'codex-summary-v5';

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
    sourceFilePaths: [fileInfo.filePath],
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

export async function discoverSessionSummarySources(): Promise<SessionSummarySource[]> {
  return (await discoverCodexSessionFiles()).map(fileInfo => ({
    provider: 'codex',
    parserVersion: CODEX_SESSION_SUMMARY_PARSER_VERSION,
    sourceFilePath: fileInfo.filePath,
    sourceSignature: getFileSignature(fileInfo.filePath),
    nativeProjectId: getProjectNativeId(fileInfo.cwd, fileInfo.filePath),
    projectName: fileInfo.cwd ? fileInfo.cwd.split(/[\\/]/).filter(Boolean).at(-1) || 'codex' : 'codex',
    metadata: fileInfo,
  }));
}

function getSourceFileInfo(source: SessionSummarySource): CodexSessionFileInfo {
  const metadata = source.metadata as CodexSessionFileInfo | undefined;
  return metadata?.filePath === source.sourceFilePath
    ? metadata
    : {
        filePath: source.sourceFilePath,
        nativeId: source.sourceFilePath,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(source.sourceSignature.mtimeMs || 0).toISOString(),
        cwd: '',
        signature: `${source.sourceSignature.mtimeMs}:${source.sourceSignature.size}`,
      };
}

export async function buildSessionSummary(source: SessionSummarySource): Promise<CachedSessionSummary> {
  const fileInfo = getSourceFileInfo(source);
  const summary = parseCodexSessionSummaryFile(source.sourceFilePath, fileInfo);
  const parsed = await parseCodexSessionFile(source.sourceFilePath, fileInfo);
  const changeTotals = getSessionChangeTotals(parsed.detail.messages);
  const modelUsage = {
    [summary.model || 'unknown']: {
      inputTokens: summary.tokenUsage.input_tokens,
      outputTokens: summary.tokenUsage.output_tokens,
      cacheReadInputTokens: summary.tokenUsage.cache_read_input_tokens,
      cacheCreationInputTokens: summary.tokenUsage.cache_creation_input_tokens,
      reasoningOutputTokens: summary.reasoningOutputTokens,
    },
  };
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
    modelUsage,
  };
  const nativeProjectId = getProjectNativeId(summary.cwd, source.sourceFilePath);
  const projectRouteId = qualifyProjectId('codex', nativeProjectId);
  const routeId = makeRouteId('codex', summary.nativeId);
  const searchTextPreview = normalizeSearchText([
    summary.searchTextPreview,
    summary.title,
    summary.cwd,
    summary.gitBranch,
    summary.version,
    summary.model,
    ...summary.models,
    ...Object.keys(summary.toolsUsed || {}),
  ]);

  return {
    cacheVersion: SESSION_SUMMARY_CACHE_VERSION,
    parserVersion: source.parserVersion,
    provider: 'codex',
    nativeId: summary.nativeId,
    routeId,
    nativeProjectId,
    projectRouteId,
    projectName: summary.cwd ? summary.cwd.split(/[\\/]/).filter(Boolean).at(-1) || 'codex' : 'codex',
    sourceFilePath: source.sourceFilePath,
    sourceSignature: source.sourceSignature,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    title: summary.title,
    cwd: summary.cwd,
    gitBranch: summary.gitBranch,
    version: summary.version,
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
    modelUsage,
    changeTotals,
    usageEvents: buildUsageEvents(parsed.detail.messages, summaryMetrics),
    changeEvents: buildChangeEvents(parsed.detail.messages),
    toolsUsed: summary.toolsUsed,
    compaction: summary.compaction,
    searchTextPreview,
  };
}

export function buildLightweightSessionSummary(source: SessionSummarySource): CachedSessionSummary {
  const fileInfo = getSourceFileInfo(source);
  const nativeProjectId = getProjectNativeId(fileInfo.cwd, source.sourceFilePath);
  const projectRouteId = qualifyProjectId('codex', nativeProjectId);
  const routeId = makeRouteId('codex', fileInfo.nativeId);
  const timestamp = fileInfo.createdAt || new Date(source.sourceSignature.mtimeMs || 0).toISOString();
  const updatedAt = fileInfo.updatedAt || timestamp;
  const model = fileInfo.model || 'unknown';
  const models = model === 'unknown' ? [] : [model];

  return {
    cacheVersion: SESSION_SUMMARY_CACHE_VERSION,
    parserVersion: source.parserVersion,
    provider: 'codex',
    nativeId: fileInfo.nativeId,
    routeId,
    nativeProjectId,
    projectRouteId,
    projectName: fileInfo.cwd ? fileInfo.cwd.split(/[\\/]/).filter(Boolean).at(-1) || 'codex' : 'codex',
    sourceFilePath: source.sourceFilePath,
    sourceSignature: source.sourceSignature,
    createdAt: timestamp,
    updatedAt,
    title: fileInfo.title,
    cwd: fileInfo.cwd,
    gitBranch: fileInfo.gitBranch || '',
    version: fileInfo.version || '',
    model,
    models,
    messageCount: 0,
    userMessageCount: 0,
    assistantMessageCount: 0,
    toolCallCount: 0,
    tokenTotals: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reasoningOutput: 0,
    },
    modelUsage: {},
    changeTotals: zeroChangeTotals(),
    toolsUsed: {},
    compaction: {
      compactions: 0,
      microcompactions: 0,
      totalTokensSaved: 0,
      compactionTimestamps: [],
    },
    searchTextPreview: normalizeSearchText([
      fileInfo.title,
      fileInfo.cwd,
      fileInfo.gitBranch,
      fileInfo.version,
      model,
      ...models,
    ]),
  };
}

export async function getDashboardStats(): Promise<DashboardStats> {
  return buildCodexDashboardStats(await getParsedSessions());
}

export function resetCodexReaderCache(): void {
  parsedCache.clear();
  infoCache.clear();
}

export function resetCodexReaderCacheForTests(): void {
  resetCodexReaderCache();
}
