import fs from 'fs';
import path from 'path';
import { calculateCostAllModes, getModelDisplayName, DEFAULT_COST_MODE } from '@/config/pricing';
import type {
  StatsCache,
  HistoryEntry,
  ProjectInfo,
  SessionInfo,
  SessionDetail,
  SessionMessage,
  SessionMessageBlockDisplay,
  SessionMessageDisplay,
  SessionPromptTokenBreakdown,
  SessionToolCallDisplay,
  DashboardStats,
  DailyActivity,
  DailyModelTokens,
  ModelUsage,
  TokenUsage,
  CostEstimates,
} from './types';
import { addCosts, zeroCosts } from './cost-utils';
import { zeroChangeTotals } from './change-utils';
import { getClaudeDir, getProjectsDir, getSessionAggregateFilePaths, getTopLevelSessionFiles, forEachJsonlLine } from './io';
import { getSessionChangeTotals } from '@/lib/session-diff';
import { makeRouteId, qualifyProjectId } from '@/lib/agent-data/route-id';
import {
  SESSION_SUMMARY_CACHE_VERSION,
  normalizeSearchText,
  type CachedModelUsage,
  type CachedSessionSummary,
  type SessionSummarySource,
  type SessionSourceSignature,
} from '@/lib/agent-data/session-summary';
import { getAssistantTurnCacheWriteTokens, recordAssistantTurn, type AssistantTurnAggregate } from './assistant-turns';
import { isRecord } from './record-utils';
import {
  addPromptTokenTotals,
  buildPromptBreakdown,
  getAssistantPromptContribution,
  getAttachmentPromptContribution,
  getUserPromptContribution,
  hasPromptTokens,
  zeroPromptTokenTotals,
} from './prompt-metrics';
import { buildEventBlock, buildThinkingBlock, buildToolCallDisplay, buildToolResultBlock } from './tool-parser';
import { computeLocalHourCounts, computeSupplementalStats, resetStatsAggregatorCache } from './stats-aggregator';

interface SessionFileCacheEntry {
  signature: string;
  value: ParsedSessionInfo;
}

const sessionInfoCache = new Map<string, SessionFileCacheEntry>();
export const CLAUDE_SESSION_SUMMARY_PARSER_VERSION = 'claude-summary-v1';

type ParsedSessionInfo = SessionInfo & {
  modelUsage?: Record<string, ModelUsage & { estimatedCost: number; estimatedCosts: CostEstimates }>;
};

function getFileSignature(filePath: string): string {
  try {
    const stat = fs.statSync(filePath);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return 'missing';
  }
}

function getSessionSignature(filePath: string): string {
  return getSessionAggregateFilePaths(filePath)
    .map(aggregatePath => `${aggregatePath}:${getFileSignature(aggregatePath)}`)
    .join('|');
}

function getSessionSourceSignature(filePath: string): SessionSourceSignature {
  let size = 0;
  let mtimeMs = 0;
  for (const aggregatePath of getSessionAggregateFilePaths(filePath)) {
    try {
      const stat = fs.statSync(aggregatePath);
      size += stat.size;
      mtimeMs = Math.max(mtimeMs, stat.mtimeMs);
    } catch {
      // Missing aggregate files simply stop contributing to the summary signature.
    }
  }
  return { size, mtimeMs };
}

export function getStatsCache(): StatsCache | null {
  const statsPath = path.join(getClaudeDir(), 'stats-cache.json');
  if (!fs.existsSync(statsPath)) return null;
  return JSON.parse(fs.readFileSync(statsPath, 'utf-8'));
}

export function getHistory(): HistoryEntry[] {
  const historyPath = path.join(getClaudeDir(), 'history.jsonl');
  if (!fs.existsSync(historyPath)) return [];
  const lines = fs.readFileSync(historyPath, 'utf-8').split('\n').filter(Boolean);
  return lines.map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean) as HistoryEntry[];
}

function projectIdToName(id: string): string {
  const decoded = id.replace(/^-/, '/').replace(/-/g, '/');
  const parts = decoded.split('/');
  return parts[parts.length - 1] || id;
}

function projectIdToFullPath(id: string): string {
  return id.replace(/^-/, '/').replace(/-/g, '/');
}

function extractCwdFromSession(filePath: string): string | null {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(8192); // Read first 8KB, enough for first few lines
    const bytesRead = fs.readSync(fd, buffer, 0, 8192, 0);
    fs.closeSync(fd);
    const text = buffer.toString('utf-8', 0, bytesRead);
    const lines = text.split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const msg = JSON.parse(line);
        if (msg.cwd) return msg.cwd;
      } catch { /* skip partial line */ }
    }
  } catch { /* skip */ }
  return null;
}

