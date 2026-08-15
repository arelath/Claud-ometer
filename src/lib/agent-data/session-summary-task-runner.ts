import type { AgentDataProvider } from './provider';
import { sourceSummaryCacheKey } from './session-summary-cache';
import type { ParseSummaryResult, ParseSummaryTask } from './session-summary-parse-pool';
import type { SessionSummarySource } from './session-summary';
import type { AgentKind } from './types';
import * as claudeReader from '@/lib/claude-data/reader';
import * as codexReader from './providers/codex/reader';
import * as copilotReader from './providers/copilot/reader';
import * as cursorReader from './providers/cursor/reader';

type FullSummaryBuilder = (source: SessionSummarySource) => Promise<ParseSummaryResult['summary']>;

export interface ParseTaskProviderOverride {
  buildSessionSummary?: AgentDataProvider['buildSessionSummary'];
  incrementalSessionSummary?: AgentDataProvider['incrementalSessionSummary'];
}

export interface RunParseSummaryTaskOptions {
  provider?: ParseTaskProviderOverride;
}

function elapsedMs(start: number): number {
  return Math.max(0, Date.now() - start);
}

function fullSummaryBuilderForProvider(provider: AgentKind): FullSummaryBuilder {
  if (provider === 'claude') return claudeReader.buildSessionSummary;
  if (provider === 'codex') return codexReader.buildSessionSummary;
  if (provider === 'copilot') return copilotReader.buildSessionSummary;
  return cursorReader.buildSessionSummary;
}

export async function runParseSummaryTask(
  task: ParseSummaryTask,
  options: RunParseSummaryTaskOptions = {},
): Promise<ParseSummaryResult> {
  const started = Date.now();
  const resultBase = {
    sourceKey: sourceSummaryCacheKey(task.source),
    provider: task.provider,
    mode: task.mode,
    timings: {
      readMs: 0,
      parseMs: 0,
      summarizeMs: 0,
    },
  };

  try {
    if (task.mode === 'incremental') {
      const incremental = options.provider?.incrementalSessionSummary;
      if (!incremental) throw new Error(`Provider ${task.provider} does not support incremental summaries`);
      if (!task.previousSummary) throw new Error(`Missing previous summary for ${task.provider} incremental parse`);
      if (!task.checkpoint) throw new Error(`Missing checkpoint for ${task.provider} incremental parse`);
      const parsed = await incremental.buildSessionSummary(
        task.source,
        task.previousSummary,
        task.checkpoint,
      );
      return {
        ...resultBase,
        summary: parsed.summary,
        checkpoint: parsed.checkpoint,
        timings: { ...resultBase.timings, parseMs: elapsedMs(started) },
      };
    }

    const buildFullSummary = options.provider?.buildSessionSummary || fullSummaryBuilderForProvider(task.provider);
    return {
      ...resultBase,
      summary: await buildFullSummary(task.source),
      timings: { ...resultBase.timings, parseMs: elapsedMs(started) },
    };
  } catch (error) {
    return {
      ...resultBase,
      timings: { ...resultBase.timings, parseMs: elapsedMs(started) },
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
