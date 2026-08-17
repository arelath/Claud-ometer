import type { AgentDataProvider } from './provider';
import { sourceSummaryCacheKey } from './session-summary-cache';
import type { ParseSummaryResult, ParseSummaryTask } from './session-summary-parse-pool';
import type { SessionSummarySource } from './session-summary';
import type { AgentKind } from './types';
import * as claudeReader from '@/lib/claude-data/reader';
import * as codexReader from './providers/codex/reader';
import * as copilotReader from './providers/copilot/reader';
import * as cursorReader from './providers/cursor/reader';
import { SessionSummaryDeferredError } from './session-summary-deferred';

type FullSummaryBuilder = (source: SessionSummarySource) => Promise<ParseSummaryResult['summary']>;

export interface ParseTaskProviderOverride {
  buildSessionSummary?: AgentDataProvider['buildSessionSummary'];
  buildSessionSummaryWithCheckpoint?: AgentDataProvider['buildSessionSummaryWithCheckpoint'];
  buildLightweightSessionSummary?: AgentDataProvider['buildLightweightSessionSummary'];
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

function lightweightSummaryBuilderForProvider(
  provider: AgentKind,
): AgentDataProvider['buildLightweightSessionSummary'] | undefined {
  if (provider === 'codex') return codexReader.buildLightweightSessionSummary;
  if (provider === 'copilot') return copilotReader.buildLightweightSessionSummary;
  if (provider === 'cursor') return cursorReader.buildLightweightSessionSummary;
  return undefined;
}

function checkpointSummaryBuilderForProvider(
  provider: AgentKind,
  parserVersion: string,
): AgentDataProvider['buildSessionSummaryWithCheckpoint'] | undefined {
  return provider === 'claude' && parserVersion === claudeReader.CLAUDE_SESSION_SUMMARY_PARSER_VERSION
    ? claudeReader.buildSessionSummaryWithCheckpoint
    : undefined;
}

function incrementalSummaryBuilderForProvider(
  provider: AgentKind,
  parserVersion: string,
): AgentDataProvider['incrementalSessionSummary'] | undefined {
  return provider === 'claude' && parserVersion === claudeReader.CLAUDE_SESSION_SUMMARY_PARSER_VERSION ? {
    checkpointVersion: claudeReader.CLAUDE_INCREMENTAL_CHECKPOINT_VERSION,
    buildRecentAsFull: true,
    buildSessionSummary: claudeReader.buildIncrementalSessionSummary,
  } : undefined;
}

export function resetProviderSummaryResources(provider: AgentKind): void {
  if (provider === 'claude') claudeReader.resetClaudeReaderCache();
  else if (provider === 'codex') codexReader.resetCodexReaderCache();
  else if (provider === 'copilot') copilotReader.resetCopilotReaderCache();
  else cursorReader.resetCursorReaderCache();
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
    if (task.mode === 'recent') {
      const buildLightweightSummary = options.provider?.buildLightweightSessionSummary
        || lightweightSummaryBuilderForProvider(task.provider);
      const summary = buildLightweightSummary
        ? { ...buildLightweightSummary(task.source), isPartial: true }
        : await (options.provider?.buildSessionSummary || fullSummaryBuilderForProvider(task.provider))(task.source);
      return {
        ...resultBase,
        summary,
        timings: { ...resultBase.timings, parseMs: elapsedMs(started) },
      };
    }

    if (task.mode === 'incremental') {
      const incremental = options.provider
        ? options.provider.incrementalSessionSummary
        : incrementalSummaryBuilderForProvider(task.provider, task.source.parserVersion);
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
        mutations: parsed.mutations,
        timings: { ...resultBase.timings, parseMs: elapsedMs(started) },
      };
    }

    const buildWithCheckpoint = options.provider
      ? options.provider.buildSessionSummaryWithCheckpoint
      : checkpointSummaryBuilderForProvider(task.provider, task.source.parserVersion);
    if (buildWithCheckpoint) {
      const parsed = await buildWithCheckpoint(task.source);
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
    if (error instanceof SessionSummaryDeferredError) {
      return {
        ...resultBase,
        timings: { ...resultBase.timings, parseMs: elapsedMs(started) },
        deferred: error.message,
      };
    }
    return {
      ...resultBase,
      timings: { ...resultBase.timings, parseMs: elapsedMs(started) },
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
