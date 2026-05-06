import fs from 'fs';
import path from 'path';
import { calculateCostAllModes } from '@/config/pricing';
import { getActiveDataSource } from './data-source';
import type { CostEstimates, DailyActivity, DailyModelTokens } from './types';
import { forEachJsonlLine, getProjectsDir, getSessionAggregateFilePaths, getTopLevelSessionFiles } from './io';
import { getAssistantTurnCacheWriteTokens, recordAssistantTurn, type AssistantTurnAggregate } from './assistant-turns';
import { addCosts, zeroCosts } from './cost-utils';

export interface SupplementalModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  estimatedCosts: CostEstimates;
}

export interface SupplementalStats {
  dailyActivity: DailyActivity[];
  dailyModelTokens: DailyModelTokens[];
  modelUsage: Record<string, SupplementalModelUsage>;
  hourCounts: Record<string, number>;
  totalSessions: number;
  totalMessages: number;
  totalTokens: number;
  estimatedCosts: CostEstimates;
}

let supplementalCache: { key: string; data: SupplementalStats; ts: number } | null = null;
const SUPPLEMENTAL_TTL_MS = 30_000;

function getRecentSessionFiles(afterDate: string): string[] {
  const projectsDir = getProjectsDir();
  if (!fs.existsSync(projectsDir)) return [];

  const cutoff = afterDate ? new Date(afterDate + 'T23:59:59Z').getTime() : 0;
  const files: string[] = [];

  for (const entry of fs.readdirSync(projectsDir)) {
    const projectPath = path.join(projectsDir, entry);
    if (!fs.statSync(projectPath).isDirectory()) continue;

    for (const file of getTopLevelSessionFiles(projectPath)) {
      const filePath = path.join(projectPath, file);
      const aggregateFilePaths = getSessionAggregateFilePaths(filePath);
      if (aggregateFilePaths.some(aggregateFilePath => fs.statSync(aggregateFilePath).mtimeMs > cutoff)) {
        files.push(filePath);
      }
    }
  }

  return files;
}

export async function computeSupplementalStats(afterDate: string): Promise<SupplementalStats> {
  const cacheKey = afterDate + ':' + getActiveDataSource();
  if (supplementalCache && supplementalCache.key === cacheKey && Date.now() - supplementalCache.ts < SUPPLEMENTAL_TTL_MS) {
    return supplementalCache.data;
  }

  const files = getRecentSessionFiles(afterDate);

  const dailyMap = new Map<string, DailyActivity>();
  const dailyModelMap = new Map<string, Record<string, number>>();
  const dailyModelCostMap = new Map<string, Record<string, CostEstimates>>();
  const modelUsage: Record<string, SupplementalModelUsage> = {};
  const hourCounts: Record<string, number> = {};
  let totalSessions = 0;
  let totalMessages = 0;
  let totalTokens = 0;
  let estimatedCosts = zeroCosts();

  for (const filePath of files) {
    let sessionCounted = false;
    let firstQualifyingDate = '';
    const assistantTurns = new Map<string, AssistantTurnAggregate>();

    await forEachJsonlLine(filePath, (msg) => {
      if (msg.type === 'assistant') {
        recordAssistantTurn(assistantTurns, filePath, msg, true);
      }

      if (!msg.timestamp || msg.type !== 'user' || msg.message?.role !== 'user') return;

      const msgDate = msg.timestamp.slice(0, 10);
      if (afterDate && msgDate <= afterDate) return;

      if (!sessionCounted) {
        totalSessions++;
        sessionCounted = true;
        firstQualifyingDate = msgDate;
      }

      totalMessages++;
      let day = dailyMap.get(msgDate);
      if (!day) {
        day = { date: msgDate, messageCount: 0, sessionCount: 0, toolCallCount: 0 };
        dailyMap.set(msgDate, day);
      }
      day.messageCount++;
    });

    for (const aggregateFilePath of getSessionAggregateFilePaths(filePath).slice(1)) {
      await forEachJsonlLine(aggregateFilePath, (msg) => {
        if (msg.type === 'assistant') {
          recordAssistantTurn(assistantTurns, aggregateFilePath, msg, false);
        }
      });
    }

    const qualifyingAssistantTurns = Array.from(assistantTurns.values())
      .filter(turn => turn.timestamp)
      .filter(turn => !afterDate || turn.timestamp.slice(0, 10) > afterDate);

    for (const assistantTurn of qualifyingAssistantTurns) {
      const msgDate = assistantTurn.timestamp.slice(0, 10);
      const hour = assistantTurn.timestamp.slice(11, 13);

      if (!sessionCounted) {
        totalSessions++;
        sessionCounted = true;
        firstQualifyingDate = msgDate;
      }

      if (assistantTurn.topLevel) {
        totalMessages++;
        let day = dailyMap.get(msgDate);
        if (!day) {
          day = { date: msgDate, messageCount: 0, sessionCount: 0, toolCallCount: 0 };
          dailyMap.set(msgDate, day);
        }
        day.messageCount++;
        day.toolCallCount += assistantTurn.toolCalls.size;
      }

      if (!assistantTurn.usage) continue;

      const model = assistantTurn.model;
      const input = assistantTurn.usage.input_tokens || 0;
      const output = assistantTurn.usage.output_tokens || 0;
      const cacheRead = assistantTurn.usage.cache_read_input_tokens || 0;
      const cacheWrite = getAssistantTurnCacheWriteTokens(assistantTurn);
      const tokens = input + output + cacheRead + cacheWrite;
      const costs = calculateCostAllModes(model, input, output, cacheWrite, cacheRead);

      totalTokens += tokens;
      estimatedCosts = addCosts(estimatedCosts, costs);
      hourCounts[hour] = (hourCounts[hour] || 0) + 1;

      if (model) {
        if (!modelUsage[model]) {
          modelUsage[model] = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, estimatedCosts: zeroCosts() };
        }
        modelUsage[model].inputTokens += input;
        modelUsage[model].outputTokens += output;
        modelUsage[model].cacheReadInputTokens += cacheRead;
        modelUsage[model].cacheCreationInputTokens += cacheWrite;
        modelUsage[model].estimatedCosts = addCosts(modelUsage[model].estimatedCosts, costs);

        let dayModel = dailyModelMap.get(msgDate);
        if (!dayModel) {
          dayModel = {};
          dailyModelMap.set(msgDate, dayModel);
        }
        dayModel[model] = (dayModel[model] || 0) + tokens;

        let dayCost = dailyModelCostMap.get(msgDate);
        if (!dayCost) {
          dayCost = {};
          dailyModelCostMap.set(msgDate, dayCost);
        }
        dayCost[model] = dayCost[model] ? addCosts(dayCost[model], costs) : { ...costs };
      }
    }

    if (sessionCounted && firstQualifyingDate) {
      const day = dailyMap.get(firstQualifyingDate);
      if (day) day.sessionCount++;
    }
  }

  const dailyActivity = Array.from(dailyMap.values()).sort((a, b) => a.date.localeCompare(b.date));
  const dailyModelTokens: DailyModelTokens[] = Array.from(dailyModelMap.entries())
    .map(([date, tokensByModel]) => ({
      date,
      tokensByModel,
      costsByModel: dailyModelCostMap.get(date) || {},
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const result: SupplementalStats = {
    dailyActivity,
    dailyModelTokens,
    modelUsage,
    hourCounts,
    totalSessions,
    totalMessages,
    totalTokens,
    estimatedCosts,
  };

  supplementalCache = { key: cacheKey, data: result, ts: Date.now() };
  return result;
}
