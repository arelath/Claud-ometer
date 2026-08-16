import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { SummaryWorkerRequest, SummaryWorkerResponse } from '@/indexer/summary-worker-protocol';
import type { SessionSummarySource } from './session-summary';
import type { AgentKind } from './types';
import type {
  ParseSummaryResult,
  ParseSummaryTask,
  SummaryParsePool,
  SummaryParsePoolMode,
} from './session-summary-parse-pool';
import { sourceSummaryCacheKey } from './session-summary-cache';

interface PendingTask {
  kind: 'task';
  id: string;
  task: ParseSummaryTask;
  resolve: (result: ParseSummaryResult) => void;
}

interface PendingDiscovery {
  kind: 'discovery';
  id: string;
  provider: AgentKind;
  resolve: (sources: SessionSummarySource[]) => void;
  reject: (error: Error) => void;
}

const WORKER_HEAP_MB = 384;

export class ProcessSummaryParsePool implements SummaryParsePool {
  mode: SummaryParsePoolMode = 'worker';
  size = 1;
  private child: ChildProcess | undefined;
  private pending: PendingTask | PendingDiscovery | undefined;
  private closing = false;

  private workerPath(): string {
    return fileURLToPath(new URL('./summary-worker.mjs', import.meta.url));
  }

  private ensureWorker(): ChildProcess {
    if (this.child?.connected) return this.child;
    if (this.closing) throw new Error('Summary parser process pool is closed');

    const child = fork(this.workerPath(), [], {
      env: process.env,
      execArgv: [`--max-old-space-size=${WORKER_HEAP_MB}`],
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    this.child = child;
    child.on('message', message => this.handleMessage(child, message as SummaryWorkerResponse));
    child.on('error', error => this.handleExit(child, `Summary parser process error: ${error.message}`));
    child.on('exit', (code, signal) => {
      this.handleExit(child, `Summary parser process exited (${signal || code || 'unknown'})`);
    });
    return child;
  }

  private handleMessage(child: ChildProcess, message: SummaryWorkerResponse): void {
    if (this.child !== child) return;
    const pending = this.pending;
    if (!pending || message.id !== pending.id) return;
    this.pending = undefined;
    if (pending.kind === 'task' && message.type === 'result') {
      pending.resolve(message.result);
      return;
    }
    if (pending.kind === 'discovery' && message.type === 'discovered') {
      pending.resolve(message.sources);
      return;
    }
    const error = message.type === 'error' ? message.error : 'Unexpected summary worker response';
    if (pending.kind === 'task') pending.resolve(this.failedResult(pending.task, error));
    else pending.reject(new Error(error));
  }

  private handleExit(child: ChildProcess, error: string): void {
    if (this.child !== child) return;
    const pending = this.pending;
    this.pending = undefined;
    this.child = undefined;
    if (pending?.kind === 'task') pending.resolve(this.failedResult(pending.task, error));
    else if (pending) pending.reject(new Error(error));
  }

  private handleSendError(child: ChildProcess, requestId: string, error: string): void {
    if (this.child !== child || this.pending?.id !== requestId) return;
    child.kill();
    this.handleExit(child, error);
  }

  private failedResult(task: ParseSummaryTask, error: string): ParseSummaryResult {
    return {
      sourceKey: sourceSummaryCacheKey(task.source),
      provider: task.provider,
      mode: task.mode,
      timings: { readMs: 0, parseMs: 0, summarizeMs: 0 },
      error,
    };
  }

  private runOne(task: ParseSummaryTask): Promise<ParseSummaryResult> {
    if (this.pending) throw new Error('Summary parser process already has an active task');
    const id = randomUUID();
    return new Promise((resolve) => {
      this.pending = { kind: 'task', id, task, resolve };
      const request: SummaryWorkerRequest = { type: 'run', id, task };
      try {
        const child = this.ensureWorker();
        child.send(request, (error) => {
          if (error) this.handleSendError(child, id, `Unable to send summary parser task: ${error.message}`);
        });
      } catch (error) {
        const child = this.child;
        const message = error instanceof Error ? error.message : String(error);
        if (child) this.handleSendError(child, id, message);
        else {
          this.pending = undefined;
          resolve(this.failedResult(task, message));
        }
      }
    });
  }

  async run(tasks: ParseSummaryTask[]): Promise<ParseSummaryResult[]> {
    const results: ParseSummaryResult[] = [];
    for (const task of tasks) results.push(await this.runOne(task));
    return results;
  }

  discover(provider: AgentKind): Promise<SessionSummarySource[]> {
    if (this.pending) throw new Error('Summary worker already has an active request');
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      this.pending = { kind: 'discovery', id, provider, resolve, reject };
      const request: SummaryWorkerRequest = { type: 'discover', id, provider };
      try {
        const child = this.ensureWorker();
        child.send(request, (error) => {
          if (error) this.handleSendError(child, id, `Unable to send provider discovery request: ${error.message}`);
        });
      } catch (error) {
        const child = this.child;
        const message = error instanceof Error ? error.message : String(error);
        if (child) this.handleSendError(child, id, message);
        else {
          this.pending = undefined;
          reject(new Error(message));
        }
      }
    });
  }

  async close(): Promise<void> {
    this.closing = true;
    const child = this.child;
    if (!child) return;
    if (child.connected) {
      try {
        child.send({ type: 'shutdown' } satisfies SummaryWorkerRequest);
      } catch {
        // The worker may already be exiting.
      }
    }
    child.kill();
    this.handleExit(child, 'Summary parser process pool closed');
  }
}
