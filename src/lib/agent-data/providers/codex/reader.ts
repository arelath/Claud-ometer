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
import {
  discoverCodexLogicalSessions,
  type CodexLogicalSessionInfo,
  type CodexSessionFileInfo,
} from './session-index';
import {
  parseCodexRecords,
  parseCodexSessionFile,
  parseCodexSessionSummaryFile,
  readCodexRecords,
  readCodexRecordsSync,
  type CodexParsedSession,
} from './transcript-parser';
import { scopeCodexSubagentRecords, subagentDisplay } from './subagent';
import { buildCodexDashboardStats } from './stats';
import { getSessionChangeTotals } from '@/lib/session-diff';
import { buildChangeEvents, buildUsageEvents } from '@/lib/agent-data/event-metrics';

const parsedCache = new AgentDataCache<CodexParsedSession>();
const infoCache = new AgentDataCache<SessionInfo>();
export const CODEX_SESSION_SUMMARY_PARSER_VERSION = 'codex-summary-v8';

function mergeParsedSessions(logical: CodexLogicalSessionInfo, parsedMembers: CodexParsedSession[]): CodexParsedSession {
  const rootParsed = parsedMembers[0];
  const rootInfo = rootParsed.info;
  const messages = parsedMembers.flatMap((parsed, memberIndex) => parsed.detail.messages.map((message, messageIndex) => ({
    message,
    memberIndex,
    messageIndex,
  }))).sort((left, right) => {
    const leftTime = new Date(left.message.timestamp).getTime();
    const rightTime = new Date(right.message.timestamp).getTime();
    if (!Number.isNaN(leftTime) && !Number.isNaN(rightTime) && leftTime !== rightTime) return leftTime - rightTime;
    return left.memberIndex - right.memberIndex || left.messageIndex - right.messageIndex;
  }).map(item => item.message);
  const modelUsage: CodexParsedSession['modelUsage'] = {};
  const toolsUsed: Record<string, number> = {};
  let estimatedCosts = zeroCosts();
  let updatedAtMs = new Date(rootInfo.timestamp).getTime() + rootInfo.duration;

  for (const parsed of parsedMembers) {
    estimatedCosts = addCosts(estimatedCosts, parsed.info.estimatedCosts);
    const memberUpdatedAtMs = new Date(parsed.info.timestamp).getTime() + parsed.info.duration;
    if (!Number.isNaN(memberUpdatedAtMs)) updatedAtMs = Math.max(updatedAtMs, memberUpdatedAtMs);
    for (const [tool, count] of Object.entries(parsed.info.toolsUsed)) toolsUsed[tool] = (toolsUsed[tool] || 0) + count;
    for (const [model, usage] of Object.entries(parsed.modelUsage)) {
      const current = modelUsage[model] || {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        reasoningOutputTokens: 0,
      };
      current.inputTokens += usage.inputTokens;
      current.outputTokens += usage.outputTokens;
      current.cacheReadInputTokens += usage.cacheReadInputTokens;
      current.cacheCreationInputTokens += usage.cacheCreationInputTokens;
      current.reasoningOutputTokens = (current.reasoningOutputTokens || 0) + (usage.reasoningOutputTokens || 0);
      modelUsage[model] = current;
    }
  }

  const info: SessionInfo = {
    ...rootInfo,
    sourceFilePath: logical.root.filePath,
    sourceFilePaths: logical.members.map(member => member.fileInfo.filePath),
    duration: Math.max(0, updatedAtMs - new Date(rootInfo.timestamp).getTime()),
    messageCount: parsedMembers.reduce((sum, parsed) => sum + parsed.info.messageCount, 0),
    userMessageCount: parsedMembers.reduce((sum, parsed) => sum + parsed.info.userMessageCount, 0),
    assistantMessageCount: parsedMembers.reduce((sum, parsed) => sum + parsed.info.assistantMessageCount, 0),
    toolCallCount: parsedMembers.reduce((sum, parsed) => sum + parsed.info.toolCallCount, 0),
    totalInputTokens: parsedMembers.reduce((sum, parsed) => sum + parsed.info.totalInputTokens, 0),
    totalOutputTokens: parsedMembers.reduce((sum, parsed) => sum + parsed.info.totalOutputTokens, 0),
    totalCacheReadTokens: parsedMembers.reduce((sum, parsed) => sum + parsed.info.totalCacheReadTokens, 0),
    totalCacheWriteTokens: parsedMembers.reduce((sum, parsed) => sum + parsed.info.totalCacheWriteTokens, 0),
    estimatedCost: estimatedCosts[DEFAULT_COST_MODE],
    estimatedCosts,
    models: Array.from(new Set(parsedMembers.flatMap(parsed => parsed.info.models))),
    toolsUsed,
    compaction: {
      compactions: parsedMembers.reduce((sum, parsed) => sum + parsed.info.compaction.compactions, 0),
      microcompactions: parsedMembers.reduce((sum, parsed) => sum + parsed.info.compaction.microcompactions, 0),
      totalTokensSaved: parsedMembers.reduce((sum, parsed) => sum + parsed.info.compaction.totalTokensSaved, 0),
      compactionTimestamps: parsedMembers.flatMap(parsed => parsed.info.compaction.compactionTimestamps).sort(),
    },
  };

  return {
    info,
    detail: { ...info, messages },
    searchableText: parsedMembers.map(parsed => parsed.searchableText).filter(Boolean).join('\n'),
    reasoningOutputTokens: parsedMembers.reduce((sum, parsed) => sum + parsed.reasoningOutputTokens, 0),
    modelUsage,
  };
}

