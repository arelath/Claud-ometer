import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getActiveProviders } from '@/lib/agent-data/registry';
import {
  reconcileSessionSummaryIndex,
  type ProgressiveSessionIndexProgress,
} from '@/lib/agent-data/session-summary-store';
import { ProcessSummaryParsePool } from '@/lib/agent-data/session-summary-process-pool';
import {
  closeSessionSummaryIndexWriter,
  getLegacySessionSummaryIndexPath,
  initializeSessionSummaryIndexWriter,
  writeSessionIndexerRuntimeStatus,
  type SessionIndexerRuntimeStatus,
} from '@/lib/agent-data/session-summary-sqlite-store';
import {
  INDEXER_ENDPOINT_ENV,
  INDEXER_TOKEN_ENV,
  type IndexerRequest,
  type IndexerRunAccepted,
} from '@/lib/agent-data/indexer-protocol';
import type { AgentKind } from '@/lib/agent-data/types';
import { startIndexerControlServer } from './control-server';

const endpoint = process.env[INDEXER_ENDPOINT_ENV];
const token = process.env[INDEXER_TOKEN_ENV];
if (!endpoint || !token) throw new Error('Indexer endpoint and token are required.');
const requiredEndpoint = endpoint;

let status: SessionIndexerRuntimeStatus = {
  state: 'building',
  queueDepth: 0,
  activeSources: 0,
  pendingSources: 0,
  failedSources: 0,
  initialBuild: true,
};
let running: Promise<void> | undefined;
let queuedProviders = new Set<AgentKind>();
let queueAllProviders = false;
let forceQueued = false;
let queuedRun: IndexerRunAccepted | undefined;
let paused = false;
let shuttingDown = false;
const parsePool = new ProcessSummaryParsePool();
let lastProgressPublishAt = 0;

