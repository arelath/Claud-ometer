import type { DashboardStats, ProjectInfo, SessionDetail, SessionInfo } from '@/lib/claude-data/types';
import { addCosts, zeroCosts } from '@/lib/claude-data/cost-utils';
import { zeroChangeTotals } from '@/lib/claude-data/change-utils';
import { calculateCostAllModes, DEFAULT_COST_MODE } from '@/config/pricing';
import { AgentDataCache } from '@/lib/agent-data/cache';
import { makeRouteId, parseRouteId, qualifyProjectId } from '@/lib/agent-data/route-id';
import {
  SESSION_SUMMARY_CACHE_VERSION,
  normalizeSearchText,
  summariesToDashboardStats,
  type CachedModelUsage,
  type CachedSessionSummary,
  type SessionSummarySource,
} from '@/lib/agent-data/session-summary';
import { getFileSignature } from './io';
import { discoverCopilotSessionFiles, type CopilotSessionFileInfo } from './session-index';
import { parseCopilotSessionFile, parseCopilotSessionSummaryFile, type CopilotParsedSession } from './transcript-parser';
import { getCopilotChatSessionSummary, resetCopilotChatSessionCache, type CopilotChatSessionSummary } from './chat-session';
import { getSessionChangeTotals } from '@/lib/session-diff';
import { buildChangeEvents, buildUsageEvents } from '@/lib/agent-data/event-metrics';

const parsedCache = new AgentDataCache<CopilotParsedSession>();
const infoCache = new AgentDataCache<SessionInfo>();
export const COPILOT_SESSION_SUMMARY_PARSER_VERSION = 'copilot-summary-v8';

async function parseDiscoveredSession(fileInfo: CopilotSessionFileInfo): Promise<CopilotParsedSession> {
  const cached = parsedCache.get({ provider: 'copilot', filePath: fileInfo.filePath, signature: fileInfo.sourceSignature, scope: 'detail' });
  if (cached) return cached;

  const parsed = await parseCopilotSessionFile(fileInfo.filePath, fileInfo);
  parsedCache.set({ provider: 'copilot', filePath: fileInfo.filePath, signature: fileInfo.sourceSignature, scope: 'detail' }, parsed);
  return parsed;
}

async function getParsedSessions(): Promise<CopilotParsedSession[]> {
  const files = await discoverCopilotSessionFiles();
  const parsed = await Promise.all(files.map(parseDiscoveredSession));
  return parsed.sort((left, right) => right.info.timestamp.localeCompare(left.info.timestamp));
}

function getRouteNativeId(fileInfo: CopilotSessionFileInfo): string {
  return `${fileInfo.workspaceHash}:${fileInfo.nativeId}`;
}

function routeNativeId(id: string): string {
  return parseRouteId(id).nativeId;
}

function getRawSessionFilePaths(fileInfo: CopilotSessionFileInfo): string[] {
  const paths = [
    fileInfo.filePath,
    fileInfo.transcriptFilePath,
    fileInfo.chatSessionFilePath,
  ].filter((filePath): filePath is string => Boolean(filePath));

  return Array.from(new Set(paths));
}

function buildModelUsage(chatSummary: CopilotChatSessionSummary): Record<string, CachedModelUsage> {
  const modelUsage: Record<string, CachedModelUsage> = {};
  for (const [model, usage] of Object.entries(chatSummary.modelUsage)) {
    modelUsage[model] = {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadInputTokens: usage.cacheReadInputTokens,
      cacheCreationInputTokens: usage.cacheCreationInputTokens,
      reasoningOutputTokens: usage.reasoningOutputTokens,
      contextWindow: usage.contextWindow,
      maxOutputTokens: usage.maxOutputTokens,
    };
  }
  return modelUsage;
}

function calculateCosts(modelUsage: Record<string, CachedModelUsage>) {
  let costs = zeroCosts();
  for (const [model, usage] of Object.entries(modelUsage)) {
    if (!model || model === 'unknown') continue;
    costs = addCosts(
      costs,
      calculateCostAllModes(
        model,
        usage.inputTokens,
        usage.outputTokens,
        usage.cacheCreationInputTokens,
        usage.cacheReadInputTokens,
      ),
    );
  }
  return costs;
}

