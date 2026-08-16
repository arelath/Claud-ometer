import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mode = process.argv[2] === 'start' ? 'start' : 'dev';
const nextArgs = process.argv.slice(3).filter(argument => argument !== '--');
const nonce = crypto.randomBytes(12).toString('hex');
const endpoint = process.platform === 'win32'
  ? `\\\\.\\pipe\\agentscope-indexer-${process.pid}-${nonce}`
  : path.join(os.tmpdir(), `agentscope-indexer-${process.pid}-${nonce}.sock`);
const token = crypto.randomBytes(32).toString('hex');
const env = {
  ...process.env,
  AGENT_SCOPE_INDEXER_ENDPOINT: endpoint,
  AGENT_SCOPE_INDEXER_TOKEN: token,
};
const indexerPath = path.join(process.cwd(), '.next', 'indexer', 'indexer.mjs');
const nextBin = require.resolve('next/dist/bin/next');
const children = [];
let stopping = false;
const indexerLockPath = path.join(
  process.env.AGENT_SCOPE_CACHE_DIR || path.join(process.cwd(), '.dashboard-data', 'cache'),
  'agentscope-session-index-v1.db.indexer.lock',
);

function launch(command, args, options = {}) {
  const child = spawn(command, args, { stdio: 'inherit', windowsHide: true, env, ...options });
  children.push(child);
  return child;
}

async function waitForEndpoint(timeoutMs = 15_000) {
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

function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.killed) child.kill();
  }
  setTimeout(() => process.exit(exitCode), 250).unref();
}

function removeOwnedIndexerLock(pid) {
  try {
    const lock = JSON.parse(fs.readFileSync(indexerLockPath, 'utf8'));
    if (lock?.pid === pid) fs.rmSync(indexerLockPath, { force: true });
  } catch {
    // The sidecar normally removes its own lock; missing or foreign locks stay untouched.
  }
}

const indexer = launch(process.execPath, ['--max-old-space-size=512', indexerPath]);
indexer.once('exit', code => {
  removeOwnedIndexerLock(indexer.pid);
  if (!stopping) stop(code || 1);
});

try {
  await waitForEndpoint();
  const next = launch(process.execPath, [nextBin, mode, ...nextArgs]);
  next.once('exit', code => stop(code || 0));
} catch (error) {
  console.error(error);
  stop(1);
}

process.once('SIGINT', () => stop(0));
process.once('SIGTERM', () => stop(0));