async function parseDiscoveredSession(logical: CodexLogicalSessionInfo): Promise<CodexParsedSession> {
  const cached = parsedCache.get({ provider: 'codex', filePath: logical.root.filePath, signature: logical.sourceSignature, scope: 'detail' });
  if (cached) return cached;

  const parsedMembers = await Promise.all(logical.members.map(async (member) => {
    if (!member.isSubagent) return parseCodexSessionFile(member.fileInfo.filePath, member.fileInfo);
    const records = scopeCodexSubagentRecords(await readCodexRecords(member.fileInfo.filePath), member);
    return parseCodexSessionFile(member.fileInfo.filePath, member.fileInfo, {
      records,
      subagent: subagentDisplay(member),
    });
  }));
  const parsed = mergeParsedSessions(logical, parsedMembers);
  parsedCache.set({ provider: 'codex', filePath: logical.root.filePath, signature: logical.sourceSignature, scope: 'detail' }, parsed);
  return parsed;
}

async function getParsedSessions(): Promise<CodexParsedSession[]> {
  const sessions = await discoverCodexLogicalSessions();
  const parsed = await Promise.all(sessions.map(parseDiscoveredSession));
  return parsed.sort((left, right) => right.info.timestamp.localeCompare(left.info.timestamp));
}

function routeNativeId(id: string): string {
  return parseRouteId(id).nativeId;
}

function getProjectNativeId(cwd: string, fallbackFilePath: string): string {
  const source = cwd || fallbackFilePath;
  return source.replace(/^[A-Za-z]:/, match => match[0]).replace(/[\\/:]+/g, '-').replace(/^-+|-+$/g, '') || 'codex';
}

function buildLightweightSessionInfo(logical: CodexLogicalSessionInfo): SessionInfo {
  const fileInfo = logical.root;
  const cached = infoCache.get({ provider: 'codex', filePath: fileInfo.filePath, signature: logical.sourceSignature, scope: 'list' });
  if (cached) return cached;

  const nativeProjectId = getProjectNativeId(fileInfo.cwd, fileInfo.filePath);
  const projectRouteId = qualifyProjectId('codex', nativeProjectId);
  const routeId = makeRouteId('codex', fileInfo.nativeId);
  const updatedAt = logical.members.reduce((latest, member) => (
    member.fileInfo.updatedAt > latest ? member.fileInfo.updatedAt : latest
  ), fileInfo.updatedAt);
  const timestamp = fileInfo.createdAt || updatedAt || new Date(0).toISOString();
  const duration = fileInfo.createdAt && updatedAt
    ? Math.max(0, new Date(updatedAt).getTime() - new Date(fileInfo.createdAt).getTime())
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
    sourceFilePaths: logical.members.map(member => member.fileInfo.filePath),
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
  infoCache.set({ provider: 'codex', filePath: fileInfo.filePath, signature: logical.sourceSignature, scope: 'list' }, info);
  return info;
}