function getProjectNameFromDir(projectPath: string, projectId: string): { name: string; fullPath: string } {
  const jsonlFiles = fs.readdirSync(projectPath).filter(f => f.endsWith('.jsonl'));
  if (jsonlFiles.length > 0) {
    const cwd = extractCwdFromSession(path.join(projectPath, jsonlFiles[0]));
    if (cwd) return { name: path.basename(cwd), fullPath: cwd };
  }
  return { name: projectIdToName(projectId), fullPath: projectIdToFullPath(projectId) };
}

export async function getProjects(): Promise<ProjectInfo[]> {
  if (!fs.existsSync(getProjectsDir())) return [];
  const entries = fs.readdirSync(getProjectsDir());
  const projects: ProjectInfo[] = [];

  for (const entry of entries) {
    const projectPath = path.join(getProjectsDir(), entry);
    if (!fs.statSync(projectPath).isDirectory()) continue;

    const jsonlFiles = getTopLevelSessionFiles(projectPath);
    if (jsonlFiles.length === 0) continue;

    let totalMessages = 0;
    let totalTokens = 0;
    let estimatedCosts = zeroCosts();
    let lastActive = '';
    const modelsSet = new Set<string>();

    for (const file of jsonlFiles) {
      const sessionFilePath = path.join(projectPath, file);
      const session = await parseSessionFile(sessionFilePath, entry, getProjectNameFromDir(projectPath, entry).name);

      for (const aggregateFilePath of getSessionAggregateFilePaths(sessionFilePath)) {
        const mtime = fs.statSync(aggregateFilePath).mtime.toISOString();
        if (!lastActive || mtime > lastActive) lastActive = mtime;
      }

      totalMessages += session.messageCount;
      totalTokens += session.totalInputTokens + session.totalOutputTokens + session.totalCacheReadTokens + session.totalCacheWriteTokens;
      estimatedCosts = addCosts(estimatedCosts, session.estimatedCosts || zeroCosts());
      session.models.forEach(model => modelsSet.add(model));
    }

    const firstSessionPath = path.join(projectPath, jsonlFiles[0]);
    const cwd = extractCwdFromSession(firstSessionPath);

    projects.push({
      id: entry,
      name: cwd ? path.basename(cwd) : projectIdToName(entry),
      path: cwd || projectIdToFullPath(entry),
      sessionCount: jsonlFiles.length,
      totalMessages,
      totalTokens,
      estimatedCost: estimatedCosts[DEFAULT_COST_MODE],
      estimatedCosts,
      lastActive,
      models: Array.from(modelsSet),
    });
  }

  return projects.sort((a, b) => b.lastActive.localeCompare(a.lastActive));
}

