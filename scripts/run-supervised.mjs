import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const INDEXER_STOP_TIMEOUT_MS = 30_000;
const INDEXER_KILL_TIMEOUT_MS = 5_000;
const SQLITE_FLAG = '--experimental-sqlite';
const SQLITE_DISABLE_FLAG = '--no-experimental-sqlite';

function parseNodeVersion(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  if (!match) throw new Error(`Unable to determine Node SQLite support from version "${version}".`);
  return match.slice(1).map(Number);
}

function compareVersion(left, right) {
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function tokenizeNodeOptions(value) {
  const tokens = [];
  let index = 0;
  while (index < value.length) {
    while (index < value.length && /\s/.test(value[index])) index++;
    if (index >= value.length) break;
    const start = index;
    let token = '';
    let quote = '';
    while (index < value.length) {
      const character = value[index];
      if (quote) {
        if (character === quote) quote = '';
        else token += character;
        index++;
        continue;
      }
      if (character === '"' || character === "'") {
        quote = character;
        index++;
        continue;
      }
      if (/\s/.test(character)) break;
      token += character;
      index++;
    }
    tokens.push({ start, end: index, value: token });
  }
  return tokens;
}

export function buildSqliteChildEnvironment(environment, nodeVersion = process.versions.node) {
  const parsedVersion = parseNodeVersion(nodeVersion);
  if (compareVersion(parsedVersion, [22, 5, 0]) < 0) {
    throw new Error(`AgentScope requires Node 22.5.0 or newer for built-in SQLite. Current Node: v${nodeVersion.replace(/^v/, '')}.`);
  }

  const childEnvironment = { ...environment };
  const nodeOptions = childEnvironment.NODE_OPTIONS || '';
  const tokens = tokenizeNodeOptions(nodeOptions);
  if (tokens.some(token => token.value === SQLITE_DISABLE_FLAG)) {
    throw new Error(`${SQLITE_DISABLE_FLAG} conflicts with required SQLite support on Node v${nodeVersion.replace(/^v/, '')}.`);
  }
  if (compareVersion(parsedVersion, [22, 13, 0]) >= 0) return childEnvironment;

  const sqliteTokens = tokens.filter(token => token.value === SQLITE_FLAG);
  if (sqliteTokens.length === 0) {
    childEnvironment.NODE_OPTIONS = `${nodeOptions}${nodeOptions && !/\s$/.test(nodeOptions) ? ' ' : ''}${SQLITE_FLAG}`;
  } else if (sqliteTokens.length > 1) {
    let normalized = '';
    let cursor = 0;
    for (const duplicate of sqliteTokens.slice(1)) {
      normalized += nodeOptions.slice(cursor, duplicate.start);
      cursor = duplicate.end;
    }
    childEnvironment.NODE_OPTIONS = normalized + nodeOptions.slice(cursor);
  }
  return childEnvironment;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function delay(ms) {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), ms);
    timer.unref?.();
  });
}

function hasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitForChildExit(child, timeoutMs) {
  if (hasExited(child)) return true;
  const exited = new Promise(resolve => child.once('exit', () => resolve(true)));
  return Promise.race([exited, delay(timeoutMs)]);
}

async function waitForEndpoint(endpoint, timeoutMs = 15_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const ready = await new Promise(resolve => {
      const socket = net.createConnection(endpoint);
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => resolve(false));
    });
    if (ready) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for the session indexer sidecar.');
}