function publishStatus(patch: Partial<SessionIndexerRuntimeStatus> = {}): void {
  status = { ...status, ...patch };
  try {
    writeSessionIndexerRuntimeStatus(status);
  } catch (error) {
    process.stderr.write(`Unable to persist indexer status: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

function providersFor(kinds: Set<AgentKind>) {
  const active = getActiveProviders();
  return kinds.size ? active.filter(provider => kinds.has(provider.kind)) : active;
}

function schedule(providers: AgentKind[] | undefined, force: boolean): IndexerRunAccepted {
  if (!providers?.length) queueAllProviders = true;
  for (const provider of providers || []) queuedProviders.add(provider);
  forceQueued ||= force;
  queuedRun ||= { runId: randomUUID(), state: 'queued' };
  const acceptedRun = queuedRun;
  publishStatus({
    queueDepth: 1,
    pendingSources: 1,
    state: paused ? 'paused' : 'building',
    run: { id: queuedRun.runId, state: 'queued' },
  });
  if (!paused) void drain();
  return acceptedRun;
}

async function drain(): Promise<void> {
  if (running || paused || shuttingDown || !queuedRun) return;
  const kinds = queueAllProviders ? new Set<AgentKind>() : queuedProviders;
  queuedProviders = new Set();
  queueAllProviders = false;
  const force = forceQueued;
  forceQueued = false;
  const acceptedRun = queuedRun;
  queuedRun = undefined;
  const run = { id: acceptedRun.runId, state: 'queued' as const };
  const startedAt = new Date().toISOString();
  publishStatus({
    state: 'building',
    queueDepth: 0,
    pendingSources: 0,
    activeSources: 1,
    run: { ...run, state: 'running', startedAt },
  });
  running = (async () => {
    try {
      const providers = providersFor(kinds);
      const onProgress = (progress: ProgressiveSessionIndexProgress) => {
        const now = Date.now();
        if (now - lastProgressPublishAt < 1_000 && progress.processedSources < progress.totalSources) return;
        lastProgressPublishAt = now;
        publishStatus({
          totalSources: progress.totalSources,
          processedSources: progress.processedSources,
          committedSources: progress.committedSources,
          failedSources: progress.failedSources,
          heapUsedBytes: progress.heapUsedBytes,
          rssBytes: progress.rssBytes,
          currentProvider: progress.currentProvider,
        });
      };
      const result = await reconcileSessionSummaryIndex(providers, {
        force,
        parsePool,
        discoverProvider: provider => parsePool.discover(provider.kind),
        onProgress,
      });
      const pendingRun = queuedRun as IndexerRunAccepted | undefined;
      publishStatus({
        state: paused ? 'paused' : result.failedSources ? 'degraded' : 'ready',
        activeSources: 0,
        failedSources: result.failedSources,
        initialBuild: result.validSources === 0 && result.committedSources === 0,
        totalSources: result.totalSources,
        processedSources: result.processedSources,
        committedSources: result.committedSources,
        heapUsedBytes: result.heapUsedBytes,
        rssBytes: result.rssBytes,
        currentProvider: undefined,
        ...(result.committedSources > 0 ? { lastCommittedAt: new Date().toISOString() } : {}),
        lastError: result.lastError,
        run: pendingRun
          ? { id: pendingRun.runId, state: 'queued' }
          : { ...run, state: 'completed', startedAt, completedAt: new Date().toISOString() },
      });
    } catch (error) {
      const pendingRun = queuedRun as IndexerRunAccepted | undefined;
      publishStatus({
        state: paused ? 'paused' : 'degraded',
        activeSources: 0,
        failedSources: status.failedSources + 1,
        lastError: error instanceof Error ? error.message : String(error),
        run: pendingRun
          ? { id: pendingRun.runId, state: 'queued' }
          : { ...run, state: 'failed', startedAt, completedAt: new Date().toISOString() },
      });
    } finally {
      running = undefined;
      if (queuedRun) void drain();
    }
  })();
  await running;
}

const lockPath = `${getLegacySessionSummaryIndexPath()}.indexer.lock`;
fs.mkdirSync(path.dirname(lockPath), { recursive: true });
try {
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { flag: 'wx' });
} catch {
  let stale = false;
  try {
    const prior = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as { pid?: number };
    if (prior.pid) process.kill(prior.pid, 0);
  } catch {
    stale = true;
  }
  if (!stale) throw new Error(`Another session indexer owns ${lockPath}.`);
  fs.rmSync(lockPath, { force: true });
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { flag: 'wx' });
}

initializeSessionSummaryIndexWriter();

const controlServer = await startIndexerControlServer(requiredEndpoint, token, async (request: IndexerRequest) => {
  switch (request.command) {
    case 'health': return status;
    case 'reconcile': return schedule(request.providers, false);
    case 'rebuild': return schedule(request.providers, true);
    case 'pause':
      paused = true;
      publishStatus({ state: 'paused' });
      return status;
    case 'resume':
      paused = false;
      publishStatus({ state: running ? 'building' : 'ready' });
      void drain();
      return status;
  }
});

const configuredReconcileInterval = Number.parseInt(process.env.AGENT_SCOPE_RECONCILE_INTERVAL_MS || '', 10);
const reconcileIntervalMs = Number.isFinite(configuredReconcileInterval)
  ? Math.max(1_000, configuredReconcileInterval)
  : 5_000;
const reconcileTimer = setInterval(() => {
  if (!paused && !shuttingDown && !running && !queuedRun) schedule(undefined, false);
}, reconcileIntervalMs);
reconcileTimer.unref();

let shutdownPromise: Promise<void> | undefined;

function removeOwnedLock(): void {
  try {
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as { pid?: number };
    if (lock.pid === process.pid) fs.rmSync(lockPath, { force: true });
  } catch {
    // Missing, malformed, or foreign locks must not be removed by this process.
  }
}

function shutdown(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  shuttingDown = true;
  shutdownPromise = (async () => {
    clearInterval(reconcileTimer);
    await parsePool.close().catch(() => undefined);
    await running?.catch(() => undefined);
    await controlServer.close().catch(() => undefined);
    closeSessionSummaryIndexWriter();
    if (process.platform !== 'win32') fs.rmSync(requiredEndpoint, { force: true });
    removeOwnedLock();
  })();
  return shutdownPromise;
}

function shutdownAndExit(): void {
  void shutdown().finally(() => process.exit(0));
}

process.once('message', message => {
  if ((message as { type?: string } | null)?.type === 'shutdown') shutdownAndExit();
});
process.once('SIGINT', shutdownAndExit);
process.once('SIGTERM', shutdownAndExit);
schedule(undefined, false);