async function getLightweightSessions(): Promise<SessionInfo[]> {
  const sessions = await discoverCodexLogicalSessions();
  return sessions
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
  const logical = (await discoverCodexLogicalSessions()).find(session => (
    session.root.nativeId === nativeId || makeRouteId('codex', session.root.nativeId) === routeOrNativeId
  ));
  if (!logical) return null;
  return (await parseDiscoveredSession(logical)).detail;
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
  return (await discoverCodexLogicalSessions()).map(logical => ({
    provider: 'codex',
    parserVersion: CODEX_SESSION_SUMMARY_PARSER_VERSION,
    sourceFilePath: logical.root.filePath,
    sourceSignature: logical.sourceSignature,
    nativeProjectId: getProjectNativeId(logical.root.cwd, logical.root.filePath),
    projectName: logical.root.cwd ? logical.root.cwd.split(/[\\/]/).filter(Boolean).at(-1) || 'codex' : 'codex',
    metadata: logical,
  }));
}

function getSourceLogicalInfo(source: SessionSummarySource): CodexLogicalSessionInfo {
  const metadata = source.metadata as CodexLogicalSessionInfo | undefined;
  if (metadata?.root.filePath === source.sourceFilePath) return metadata;
  const fileInfo: CodexSessionFileInfo = {
    filePath: source.sourceFilePath,
    nativeId: source.sourceFilePath,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(source.sourceSignature.mtimeMs || 0).toISOString(),
    cwd: '',
    signature: `${source.sourceSignature.mtimeMs}:${source.sourceSignature.size}`,
  };
  return {
    root: fileInfo,
    members: [{ fileInfo, depth: 0, isSubagent: false }],
    sourceSignature: source.sourceSignature,
    signatureKey: fileInfo.signature,
  };
}