export async function getProjectSessions(projectId: string): Promise<SessionInfo[]> {
  const projectPath = path.join(getProjectsDir(), projectId);
  if (!fs.existsSync(projectPath)) return [];

  const { name: projectName } = getProjectNameFromDir(projectPath, projectId);
  const jsonlFiles = getTopLevelSessionFiles(projectPath);
  const sessions: SessionInfo[] = [];
  for (const file of jsonlFiles) {
    sessions.push(await parseSessionFile(path.join(projectPath, file), projectId, projectName));
  }
  return sessions.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

export async function getSessions(limit = 50, offset = 0): Promise<SessionInfo[]> {
  const allSessions: SessionInfo[] = [];

  if (!fs.existsSync(getProjectsDir())) return [];
  const projectEntries = fs.readdirSync(getProjectsDir());

  for (const entry of projectEntries) {
    const projectPath = path.join(getProjectsDir(), entry);
    if (!fs.statSync(projectPath).isDirectory()) continue;

    const { name: projectName } = getProjectNameFromDir(projectPath, entry);
    const jsonlFiles = getTopLevelSessionFiles(projectPath);
    for (const file of jsonlFiles) {
      allSessions.push(await parseSessionFile(path.join(projectPath, file), entry, projectName));
    }
  }

  allSessions.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return allSessions.slice(offset, offset + limit);
}

class SessionParser {
  private firstTimestamp = '';
  private lastTimestamp = '';
  private userMessageCount = 0;
  private assistantMessageCount = 0;
  private toolCallCount = 0;
  private totalInputTokens = 0;
  private totalOutputTokens = 0;
  private totalCacheReadTokens = 0;
  private totalCacheWriteTokens = 0;
  private estimatedCosts = zeroCosts();
  private gitBranch = '';
  private cwd = '';
  private version = '';
  private modelsSet = new Set<string>();
  private toolsUsed: Record<string, number> = {};
  private modelUsage: Record<string, ModelUsage & { estimatedCost: number; estimatedCosts: CostEstimates }> = {};
  private compactions = 0;
  private microcompactions = 0;
  private totalTokensSaved = 0;
  private compactionTimestamps: string[] = [];
  private assistantTurns = new Map<string, AssistantTurnAggregate>();

  constructor(
    private readonly sessionId: string,
    private readonly projectId: string,
    private readonly projectName: string,
  ) {}

  processTopLevelLine(filePath: string, msg: SessionMessage): void {
    this.updateCommonMetadata(msg);
    this.updateCompactionStats(msg);
    this.updateUserCounts(msg);

    if (msg.type === 'assistant') {
      recordAssistantTurn(this.assistantTurns, filePath, msg, true);
    }
  }

  processAggregateLine(filePath: string, msg: SessionMessage): void {
    if (msg.timestamp && msg.timestamp > this.lastTimestamp) this.lastTimestamp = msg.timestamp;
    recordAssistantTurn(this.assistantTurns, filePath, msg, false);
  }

  getResult(): ParsedSessionInfo {
    this.finalizeAssistantTurns();
    const duration = this.firstTimestamp && this.lastTimestamp
      ? new Date(this.lastTimestamp).getTime() - new Date(this.firstTimestamp).getTime()
      : 0;
    const models = Array.from(this.modelsSet);

    return {
      id: this.sessionId,
      projectId: this.projectId,
      projectName: this.projectName,
      timestamp: this.firstTimestamp || new Date().toISOString(),
      duration,
      messageCount: this.userMessageCount + this.assistantMessageCount,
      userMessageCount: this.userMessageCount,
      assistantMessageCount: this.assistantMessageCount,
      toolCallCount: this.toolCallCount,
      totalInputTokens: this.totalInputTokens,
      totalOutputTokens: this.totalOutputTokens,
      totalCacheReadTokens: this.totalCacheReadTokens,
      totalCacheWriteTokens: this.totalCacheWriteTokens,
      estimatedCost: this.estimatedCosts[DEFAULT_COST_MODE],
      estimatedCosts: this.estimatedCosts,
      model: models[0] || 'unknown',
      models: models.map(getModelDisplayName),
      gitBranch: this.gitBranch,
      cwd: this.cwd,
      version: this.version,
      toolsUsed: this.toolsUsed,
      compaction: {
        compactions: this.compactions,
        microcompactions: this.microcompactions,
        totalTokensSaved: this.totalTokensSaved,
        compactionTimestamps: this.compactionTimestamps,
      },
      modelUsage: this.modelUsage,
    };
  }

  private updateCommonMetadata(msg: SessionMessage): void {
    if (msg.timestamp) {
      if (!this.firstTimestamp) this.firstTimestamp = msg.timestamp;
      this.lastTimestamp = msg.timestamp;
    }
    if (msg.gitBranch && !this.gitBranch) this.gitBranch = msg.gitBranch;
    if (msg.cwd && !this.cwd) this.cwd = msg.cwd;
    if (msg.version && !this.version) this.version = msg.version;
  }

  private updateCompactionStats(msg: SessionMessage): void {
    if (msg.compactMetadata) {
      this.compactions++;
      if (msg.timestamp) this.compactionTimestamps.push(msg.timestamp);
    }
    if (msg.microcompactMetadata) {
      this.microcompactions++;
      this.totalTokensSaved += msg.microcompactMetadata.tokensSaved || 0;
      if (msg.timestamp) this.compactionTimestamps.push(msg.timestamp);
    }
  }

  private updateUserCounts(msg: SessionMessage): void {
    if (msg.type === 'user' && msg.message?.role === 'user') {
      this.userMessageCount++;
    }
  }

  private finalizeAssistantTurns(): void {
    if (this.assistantMessageCount > 0 || this.totalInputTokens > 0 || this.toolCallCount > 0) return;

    for (const assistantTurn of this.assistantTurns.values()) {
      if (assistantTurn.topLevel) {
        this.assistantMessageCount++;
        for (const toolName of assistantTurn.toolCalls.values()) {
          this.toolCallCount++;
          this.toolsUsed[toolName] = (this.toolsUsed[toolName] || 0) + 1;
        }
      }

      if (assistantTurn.model) this.modelsSet.add(assistantTurn.model);
      if (!assistantTurn.usage) continue;

      const cacheWriteTokens = getAssistantTurnCacheWriteTokens(assistantTurn);
      const inputTokens = assistantTurn.usage.input_tokens || 0;
      const outputTokens = assistantTurn.usage.output_tokens || 0;
      const cacheReadTokens = assistantTurn.usage.cache_read_input_tokens || 0;
      this.totalInputTokens += inputTokens;
      this.totalOutputTokens += outputTokens;
      this.totalCacheReadTokens += cacheReadTokens;
      this.totalCacheWriteTokens += cacheWriteTokens;
      const model = assistantTurn.model || 'unknown';
      const costs = calculateCostAllModes(
        model,
        inputTokens,
        outputTokens,
        cacheWriteTokens,
        cacheReadTokens,
      );
      const existing = this.modelUsage[model] || {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        reasoningOutputTokens: 0,
        costUSD: 0,
        contextWindow: 0,
        maxOutputTokens: 0,
        webSearchRequests: 0,
        estimatedCost: 0,
        estimatedCosts: zeroCosts(),
      };
      existing.inputTokens += inputTokens;
      existing.outputTokens += outputTokens;
      existing.cacheReadInputTokens += cacheReadTokens;
      existing.cacheCreationInputTokens += cacheWriteTokens;
      existing.estimatedCosts = addCosts(existing.estimatedCosts, costs);
      existing.estimatedCost = existing.estimatedCosts[DEFAULT_COST_MODE];
      this.modelUsage[model] = existing;
      this.estimatedCosts = addCosts(this.estimatedCosts, costs);
    }
  }
}

function buildPromptBreakdownOrUndefined(
  totals: ReturnType<typeof zeroPromptTokenTotals>,
  usage: TokenUsage | undefined,
  sessionId: string,
  timestamp: string | undefined,
): SessionPromptTokenBreakdown | undefined {
  try {
    return buildPromptBreakdown(totals, usage, sessionId, timestamp);
  } catch {
    return undefined;
  }
}

async function parseSessionFileUncached(filePath: string, projectId: string, projectName: string): Promise<ParsedSessionInfo> {
  const sessionId = path.basename(filePath, '.jsonl');
  const parser = new SessionParser(sessionId, projectId, projectName);
  const aggregateFilePaths = getSessionAggregateFilePaths(filePath);

  await forEachJsonlLine(filePath, (msg) => {
    parser.processTopLevelLine(filePath, msg);
  });

  for (const aggregateFilePath of aggregateFilePaths.slice(1)) {
    await forEachJsonlLine(aggregateFilePath, (msg) => {
      parser.processAggregateLine(aggregateFilePath, msg);
    });
  }

  return parser.getResult();
}

async function parseSessionFile(filePath: string, projectId: string, projectName: string): Promise<ParsedSessionInfo> {
  const signature = getSessionSignature(filePath);
  const cacheKey = `${projectId}:${filePath}`;
  const cached = sessionInfoCache.get(cacheKey);
  if (cached?.signature === signature) return cached.value;

  const value = await parseSessionFileUncached(filePath, projectId, projectName);
  sessionInfoCache.set(cacheKey, { signature, value });
  return value;
}

export async function getSessionDetailFromFile(filePath: string, projectId: string, projectName: string): Promise<SessionDetail> {
  const sessionInfo = await parseSessionFile(filePath, projectId, projectName);
  const sessionId = sessionInfo.id;
  const messages: SessionMessageDisplay[] = [];
  const contextTotals = zeroPromptTokenTotals();
  let pendingAssistantTotals = zeroPromptTokenTotals();

  const flushPendingAssistantTotals = () => {
    if (!hasPromptTokens(pendingAssistantTotals)) return;
    addPromptTokenTotals(contextTotals, pendingAssistantTotals);
    pendingAssistantTotals = zeroPromptTokenTotals();
  };

  await forEachJsonlLine(filePath, (msg) => {
    try {
      if (msg.type !== 'assistant') flushPendingAssistantTotals();

      if (msg.type === 'user' && msg.message?.role === 'user') {
        const content = msg.message.content;
        const textParts: string[] = [];
        const blocks: SessionMessageBlockDisplay[] = [];

        // Detect command XML patterns
        const rawText = typeof content === 'string' ? content : '';
        const commandNameMatch = rawText.match(/<command-name>([\s\S]*?)<\/command-name>/);
        const commandStdoutMatch = rawText.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/);
        const commandCaveatMatch = rawText.match(/<local-command-caveat>([\s\S]*?)<\/local-command-caveat>/);

        if (commandNameMatch || commandStdoutMatch || commandCaveatMatch) {
          // This is a command message
          let commandContent = '';
          if (commandCaveatMatch) {
            commandContent = commandCaveatMatch[1].trim();
          } else if (commandNameMatch) {
            const name = commandNameMatch[1].trim();
            const argsMatch = rawText.match(/<command-args>([\s\S]*?)<\/command-args>/);
            const args = argsMatch ? argsMatch[1].trim() : '';
            commandContent = args ? `${name} ${args}` : name;
          } else if (commandStdoutMatch) {
            // Strip ANSI escape codes
            commandContent = commandStdoutMatch[1].replace(/\x1b\[[0-9;]*m/g, '').trim();
          }
          messages.push({
            role: 'command',
            content: commandContent,
            timestamp: msg.timestamp,
            isMeta: msg.isMeta || Boolean(commandCaveatMatch),
          });
          addPromptTokenTotals(contextTotals, getUserPromptContribution(msg));
          return;
        }

        if (typeof content === 'string') {
          textParts.push(content);
        } else if (Array.isArray(content)) {
          let structuredResultUsed = false;

          for (const contentBlock of content) {
            if (!isRecord(contentBlock)) continue;

            if (contentBlock.type === 'text' && typeof contentBlock.text === 'string') {
              textParts.push(contentBlock.text);
              continue;
            }

            if (contentBlock.type === 'tool_result') {
              const structuredToolUseResult: Record<string, unknown> | undefined =
                !structuredResultUsed && isRecord(msg.toolUseResult)
                ? msg.toolUseResult
                : undefined;

              blocks.push(
                buildToolResultBlock(
                  contentBlock,
                  structuredToolUseResult,
                  typeof msg.sourceToolAssistantUUID === 'string' ? msg.sourceToolAssistantUUID : undefined,
                ),
              );
              structuredResultUsed = structuredResultUsed || Boolean(structuredToolUseResult);
            }
          }
        }

        if (blocks.length === 0 && isRecord(msg.toolUseResult)) {
          blocks.push(
            buildToolResultBlock(
              undefined,
              msg.toolUseResult,
              typeof msg.sourceToolAssistantUUID === 'string' ? msg.sourceToolAssistantUUID : undefined,
            ),
          );
        }

        const text = textParts.join('\n').trim();
        if (text || blocks.length > 0) {
          const isToolResultOnly = !text && blocks.length > 0;
          messages.push({
            role: isToolResultOnly ? 'tool-result' : 'user',
            content: text,
            timestamp: msg.timestamp,
            blocks: blocks.length > 0 ? blocks : undefined,
            isMeta: msg.isMeta,
          });
        }
        addPromptTokenTotals(contextTotals, getUserPromptContribution(msg));
        return;
      }

      if (msg.type === 'assistant' && msg.message?.content) {
        const promptBreakdown = buildPromptBreakdownOrUndefined(
          contextTotals,
          msg.message.usage as TokenUsage | undefined,
          sessionId,
          msg.timestamp,
        );
        const content = msg.message.content;
        const toolCalls: SessionToolCallDisplay[] = [];
        const blocks: SessionMessageBlockDisplay[] = [];
        let text = '';

        if (typeof content === 'string') {
          text = content;
        } else if (Array.isArray(content)) {
          for (const c of content) {
            if (isRecord(c)) {
              if ('type' in c && c.type === 'text' && 'text' in c) {
                text += (c.text as string) + '\n';
                continue;
              }

              if ('type' in c && c.type === 'thinking') {
                const thinkingBlock = buildThinkingBlock(c);
                if (thinkingBlock) blocks.push(thinkingBlock);
                continue;
              }

              if ('type' in c && c.type === 'tool_use' && 'name' in c) {
                toolCalls.push(
                  buildToolCallDisplay(
                    c.name as string,
                    (c.id as string) || '',
                    'input' in c ? c.input : undefined,
                  ),
                );
              }
            }
          }
        }

        if (text.trim() || toolCalls.length > 0 || blocks.length > 0) {
          const isToolUseOnly = !text.trim() && toolCalls.length > 0;
          messages.push({
            role: isToolUseOnly ? 'tool-use' : 'assistant',
            content: text.trim(),
            timestamp: msg.timestamp,
            messageId: msg.message.id,
            model: msg.message.model,
            usage: msg.message.usage as TokenUsage | undefined,
            promptBreakdown,
            stopReason: msg.message.stop_reason,
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
            blocks: blocks.length > 0 ? blocks : undefined,
            isMeta: msg.isMeta,
          });
        }
        addPromptTokenTotals(pendingAssistantTotals, getAssistantPromptContribution(msg));
        return;
      }

      const eventBlock = buildEventBlock(msg);
      if (eventBlock) {
        messages.push({
          role: 'system',
          content: eventBlock.summary,
          timestamp: msg.timestamp,
          blocks: [eventBlock],
          isMeta: msg.isMeta,
        });
      }
      addPromptTokenTotals(contextTotals, getAttachmentPromptContribution(msg));
    } catch {
      // skip malformed or internally inconsistent messages
    }
  });

  return { ...sessionInfo, messages };
}

export async function getSessionDetail(sessionId: string): Promise<SessionDetail | null> {
  if (!fs.existsSync(getProjectsDir())) return null;
  const projectEntries = fs.readdirSync(getProjectsDir());

  for (const entry of projectEntries) {
    const projectPath = path.join(getProjectsDir(), entry);
    if (!fs.statSync(projectPath).isDirectory()) continue;

    const filePath = path.join(projectPath, `${sessionId}.jsonl`);
    if (!fs.existsSync(filePath)) continue;

    const { name: projectName } = getProjectNameFromDir(projectPath, entry);
    return getSessionDetailFromFile(filePath, entry, projectName);
  }

  return null;
}

export async function searchSessions(query: string, limit = 50): Promise<SessionInfo[]> {
  if (!query.trim()) return getSessions(limit, 0);

  const lowerQuery = query.toLowerCase();
  const matchingSessions: SessionInfo[] = [];

  if (!fs.existsSync(getProjectsDir())) return [];
  const projectEntries = fs.readdirSync(getProjectsDir());

  for (const entry of projectEntries) {
    const projectPath = path.join(getProjectsDir(), entry);
    if (!fs.statSync(projectPath).isDirectory()) continue;

    const jsonlFiles = fs.readdirSync(projectPath).filter(f => f.endsWith('.jsonl'));
    for (const file of jsonlFiles) {
      const filePath = path.join(projectPath, file);

      let hasMatch = false;
      await forEachJsonlLine(filePath, (msg) => {
        if (hasMatch) return;
        if (msg.type === 'user' && msg.message?.role === 'user') {
          const content = msg.message.content;
          if (typeof content === 'string' && content.toLowerCase().includes(lowerQuery)) {
            hasMatch = true;
            return;
          }
          if (Array.isArray(content)) {
            for (const c of content) {
              if (c && typeof c === 'object' && 'type' in c && c.type === 'text' && 'text' in c) {
                if ((c.text as string).toLowerCase().includes(lowerQuery)) {
                  hasMatch = true;
                  return;
                }
              }
            }
          }
        }
        if (msg.type === 'assistant' && msg.message?.content) {
          const content = msg.message.content;
          if (Array.isArray(content)) {
            for (const c of content) {
              if (c && typeof c === 'object' && 'type' in c && c.type === 'text' && 'text' in c) {
                if ((c.text as string).toLowerCase().includes(lowerQuery)) {
                  hasMatch = true;
                  return;
                }
              }
            }
          }
        }
      });

      if (hasMatch) {
        const { name: projectName } = getProjectNameFromDir(projectPath, entry);
        matchingSessions.push(await parseSessionFile(filePath, entry, projectName));
      }
    }
  }

  matchingSessions.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return matchingSessions.slice(0, limit);
}

function getMessageContentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((item) => {
      if (!isRecord(item)) return '';
      if (typeof item.text === 'string') return item.text;
      if (typeof item.content === 'string') return item.content;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

async function collectClaudeSearchTextPreview(filePath: string, info: SessionInfo): Promise<string> {
  const parts = [
    info.title,
    info.projectName,
    info.cwd,
    info.gitBranch,
    info.version,
    info.model,
    ...info.models,
    ...Object.keys(info.toolsUsed || {}),
  ];
  let length = parts.join('\n').length;
  const maxLength = 8 * 1024;

  await forEachJsonlLine(filePath, (msg) => {
    if (length >= maxLength) return;
    if (msg.type !== 'user' && msg.type !== 'assistant') return;
    const text = getMessageContentText(msg.message?.content);
    if (!text) return;
    parts.push(text);
    length += text.length;
  });

  return normalizeSearchText(parts);
}

function getSummaryUpdatedAt(info: SessionInfo, source: SessionSummarySource): string {
  const createdAtMs = new Date(info.timestamp).getTime();
  if (!Number.isNaN(createdAtMs) && info.duration > 0) {
    return new Date(createdAtMs + info.duration).toISOString();
  }
  if (source.sourceSignature.mtimeMs > 0) return new Date(source.sourceSignature.mtimeMs).toISOString();
  return info.timestamp;
}

function getCachedModelUsage(info: ParsedSessionInfo): Record<string, CachedModelUsage> {
  const sourceUsage = info.modelUsage || {};
  if (Object.keys(sourceUsage).length > 0) {
    return Object.fromEntries(Object.entries(sourceUsage).map(([model, usage]) => [model, {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadInputTokens: usage.cacheReadInputTokens,
      cacheCreationInputTokens: usage.cacheCreationInputTokens,
      reasoningOutputTokens: usage.reasoningOutputTokens || 0,
      contextWindow: usage.contextWindow || 0,
      maxOutputTokens: usage.maxOutputTokens || 0,
      webSearchRequests: usage.webSearchRequests || 0,
    }]));
  }

  return {
    [info.model || 'unknown']: {
      inputTokens: info.totalInputTokens,
      outputTokens: info.totalOutputTokens,
      cacheReadInputTokens: info.totalCacheReadTokens,
      cacheCreationInputTokens: info.totalCacheWriteTokens,
      reasoningOutputTokens: 0,
    },
  };
}

export async function discoverSessionSummarySources(): Promise<SessionSummarySource[]> {
  if (!fs.existsSync(getProjectsDir())) return [];
  const sources: SessionSummarySource[] = [];

  for (const entry of fs.readdirSync(getProjectsDir())) {
    const projectPath = path.join(getProjectsDir(), entry);
    if (!fs.statSync(projectPath).isDirectory()) continue;
    const { name: projectName } = getProjectNameFromDir(projectPath, entry);
    for (const file of getTopLevelSessionFiles(projectPath)) {
      const filePath = path.join(projectPath, file);
      sources.push({
        provider: 'claude',
        parserVersion: CLAUDE_SESSION_SUMMARY_PARSER_VERSION,
        sourceFilePath: filePath,
        sourceSignature: getSessionSourceSignature(filePath),
        nativeProjectId: entry,
        projectName,
      });
    }
  }

  return sources.sort((left, right) => left.sourceFilePath.localeCompare(right.sourceFilePath));
}

export async function buildSessionSummary(source: SessionSummarySource): Promise<CachedSessionSummary> {
  const projectId = source.nativeProjectId || '';
  const projectName = source.projectName || projectIdToName(projectId);
  const detail = await getSessionDetailFromFile(source.sourceFilePath, projectId, projectName);
  const info = detail;
  const nativeId = info.nativeId || info.id;
  const nativeProjectId = info.nativeProjectId || projectId || info.projectId;
  const routeId = makeRouteId('claude', nativeId);
  const projectRouteId = qualifyProjectId('claude', nativeProjectId);
  const searchTextPreview = await collectClaudeSearchTextPreview(source.sourceFilePath, info);
  const changeTotals = getSessionChangeTotals(detail.messages);

  return {
    cacheVersion: SESSION_SUMMARY_CACHE_VERSION,
    parserVersion: source.parserVersion,
    provider: 'claude',
    nativeId,
    routeId,
    nativeProjectId,
    projectRouteId,
    projectName: info.projectName,
    sourceFilePath: source.sourceFilePath,
    sourceSignature: source.sourceSignature,
    createdAt: info.timestamp,
    updatedAt: getSummaryUpdatedAt(info, source),
    title: info.title,
    cwd: info.cwd,
    gitBranch: info.gitBranch,
    version: info.version,
    model: info.model,
    models: info.models,
    messageCount: info.messageCount,
    userMessageCount: info.userMessageCount,
    assistantMessageCount: info.assistantMessageCount,
    toolCallCount: info.toolCallCount,
    tokenTotals: {
      input: info.totalInputTokens,
      output: info.totalOutputTokens,
      cacheRead: info.totalCacheReadTokens,
      cacheWrite: info.totalCacheWriteTokens,
    },
    modelUsage: getCachedModelUsage(info),
    changeTotals,
    toolsUsed: info.toolsUsed,
    compaction: info.compaction,
    searchTextPreview,
  };
}

export async function getDashboardStats(): Promise<DashboardStats> {
  const stats = getStatsCache();
  const projects = await getProjects();
  const afterDate = stats?.lastComputedDate || '';

  // Compute supplemental stats from JSONL files modified after the cache date
  const supplemental = await computeSupplementalStats(afterDate);
  const localHourCounts = await computeLocalHourCounts();

  // --- Base stats from cache ---
  let totalTokens = 0;
  let totalEstimatedCosts = zeroCosts();
  const modelUsageWithCost: Record<string, DashboardStats['modelUsage'][string]> = {};

  if (stats?.modelUsage) {
    for (const [model, usage] of Object.entries(stats.modelUsage)) {
      const costs = calculateCostAllModes(
        model,
        usage.inputTokens,
        usage.outputTokens,
        usage.cacheCreationInputTokens,
        usage.cacheReadInputTokens
      );
      const tokens = usage.inputTokens + usage.outputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens;
      totalTokens += tokens;
      totalEstimatedCosts = addCosts(totalEstimatedCosts, costs);
      modelUsageWithCost[model] = { ...usage, estimatedCost: costs[DEFAULT_COST_MODE], estimatedCosts: costs };
    }
  }

  // --- Merge supplemental model usage ---
  for (const [model, usage] of Object.entries(supplemental.modelUsage)) {
    const costs = usage.estimatedCosts;
    totalTokens += usage.inputTokens + usage.outputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens;
    totalEstimatedCosts = addCosts(totalEstimatedCosts, costs);
    if (modelUsageWithCost[model]) {
      modelUsageWithCost[model].inputTokens += usage.inputTokens;
      modelUsageWithCost[model].outputTokens += usage.outputTokens;
      modelUsageWithCost[model].cacheReadInputTokens += usage.cacheReadInputTokens;
      modelUsageWithCost[model].cacheCreationInputTokens += usage.cacheCreationInputTokens;
      modelUsageWithCost[model].estimatedCost += costs[DEFAULT_COST_MODE];
      modelUsageWithCost[model].estimatedCosts = addCosts(modelUsageWithCost[model].estimatedCosts, costs);
    } else {
      modelUsageWithCost[model] = {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadInputTokens: usage.cacheReadInputTokens,
        cacheCreationInputTokens: usage.cacheCreationInputTokens,
        costUSD: 0,
        contextWindow: 0,
        maxOutputTokens: 0,
        webSearchRequests: 0,
        estimatedCost: costs[DEFAULT_COST_MODE],
        estimatedCosts: costs,
      };
    }
  }

  // --- Merge dailyActivity ---
  const dailyActivityMap = new Map<string, DailyActivity>();
  for (const d of (stats?.dailyActivity || [])) {
    dailyActivityMap.set(d.date, { ...d });
  }
  for (const d of supplemental.dailyActivity) {
    const existing = dailyActivityMap.get(d.date);
    if (existing) {
      existing.messageCount += d.messageCount;
      existing.sessionCount += d.sessionCount;
      existing.toolCallCount += d.toolCallCount;
    } else {
      dailyActivityMap.set(d.date, { ...d });
    }
  }
  const mergedDailyActivity = Array.from(dailyActivityMap.values()).sort((a, b) => a.date.localeCompare(b.date));

  // --- Merge dailyModelTokens (with costsByModel) ---
  // Build per-model cost-per-token ratios from overall model usage (for cache days without pre-computed costs)
  const modelCostPerToken: Record<string, CostEstimates> = {};
  for (const [model, usage] of Object.entries(modelUsageWithCost)) {
    const totalTok = usage.inputTokens + usage.outputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens;
    if (totalTok > 0 && usage.estimatedCosts) {
      modelCostPerToken[model] = {
        api: usage.estimatedCosts.api / totalTok,
        conservative: usage.estimatedCosts.conservative / totalTok,
        subscription: usage.estimatedCosts.subscription / totalTok,
      };
    }
  }

  const dailyModelTokenMap = new Map<string, Record<string, number>>();
  const dailyModelCostMergeMap = new Map<string, Record<string, CostEstimates>>();

  for (const d of (stats?.dailyModelTokens || [])) {
    dailyModelTokenMap.set(d.date, { ...d.tokensByModel });
    // Estimate costs for cache-sourced days using per-model ratio
    const dayCosts: Record<string, CostEstimates> = {};
    for (const [model, tokens] of Object.entries(d.tokensByModel)) {
      const ratio = modelCostPerToken[model];
      if (ratio) {
        dayCosts[model] = { api: tokens * ratio.api, conservative: tokens * ratio.conservative, subscription: tokens * ratio.subscription };
      }
    }
    dailyModelCostMergeMap.set(d.date, dayCosts);
  }

  for (const d of supplemental.dailyModelTokens) {
    const existingTokens = dailyModelTokenMap.get(d.date);
    const existingCosts = dailyModelCostMergeMap.get(d.date);
    if (existingTokens) {
      for (const [model, tokens] of Object.entries(d.tokensByModel)) {
        existingTokens[model] = (existingTokens[model] || 0) + tokens;
      }
      if (d.costsByModel && existingCosts) {
        for (const [model, costs] of Object.entries(d.costsByModel)) {
          existingCosts[model] = existingCosts[model] ? addCosts(existingCosts[model], costs) : { ...costs };
        }
      }
    } else {
      dailyModelTokenMap.set(d.date, { ...d.tokensByModel });
      dailyModelCostMergeMap.set(d.date, d.costsByModel ? { ...d.costsByModel } : {});
    }
  }

  const mergedDailyModelTokens: DailyModelTokens[] = Array.from(dailyModelTokenMap.entries())
    .map(([date, tokensByModel]) => ({
      date,
      tokensByModel,
      costsByModel: dailyModelCostMergeMap.get(date) || {},
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // --- Merge hourCounts ---
  const hasLocalHourCounts = Object.keys(localHourCounts).length > 0;
  const mergedHourCounts = hasLocalHourCounts
    ? localHourCounts
    : { ...(stats?.hourCounts || {}) };
  if (!hasLocalHourCounts) {
    for (const [hour, count] of Object.entries(supplemental.hourCounts)) {
      mergedHourCounts[hour] = (mergedHourCounts[hour] || 0) + count;
    }
  }

  const recentSessions = await getSessions(10);

  // Use project-level totals for cost/tokens to stay consistent with the Projects page
  const projectTotalCosts: CostEstimates = projects.reduce(
    (sum, p) => addCosts(sum, p.estimatedCosts || { api: p.estimatedCost, conservative: p.estimatedCost, subscription: p.estimatedCost }),
    zeroCosts()
  );
  const projectTotalTokens = projects.reduce((sum, p) => sum + p.totalTokens, 0);

  const finalCosts = projectTotalCosts.api > 0 ? projectTotalCosts : totalEstimatedCosts;

  return {
    totalSessions: (stats?.totalSessions || 0) + supplemental.totalSessions,
    totalMessages: (stats?.totalMessages || 0) + supplemental.totalMessages,
    totalTokens: projectTotalTokens || totalTokens,
    estimatedCost: finalCosts[DEFAULT_COST_MODE],
    estimatedCosts: finalCosts,
    dailyActivity: mergedDailyActivity,
    dailyModelTokens: mergedDailyModelTokens,
    changeTotals: zeroChangeTotals(),
    dailyChangeActivity: [],
    modelUsage: modelUsageWithCost,
    hourCounts: mergedHourCounts,
    firstSessionDate: stats?.firstSessionDate || '',
    longestSession: stats?.longestSession || { sessionId: '', duration: 0, messageCount: 0, timestamp: '' },
    projectCount: projects.length,
    recentSessions,
  };
}

export function resetClaudeReaderCache(): void {
  sessionInfoCache.clear();
  resetStatsAggregatorCache();
}

export function resetClaudeReaderCacheForTests(): void {
  resetClaudeReaderCache();
}