function buildLightweightSessionInfo(fileInfo: CopilotSessionFileInfo): SessionInfo {
  const cached = infoCache.get({ provider: 'copilot', filePath: fileInfo.filePath, signature: fileInfo.sourceSignature, scope: 'list' });
  if (cached) return cached;

  if (fileInfo.sourceKind === 'legacy') {
    const summary = parseCopilotSessionSummaryFile(fileInfo.filePath, fileInfo);
    const estimatedCosts = calculateCosts(summary.modelUsage);
    const routeId = makeRouteId('copilot', getRouteNativeId(fileInfo));
    const projectRouteId = qualifyProjectId('copilot', fileInfo.nativeProjectId);
    const info: SessionInfo = {
      id: routeId,
      agentKind: 'copilot',
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
      estimatedCost: estimatedCosts[DEFAULT_COST_MODE],
      estimatedCosts,
      model: summary.model,
      models: summary.models,
      gitBranch: '',
      cwd: fileInfo.cwd,
      version: summary.version,
      toolsUsed: summary.toolsUsed,
      compaction: {
        compactions: 0,
        microcompactions: 0,
        totalTokensSaved: 0,
        compactionTimestamps: [],
      },
    };
    infoCache.set({ provider: 'copilot', filePath: fileInfo.filePath, signature: fileInfo.sourceSignature, scope: 'list' }, info);
    return info;
  }

  // Discovery itself stays metadata-only; the regular lightweight reader API
  // still enriches chat-only sessions with their persisted summary fields.
  const chatSummary = getCopilotChatSessionSummary(fileInfo.chatSessionFilePath);
  const modelUsage = buildModelUsage(chatSummary);
  const estimatedCosts = calculateCosts(modelUsage);
  const routeId = makeRouteId('copilot', getRouteNativeId(fileInfo));
  const projectRouteId = qualifyProjectId('copilot', fileInfo.nativeProjectId);
  const timestamp = chatSummary.createdAt || fileInfo.createdAt || new Date(fileInfo.sourceSignature.mtimeMs || 0).toISOString();
  const updatedAt = chatSummary.updatedAt || fileInfo.updatedAt || timestamp;
  const duration = Math.max(0, new Date(updatedAt).getTime() - new Date(timestamp).getTime());
  const info: SessionInfo = {
    id: routeId,
    agentKind: 'copilot',
    nativeId: fileInfo.nativeId,
    routeId,
    projectId: projectRouteId,
    nativeProjectId: fileInfo.nativeProjectId,
    projectRouteId,
    projectName: fileInfo.projectName,
    title: chatSummary.title || fileInfo.title,
    sourceFilePath: fileInfo.filePath,
    sourceFilePaths: getRawSessionFilePaths(fileInfo),
    timestamp,
    duration: Number.isNaN(duration) ? 0 : duration,
    messageCount: 0,
    userMessageCount: 0,
    assistantMessageCount: 0,
    toolCallCount: 0,
    totalInputTokens: chatSummary.usage.inputTokens,
    totalOutputTokens: chatSummary.usage.outputTokens,
    totalCacheReadTokens: chatSummary.usage.cacheReadInputTokens,
    totalCacheWriteTokens: chatSummary.usage.cacheCreationInputTokens,
    estimatedCost: estimatedCosts[DEFAULT_COST_MODE],
    estimatedCosts,
    model: chatSummary.model,
    models: chatSummary.models,
    gitBranch: '',
    cwd: fileInfo.cwd,
    version: chatSummary.version || fileInfo.version || '',
    toolsUsed: {},
    compaction: {
      compactions: 0,
      microcompactions: 0,
      totalTokensSaved: 0,
      compactionTimestamps: [],
    },
  };
  infoCache.set({ provider: 'copilot', filePath: fileInfo.filePath, signature: fileInfo.sourceSignature, scope: 'list' }, info);
  return info;
}