export async function startSupervisor({
  mode = 'dev',
  nextArgs = [],
  cwd = process.cwd(),
  environment = process.env,
  platform = process.platform,
  spawnProcess = spawn,
  waitUntilReady = waitForEndpoint,
  loadIndexerBuilder = () => import('./build-indexer.mjs'),
  exitProcess = code => process.exit(code),
  logger = console,
  stopTimeoutMs = INDEXER_STOP_TIMEOUT_MS,
  killTimeoutMs = INDEXER_KILL_TIMEOUT_MS,
  nodeVersion = process.versions.node,
} = {}) {
  const childEnvironment = buildSqliteChildEnvironment(environment, nodeVersion);
  const nonce = crypto.randomBytes(12).toString('hex');
  const endpoint = platform === 'win32'
    ? `\\\\.\\pipe\\agentscope-indexer-${process.pid}-${nonce}`
    : path.join(os.tmpdir(), `agentscope-indexer-${process.pid}-${nonce}.sock`);
  const token = crypto.randomBytes(32).toString('hex');
  const env = {
    ...childEnvironment,
    AGENT_SCOPE_INDEXER_ENDPOINT: endpoint,
    AGENT_SCOPE_INDEXER_TOKEN: token,
  };
  const indexerPath = path.join(cwd, '.next', 'indexer', 'indexer.mjs');
  const nextBin = require.resolve('next/dist/bin/next');
  const indexerLockPath = path.join(
    environment.AGENT_SCOPE_CACHE_DIR || path.join(cwd, '.dashboard-data', 'cache'),
    'agentscope-session-index-v1.db.indexer.lock',
  );

  let indexer;
  let next;
  let watcher;
  let deployment = Promise.resolve();
  let stopPromise;
  let exitRequested = false;
  const expectedIndexerExits = new WeakSet();
  const indexerStops = new WeakMap();
  const firstReady = deferred();

  function removeOwnedIndexerLock(pid) {
    try {
      const lock = JSON.parse(fs.readFileSync(indexerLockPath, 'utf8'));
      if (lock?.pid === pid) fs.rmSync(indexerLockPath, { force: true });
    } catch {
      // The sidecar normally removes its own lock; missing or foreign locks stay untouched.
    }
  }

  function requestExit(code) {
    if (exitRequested) return;
    exitRequested = true;
    queueMicrotask(() => {
      void stop().finally(() => exitProcess(code));
    });
  }

  function launchIndexer() {
    const child = spawnProcess(process.execPath, ['--max-old-space-size=512', indexerPath], {
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      windowsHide: true,
      env,
    });
    indexer = child;
    child.once('exit', code => {
      removeOwnedIndexerLock(child.pid);
      if (indexer === child) indexer = undefined;
      if (expectedIndexerExits.has(child)) return;
      if (!stopPromise) requestExit(code || 1);
    });
    return child;
  }

  function launchNext() {
    const child = spawnProcess(process.execPath, [nextBin, mode, ...nextArgs], {
      stdio: 'inherit',
      windowsHide: true,
      env,
    });
    next = child;
    child.once('exit', code => {
      if (next === child) next = undefined;
      if (!stopPromise) requestExit(code || 0);
    });
  }

  async function stopIndexer(child = indexer) {
    if (!child) return;
    const existing = indexerStops.get(child);
    if (existing) return existing;
    const stopping = (async () => {
      expectedIndexerExits.add(child);
      if (!hasExited(child)) {
        if (child.connected && typeof child.send === 'function') {
          child.send({ type: 'shutdown' });
        } else {
          child.kill();
        }
      }
      let exited = await waitForChildExit(child, stopTimeoutMs);
      if (!exited) {
        child.kill(platform === 'win32' ? undefined : 'SIGKILL');
        exited = await waitForChildExit(child, killTimeoutMs);
      }
      if (!exited) {
        throw new Error('Session indexer did not exit; refusing to launch a second owner.');
      }
      removeOwnedIndexerLock(child.pid);
      if (indexer === child) indexer = undefined;
    })();
    indexerStops.set(child, stopping);
    return stopping;
  }

  async function deployBuild(result, builder) {
    if (result.errors.length > 0) {
      logger.error('Session indexer rebuild failed; keeping the current sidecar.');
      return;
    }
    if (stopPromise) return;
    if (indexer) await stopIndexer(indexer);
    if (stopPromise) return;
    builder.writeIndexerBuild(result);
    const child = launchIndexer();
    await waitUntilReady(endpoint);
    if (indexer !== child || stopPromise) return;
    if (!next) launchNext();
    firstReady.resolve();
  }

  async function stop() {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      await watcher?.dispose().catch(() => undefined);
      await stopIndexer().catch(error => logger.error(error));
      const nextChild = next;
      if (nextChild && !hasExited(nextChild)) {
        nextChild.kill();
        await waitForChildExit(nextChild, killTimeoutMs);
      }
    })();
    return stopPromise;
  }

  try {
    if (mode === 'dev') {
      const builder = await loadIndexerBuilder();
      watcher = await builder.watchIndexerBuilds(result => {
        deployment = deployment.then(() => deployBuild(result, builder));
        return deployment.catch(error => {
          firstReady.reject(error);
          logger.error(error);
          requestExit(1);
        });
      });
      await firstReady.promise;
    } else {
      launchIndexer();
      await waitUntilReady(endpoint);
      launchNext();
      firstReady.resolve();
    }
  } catch (error) {
    await stop();
    throw error;
  }

  return {
    endpoint,
    stop,
    getIndexer: () => indexer,
    getNext: () => next,
  };
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const mode = process.argv[2] === 'start' ? 'start' : 'dev';
  const nextArgs = process.argv.slice(3).filter(argument => argument !== '--');
  try {
    const supervisor = await startSupervisor({ mode, nextArgs });
    process.once('SIGINT', () => void supervisor.stop().finally(() => process.exit(0)));
    process.once('SIGTERM', () => void supervisor.stop().finally(() => process.exit(0)));
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}
