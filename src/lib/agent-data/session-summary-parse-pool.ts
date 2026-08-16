import type { AgentDataProvider } from './provider';
import type { CachedSessionSummary, SessionSummarySource } from './session-summary';
import type { SourceParseCheckpoint } from './session-parse-checkpoint';
import { runParseSummaryTask, type ParseTaskProviderOverride } from './session-summary-task-runner';
import { sourceSummaryCacheKey } from './session-summary-cache';
import type { AgentKind } from './types';

export type SummaryParseMode = 'full' | 'incremental' | 'recent';
export type SummaryParsePoolMode = 'inline' | 'worker';

export interface ParseSummaryTask {
  provider: AgentKind;
  source: SessionSummarySource;
  mode: SummaryParseMode;
  previousSummary?: CachedSessionSummary;
  checkpoint?: SourceParseCheckpoint;
}

export interface ParseSummaryResult {
  sourceKey: string;
  provider: AgentKind;
  mode: SummaryParseMode;
  summary?: CachedSessionSummary;
  checkpoint?: SourceParseCheckpoint;
  timings: {
    readMs: number;
    parseMs: number;
    summarizeMs: number;
  };
  error?: string;
}

export interface SummaryParsePool {
  mode: SummaryParsePoolMode;
  size: number;
  run(tasks: ParseSummaryTask[]): Promise<ParseSummaryResult[]>;
  close(): Promise<void>;
}

export interface SummaryParsePoolOptions {
  concurrency: number;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  callback: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(concurrency, 1), items.length);

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await yieldToEventLoop();
      results[index] = await callback(items[index], index);
    }
  }));

  return results;
}

function parseTaskKey(task: ParseSummaryTask): string {
  const signature = task.source.sourceSignature;
  return [
    task.mode,
    sourceSummaryCacheKey(task.source),
    task.source.parserVersion,
    signature.size,
    signature.mtimeMs,
  ].join(':');
}

class InlineSummaryParsePool implements SummaryParsePool {
  mode: SummaryParsePoolMode = 'inline';
  size: number;
  private providerByKind: Map<AgentKind, ParseTaskProviderOverride>;

  constructor(providers: AgentDataProvider[], concurrency: number) {
    this.size = Math.max(1, concurrency);
    this.providerByKind = new Map(providers.map(provider => [provider.kind, {
      buildSessionSummary: provider.buildSessionSummary,
      buildLightweightSessionSummary: provider.buildLightweightSessionSummary,
      incrementalSessionSummary: provider.incrementalSessionSummary,
    }]));
  }

  async run(tasks: ParseSummaryTask[]): Promise<ParseSummaryResult[]> {
    const uniqueTasks: ParseSummaryTask[] = [];
    const uniqueIndexByKey = new Map<string, number>();
    const taskKeys = tasks.map((task) => {
      const key = parseTaskKey(task);
      if (!uniqueIndexByKey.has(key)) {
        uniqueIndexByKey.set(key, uniqueTasks.length);
        uniqueTasks.push(task);
      }
      return key;
    });
    const uniqueResults = await mapWithConcurrency(uniqueTasks, this.size, task => runParseSummaryTask(task, {
      provider: this.providerByKind.get(task.provider),
    }));
    const resultByKey = new Map<string, ParseSummaryResult>();
    uniqueResults.forEach((result, index) => {
      resultByKey.set(parseTaskKey(uniqueTasks[index]), result);
    });
    return taskKeys.map(key => resultByKey.get(key)!);
  }

  async close(): Promise<void> {
    return Promise.resolve();
  }
}

export function createSummaryParsePool(
  providers: AgentDataProvider[],
  options: SummaryParsePoolOptions,
): SummaryParsePool {
  return new InlineSummaryParsePool(providers, options.concurrency);
}