async function getLightweightSessions(): Promise<SessionInfo[]> {
  return (await discoverCopilotSessionFiles())
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
      agentKind: 'copilot' as const,
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
  const fileInfo = (await discoverCopilotSessionFiles()).find(session => (
    session.routeNativeId === nativeId
    || session.nativeId === nativeId
    || makeRouteId('copilot', session.routeNativeId) === routeOrNativeId
  ));
  if (!fileInfo) return null;
  const detail = (await parseDiscoveredSession(fileInfo)).detail;
  return {
    ...detail,
    sourceFilePaths: getRawSessionFilePaths(fileInfo),
  };
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
  return (await discoverCopilotSessionFiles()).map(fileInfo => ({
    provider: 'copilot',
    parserVersion: COPILOT_SESSION_SUMMARY_PARSER_VERSION,
    sourceFilePath: fileInfo.filePath,
    sourceSignature: fileInfo.sourceSignature,
    nativeProjectId: fileInfo.nativeProjectId,
    projectName: fileInfo.projectName,
    metadata: fileInfo,
  }));
}

function getSourceFileInfo(source: SessionSummarySource): CopilotSessionFileInfo {
  const metadata = source.metadata as CopilotSessionFileInfo | undefined;
  if (metadata?.filePath === source.sourceFilePath) return metadata;

  const fallbackSignature = getFileSignature(source.sourceFilePath);
  const nativeId = source.sourceFilePath.split(/[\\/]/).at(-1)?.replace(/\.jsonl$/, '') || source.sourceFilePath;
  const workspaceHash = source.nativeProjectId || 'copilot';
  const workspaceParts = source.sourceFilePath.split(/[\\/]+GitHub\.copilot-chat[\\/]+transcripts[\\/]+/i);
  const workspaceDir = workspaceParts.length > 1 ? workspaceParts[0] : '';
  const chatSessionFilePath = workspaceDir
    ? `${workspaceDir}${source.sourceFilePath.includes('\\') ? '\\' : '/'}chatSessions${source.sourceFilePath.includes('\\') ? '\\' : '/'}${nativeId}.jsonl`
    : undefined;
  const timestamp = fallbackSignature.mtimeMs > 0 ? new Date(fallbackSignature.mtimeMs).toISOString() : new Date(0).toISOString();
  return {
    filePath: source.sourceFilePath,
    sourceKind: source.sourceFilePath.replace(/\\/g, '/').includes('/session-state/') ? 'legacy' : 'vscode',
    chatSessionFilePath,
    nativeId,
    routeNativeId: `${workspaceHash}:${nativeId}`,
    workspaceHash,
    workspaceDir,
    workspaceJsonPath: '',
    nativeProjectId: workspaceHash,
    projectName: source.projectName || workspaceHash,
    cwd: '',
    createdAt: timestamp,
    updatedAt: timestamp,
    signature: `${source.sourceSignature.mtimeMs}:${source.sourceSignature.size}`,
    sourceSignature: source.sourceSignature,
  };
}

export async function buildSessionSummary(source: SessionSummarySource): Promise<CachedSessionSummary> {
  const fileInfo = getSourceFileInfo(source);
  const summary = parseCopilotSessionSummaryFile(source.sourceFilePath, fileInfo);
  const parsed = await parseCopilotSessionFile(source.sourceFilePath, fileInfo);
  const changeTotals = getSessionChangeTotals(parsed.detail.messages);
  const routeId = makeRouteId('copilot', summary.routeNativeId);
  const projectRouteId = qualifyProjectId('copilot', summary.nativeProjectId);
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
    provider: 'copilot',
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
      summary.version,
      summary.model,
      ...summary.models,
      ...Object.keys(summary.toolsUsed || {}),
    ]),
  };
}