export async function buildSessionSummary(source: SessionSummarySource): Promise<CachedSessionSummary> {
  const logical = getSourceLogicalInfo(source);
  const parsed = await parseDiscoveredSession(logical);
  const summary = parsed.info;
  const updatedAt = new Date(new Date(summary.timestamp).getTime() + summary.duration).toISOString();
  const changeTotals = getSessionChangeTotals(parsed.detail.messages);
  const modelUsage = parsed.modelUsage;
  const summaryMetrics = {
    createdAt: summary.timestamp,
    updatedAt,
    model: summary.model,
    messageCount: summary.messageCount,
    userMessageCount: summary.userMessageCount,
    assistantMessageCount: summary.assistantMessageCount,
    toolCallCount: summary.toolCallCount,
    tokenTotals: {
      input: summary.totalInputTokens,
      output: summary.totalOutputTokens,
      cacheRead: summary.totalCacheReadTokens,
      cacheWrite: summary.totalCacheWriteTokens,
      reasoningOutput: parsed.reasoningOutputTokens,
    },
    modelUsage,
  };
  const nativeProjectId = getProjectNativeId(summary.cwd, logical.root.filePath);
  const projectRouteId = qualifyProjectId('codex', nativeProjectId);
  const routeId = makeRouteId('codex', summary.nativeId || logical.root.nativeId);
  const searchTextPreview = normalizeSearchText([
    parsed.searchableText,
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
    nativeId: summary.nativeId || logical.root.nativeId,
    routeId,
    nativeProjectId,
    projectRouteId,
    projectName: summary.cwd ? summary.cwd.split(/[\\/]/).filter(Boolean).at(-1) || 'codex' : 'codex',
    sourceFilePath: logical.root.filePath,
    sourceFilePaths: logical.members.map(member => member.fileInfo.filePath),
    sourceSignature: source.sourceSignature,
    createdAt: summary.timestamp,
    updatedAt,
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
      input: summary.totalInputTokens,
      output: summary.totalOutputTokens,
      cacheRead: summary.totalCacheReadTokens,
      cacheWrite: summary.totalCacheWriteTokens,
      reasoningOutput: parsed.reasoningOutputTokens,
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
  const logical = getSourceLogicalInfo(source);
  const fileInfo = logical.root;
  const summary = parseCodexSessionSummaryFile(source.sourceFilePath, fileInfo);
  const childSummaries = logical.members.filter(member => (
    member.isSubagent && member.fileInfo.filePath !== logical.root.filePath
  )).map(member => {
    const records = scopeCodexSubagentRecords(readCodexRecordsSync(member.fileInfo.filePath), member);
    return parseCodexRecords(member.fileInfo.filePath, records, member.fileInfo, {
      subagent: subagentDisplay(member),
    });
  });
  const nativeProjectId = getProjectNativeId(summary.cwd, source.sourceFilePath);
  const projectRouteId = qualifyProjectId('codex', nativeProjectId);
  const routeId = makeRouteId('codex', summary.nativeId);
  const modelUsage: CachedSessionSummary['modelUsage'] = {
    [summary.model || 'unknown']: {
      inputTokens: summary.tokenUsage.input_tokens,
      outputTokens: summary.tokenUsage.output_tokens,
      cacheReadInputTokens: summary.tokenUsage.cache_read_input_tokens,
      cacheCreationInputTokens: summary.tokenUsage.cache_creation_input_tokens,
      reasoningOutputTokens: summary.reasoningOutputTokens,
    },
  };
  const toolsUsed = { ...summary.toolsUsed };
  for (const child of childSummaries) {
    for (const [model, usage] of Object.entries(child.modelUsage)) {
      const current = modelUsage[model] || {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        reasoningOutputTokens: 0,
      };
      current.inputTokens += usage.inputTokens;
      current.outputTokens += usage.outputTokens;
      current.cacheReadInputTokens += usage.cacheReadInputTokens;
      current.cacheCreationInputTokens += usage.cacheCreationInputTokens;
      current.reasoningOutputTokens = (current.reasoningOutputTokens || 0) + (usage.reasoningOutputTokens || 0);
      modelUsage[model] = current;
    }
    for (const [tool, count] of Object.entries(child.info.toolsUsed)) toolsUsed[tool] = (toolsUsed[tool] || 0) + count;
  }
  const childInfo = childSummaries.map(child => child.info);
  const updatedAt = logical.members.reduce((latest, member) => (
    member.fileInfo.updatedAt > latest ? member.fileInfo.updatedAt : latest
  ), summary.updatedAt);
  const models = Array.from(new Set([
    ...summary.models,
    ...childInfo.flatMap(info => info.models),
  ]));
  const compactionTimestamps = [
    ...summary.compaction.compactionTimestamps,
    ...childInfo.flatMap(info => info.compaction.compactionTimestamps),
  ].sort();

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
    sourceFilePaths: logical.members.map(member => member.fileInfo.filePath),
    sourceSignature: source.sourceSignature,
    createdAt: summary.createdAt,
    updatedAt,
    title: summary.title,
    cwd: summary.cwd,
    gitBranch: summary.gitBranch,
    version: summary.version,
    model: summary.model,
    models,
    messageCount: summary.messageCount + childInfo.reduce((sum, info) => sum + info.messageCount, 0),
    userMessageCount: summary.userMessageCount + childInfo.reduce((sum, info) => sum + info.userMessageCount, 0),
    assistantMessageCount: summary.assistantMessageCount + childInfo.reduce((sum, info) => sum + info.assistantMessageCount, 0),
    toolCallCount: summary.toolCallCount + childInfo.reduce((sum, info) => sum + info.toolCallCount, 0),
    tokenTotals: {
      input: summary.tokenUsage.input_tokens + childInfo.reduce((sum, info) => sum + info.totalInputTokens, 0),
      output: summary.tokenUsage.output_tokens + childInfo.reduce((sum, info) => sum + info.totalOutputTokens, 0),
      cacheRead: summary.tokenUsage.cache_read_input_tokens + childInfo.reduce((sum, info) => sum + info.totalCacheReadTokens, 0),
      cacheWrite: summary.tokenUsage.cache_creation_input_tokens + childInfo.reduce((sum, info) => sum + info.totalCacheWriteTokens, 0),
      reasoningOutput: summary.reasoningOutputTokens + childSummaries.reduce((sum, child) => sum + child.reasoningOutputTokens, 0),
    },
    modelUsage,
    changeTotals: zeroChangeTotals(),
    toolsUsed,
    compaction: {
      compactions: summary.compaction.compactions + childInfo.reduce((sum, info) => sum + info.compaction.compactions, 0),
      microcompactions: summary.compaction.microcompactions + childInfo.reduce((sum, info) => sum + info.compaction.microcompactions, 0),
      totalTokensSaved: summary.compaction.totalTokensSaved + childInfo.reduce((sum, info) => sum + info.compaction.totalTokensSaved, 0),
      compactionTimestamps,
    },
    searchTextPreview: normalizeSearchText([
      summary.searchTextPreview,
      ...childSummaries.map(child => child.searchableText),
      summary.title,
      summary.cwd,
      summary.gitBranch,
      summary.version,
      summary.model,
      ...summary.models,
      ...Object.keys(summary.toolsUsed || {}),
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
