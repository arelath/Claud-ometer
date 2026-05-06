import fs from 'fs';
import path from 'path';
import { calculateCostAllModes, getModelDisplayName, DEFAULT_COST_MODE } from '@/config/pricing';
import type {
  StatsCache,
  HistoryEntry,
  ProjectInfo,
  SessionInfo,
  SessionDetail,
  SessionMessageBlockDisplay,
  SessionMessageDisplay,
  SessionToolCallDisplay,
  DashboardStats,
  DailyActivity,
  DailyModelTokens,
  TokenUsage,
  CostEstimates,
} from './types';
import { addCosts, zeroCosts } from './cost-utils';
import { getClaudeDir, getProjectsDir, getSessionAggregateFilePaths, getTopLevelSessionFiles, forEachJsonlLine } from './io';
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
import { computeSupplementalStats } from './stats-aggregator';
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

async function parseSessionFile(filePath: string, projectId: string, projectName: string): Promise<SessionInfo> {
  const sessionId = path.basename(filePath, '.jsonl');
  const aggregateFilePaths = getSessionAggregateFilePaths(filePath);

  let firstTimestamp = '';
  let lastTimestamp = '';
  let userMessageCount = 0;
  let assistantMessageCount = 0;
  let toolCallCount = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCacheWriteTokens = 0;
  let estimatedCosts = zeroCosts();
  let gitBranch = '';
  let cwd = '';
  let version = '';
  const modelsSet = new Set<string>();
  const toolsUsed: Record<string, number> = {};

  // Compaction tracking
  let compactions = 0;
  let microcompactions = 0;
  let totalTokensSaved = 0;
  const compactionTimestamps: string[] = [];
  const assistantTurns = new Map<string, AssistantTurnAggregate>();

  await forEachJsonlLine(filePath, (msg) => {
    if (msg.timestamp) {
      if (!firstTimestamp) firstTimestamp = msg.timestamp;
      lastTimestamp = msg.timestamp;
    }
    if (msg.gitBranch && !gitBranch) gitBranch = msg.gitBranch;
    if (msg.cwd && !cwd) cwd = msg.cwd;
    if (msg.version && !version) version = msg.version;

    // Track compaction events
    if (msg.compactMetadata) {
      compactions++;
      if (msg.timestamp) compactionTimestamps.push(msg.timestamp);
    }
    if (msg.microcompactMetadata) {
      microcompactions++;
      totalTokensSaved += msg.microcompactMetadata.tokensSaved || 0;
      if (msg.timestamp) compactionTimestamps.push(msg.timestamp);
    }

    if (msg.type === 'user') {
      if (msg.message?.role === 'user' && typeof msg.message.content === 'string') {
        userMessageCount++;
      } else if (msg.message?.role === 'user') {
        userMessageCount++;
      }
    }
    if (msg.type === 'assistant') {
      recordAssistantTurn(assistantTurns, filePath, msg, true);
    }
  });

  for (const aggregateFilePath of aggregateFilePaths.slice(1)) {
    await forEachJsonlLine(aggregateFilePath, (msg) => {
      if (msg.timestamp && msg.timestamp > lastTimestamp) lastTimestamp = msg.timestamp;
      recordAssistantTurn(assistantTurns, aggregateFilePath, msg, false);
    });
  }

  for (const assistantTurn of assistantTurns.values()) {
    if (assistantTurn.topLevel) {
      assistantMessageCount++;
      for (const toolName of assistantTurn.toolCalls.values()) {
        toolCallCount++;
        toolsUsed[toolName] = (toolsUsed[toolName] || 0) + 1;
      }
    }

    if (assistantTurn.model) modelsSet.add(assistantTurn.model);
    if (!assistantTurn.usage) continue;

    totalInputTokens += assistantTurn.usage.input_tokens || 0;
    totalOutputTokens += assistantTurn.usage.output_tokens || 0;
    totalCacheReadTokens += assistantTurn.usage.cache_read_input_tokens || 0;
    totalCacheWriteTokens += getAssistantTurnCacheWriteTokens(assistantTurn);
    estimatedCosts = addCosts(
      estimatedCosts,
      calculateCostAllModes(
        assistantTurn.model,
        assistantTurn.usage.input_tokens || 0,
        assistantTurn.usage.output_tokens || 0,
        getAssistantTurnCacheWriteTokens(assistantTurn),
        assistantTurn.usage.cache_read_input_tokens || 0,
      ),
    );
  }

  const duration = firstTimestamp && lastTimestamp
    ? new Date(lastTimestamp).getTime() - new Date(firstTimestamp).getTime()
    : 0;

  const models = Array.from(modelsSet);

  return {
    id: sessionId,
    projectId,
    projectName,
    timestamp: firstTimestamp || new Date().toISOString(),
    duration,
    messageCount: userMessageCount + assistantMessageCount,
    userMessageCount,
    assistantMessageCount,
    toolCallCount,
    totalInputTokens,
    totalOutputTokens,
    totalCacheReadTokens,
    totalCacheWriteTokens,
    estimatedCost: estimatedCosts[DEFAULT_COST_MODE],
    estimatedCosts,
    model: models[0] || 'unknown',
    models: models.map(getModelDisplayName),
    gitBranch,
    cwd,
    version,
    toolsUsed,
    compaction: {
      compactions,
      microcompactions,
      totalTokensSaved,
      compactionTimestamps,
    },
  };
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
    const sessionInfo = await parseSessionFile(filePath, entry, projectName);
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
          const promptBreakdown = buildPromptBreakdown(
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

export async function getDashboardStats(): Promise<DashboardStats> {
  const stats = getStatsCache();
  const projects = await getProjects();
  const afterDate = stats?.lastComputedDate || '';

  // Compute supplemental stats from JSONL files modified after the cache date
  const supplemental = await computeSupplementalStats(afterDate);

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
  const mergedHourCounts = { ...(stats?.hourCounts || {}) };
  for (const [hour, count] of Object.entries(supplemental.hourCounts)) {
    mergedHourCounts[hour] = (mergedHourCounts[hour] || 0) + count;
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
    modelUsage: modelUsageWithCost,
    hourCounts: mergedHourCounts,
    firstSessionDate: stats?.firstSessionDate || '',
    longestSession: stats?.longestSession || { sessionId: '', duration: 0, messageCount: 0, timestamp: '' },
    projectCount: projects.length,
    recentSessions,
  };
}