export function buildLightweightSessionSummary(source: SessionSummarySource): CachedSessionSummary {
  const fileInfo = getSourceFileInfo(source);
  if (fileInfo.sourceKind === 'legacy') {
    const summary = parseCopilotSessionSummaryFile(source.sourceFilePath, fileInfo);
    const routeId = makeRouteId('copilot', summary.routeNativeId);
    const projectRouteId = qualifyProjectId('copilot', summary.nativeProjectId);
    return {
      cacheVersion: SESSION_SUMMARY_CACHE_VERSION,
      parserVersion: source.parserVersion,
      provider: 'copilot',
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
        summary.version,
        summary.model,
        ...summary.models,
        ...Object.keys(summary.toolsUsed || {}),
      ]),
    };
  }

  const chatSummary = getCopilotChatSessionSummary(fileInfo.chatSessionFilePath);
  const modelUsage = buildModelUsage(chatSummary);
  const routeId = makeRouteId('copilot', getRouteNativeId(fileInfo));
  const projectRouteId = qualifyProjectId('copilot', fileInfo.nativeProjectId);
  const timestamp = chatSummary.createdAt
    || fileInfo.createdAt
    || new Date(source.sourceSignature.mtimeMs || 0).toISOString();
  const updatedAt = chatSummary.updatedAt || fileInfo.updatedAt || timestamp;

  return {
    cacheVersion: SESSION_SUMMARY_CACHE_VERSION,
    parserVersion: source.parserVersion,
    provider: 'copilot',
    nativeId: fileInfo.nativeId,
    routeId,
    nativeProjectId: fileInfo.nativeProjectId,
    projectRouteId,
    projectName: fileInfo.projectName,
    sourceFilePath: source.sourceFilePath,
    sourceSignature: source.sourceSignature,
    createdAt: timestamp,
    updatedAt,
    title: chatSummary.title || fileInfo.title,
    cwd: fileInfo.cwd,
    gitBranch: '',
    version: chatSummary.version || fileInfo.version || '',
    model: chatSummary.model,
    models: chatSummary.models,
    messageCount: chatSummary.userMessageCount + chatSummary.assistantMessageCount,
    userMessageCount: chatSummary.userMessageCount,
    assistantMessageCount: chatSummary.assistantMessageCount,
    toolCallCount: 0,
    tokenTotals: {
      input: chatSummary.usage.inputTokens,
      output: chatSummary.usage.outputTokens,
      cacheRead: chatSummary.usage.cacheReadInputTokens,
      cacheWrite: chatSummary.usage.cacheCreationInputTokens,
      reasoningOutput: chatSummary.usage.reasoningOutputTokens,
    },
    modelUsage,
    changeTotals: zeroChangeTotals(),
    toolsUsed: {},
    compaction: {
      compactions: 0,
      microcompactions: 0,
      totalTokensSaved: 0,
      compactionTimestamps: [],
    },
    searchTextPreview: normalizeSearchText([
      chatSummary.title,
      chatSummary.version,
      fileInfo.title,
      fileInfo.projectName,
      fileInfo.cwd,
      fileInfo.version,
      chatSummary.model,
      ...chatSummary.models,
    ]),
  };
}

export async function getDashboardStats(): Promise<DashboardStats> {
  const parsed = await getParsedSessions();
  const summaries = await Promise.all((await discoverSessionSummarySources()).map(buildSessionSummary));
  if (summaries.length > 0) return summariesToDashboardStats(summaries);

  return {
    totalSessions: parsed.length,
    totalMessages: parsed.reduce((sum, session) => sum + session.info.messageCount, 0),
    totalTokens: 0,
    estimatedCost: 0,
    estimatedCosts: zeroCosts(),
    dailyActivity: [],
    dailyModelTokens: [],
    changeTotals: zeroChangeTotals(),
    dailyChangeActivity: [],
    modelUsage: {},
    hourCounts: {},
    firstSessionDate: parsed.map(session => session.info.timestamp).sort()[0]?.slice(0, 10) || '',
    longestSession: { sessionId: '', duration: 0, messageCount: 0, timestamp: '' },
    projectCount: new Set(parsed.map(session => session.info.projectId)).size,
    recentSessions: parsed.map(session => session.info).slice(0, 10),
  };
}

export function resetCopilotReaderCache(): void {
  parsedCache.clear();
  infoCache.clear();
  resetCopilotChatSessionCache();
}

export function resetCopilotReaderCacheForTests(): void {
  resetCopilotReaderCache();
}
