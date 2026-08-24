import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildSqliteChildEnvironment, startSupervisor } from '../../scripts/run-supervised.mjs';

class FakeChild extends EventEmitter {
  static nextPid = 10_000;
  pid = FakeChild.nextPid++;
  connected = true;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  constructor(
    private readonly kind: 'indexer' | 'next',
    private readonly events: string[],
    private readonly activeIndexers: Set<number>,
    private readonly ignoreGracefulShutdown = false,
  ) {
    super();
    if (kind === 'indexer') activeIndexers.add(this.pid);
  }

  send(message: { type?: string }) {
    this.events.push(`send:${this.kind}:${message.type}`);
    if (!this.ignoreGracefulShutdown) this.finish(0);
    return true;
  }

  kill(signal?: NodeJS.Signals | number) {
    this.events.push(`kill:${this.kind}${signal ? `:${signal}` : ''}`);
    if (this.ignoreGracefulShutdown && signal !== 'SIGKILL') return true;
    this.finish(0);
    return true;
  }

  private finish(code: number) {
    if (this.exitCode !== null) return;
    this.exitCode = code;
    this.connected = false;
    if (this.kind === 'indexer') this.activeIndexers.delete(this.pid);
    this.emit('exit', code, null);
  }
}

function successfulBuild(generation: number) {
  return {
    errors: [],
    warnings: [],
    outputFiles: [{ path: `generation-${generation}.mjs`, contents: new Uint8Array([generation]) }],
  };
}

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) fs.rmSync(tempDir, { recursive: true, force: true });
});

function harness({ ignoreGracefulIndexer = false } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agentscope-supervisor-'));
  tempDirs.push(cwd);
  const cacheDir = path.join(cwd, 'cache');
  const events: string[] = [];
  const children: FakeChild[] = [];
  const activeIndexers = new Set<number>();
  let maxActiveIndexers = 0;
  let notifyBuild!: (result: ReturnType<typeof successfulBuild>) => Promise<void>;
  const watcher = { dispose: vi.fn(async () => { events.push('dispose'); }) };
  const builder = {
    buildIndexer: vi.fn(),
    writeIndexerBuild: vi.fn((result: ReturnType<typeof successfulBuild>) => {
      events.push(`write:${result.outputFiles[0].contents[0]}`);
    }),
    watchIndexerBuilds: vi.fn(async (onBuild: typeof notifyBuild) => {
      notifyBuild = onBuild;
      events.push('watch');
      await onBuild(successfulBuild(1));
      return watcher;
    }),
  };
  const spawnProcess = vi.fn((_command: string, args: string[], _options?: { env?: Record<string, string> }) => {
    const kind = args.some(argument => argument.endsWith('indexer.mjs')) ? 'indexer' as const : 'next' as const;
    const child = new FakeChild(kind, events, activeIndexers, ignoreGracefulIndexer && kind === 'indexer');
    children.push(child);
    events.push(`spawn:${kind}:${child.pid}`);
    maxActiveIndexers = Math.max(maxActiveIndexers, activeIndexers.size);
    return child;
  });
  const waitUntilReady = vi.fn(async () => { events.push('ready'); });

  return {
    cwd,
    cacheDir,
    events,
    children,
    activeIndexers,
    builder,
    watcher,
    spawnProcess,
    waitUntilReady,
    getNotifyBuild: () => notifyBuild,
    getMaxActiveIndexers: () => maxActiveIndexers,
  };
}

describe('supervised indexer lifecycle', () => {
  it('enables SQLite for every supervised child on flagged Node 22 releases', async () => {
    const test = harness();
    const environment: NodeJS.ProcessEnv = { AGENT_SCOPE_CACHE_DIR: test.cacheDir, NODE_ENV: 'test', NODE_OPTIONS: '--trace-warnings' };
    const supervisor = await startSupervisor({
      mode: 'dev',
      cwd: test.cwd,
      environment,
      nodeVersion: '22.11.0',
      spawnProcess: test.spawnProcess as never,
      waitUntilReady: test.waitUntilReady,
      loadIndexerBuilder: (async () => test.builder) as never,
      exitProcess: vi.fn() as unknown as (code: number) => never,
    });

    expect(environment.NODE_OPTIONS).toBe('--trace-warnings');
    expect(test.spawnProcess).toHaveBeenCalledTimes(2);
    const childEnvironments = test.spawnProcess.mock.calls.map(call => call[2]?.env);
    expect(childEnvironments[0]).toBe(childEnvironments[1]);
    expect(childEnvironments[0]?.NODE_OPTIONS).toBe('--trace-warnings --experimental-sqlite');
    await supervisor.stop();
  });

  it('classifies SQLite Node boundaries and preserves unflagged environments', () => {
    expect(() => buildSqliteChildEnvironment({}, '22.4.99')).toThrow('Node 22.5.0 or newer');
    expect(() => buildSqliteChildEnvironment({}, 'not-a-version')).toThrow('Unable to determine');
    expect(buildSqliteChildEnvironment({}, '22.5.0').NODE_OPTIONS).toBe('--experimental-sqlite');
    expect(buildSqliteChildEnvironment({}, '22.12.99').NODE_OPTIONS).toBe('--experimental-sqlite');

    const environment = { NODE_OPTIONS: '--trace-warnings', CUSTOM: 'unchanged' };
    expect(buildSqliteChildEnvironment(environment, '22.13.0')).toEqual(environment);
    expect(buildSqliteChildEnvironment(environment, '24.0.0')).toEqual(environment);
    expect(buildSqliteChildEnvironment(environment, '22.13.0')).not.toBe(environment);
  });

  it('deduplicates the SQLite flag and rejects an explicit disable flag', () => {
    expect(buildSqliteChildEnvironment(
      { NODE_OPTIONS: '--trace-warnings --experimental-sqlite --experimental-sqlite' },
      '22.11.0',
    ).NODE_OPTIONS?.match(/--experimental-sqlite/g)).toHaveLength(1);
    expect(buildSqliteChildEnvironment(
      { NODE_OPTIONS: '--experimental-sqlite-extra' },
      '22.11.0',
    ).NODE_OPTIONS).toBe('--experimental-sqlite-extra --experimental-sqlite');
    expect(() => buildSqliteChildEnvironment(
      { NODE_OPTIONS: '--no-experimental-sqlite' },
      '22.11.0',
    )).toThrow('conflicts with required SQLite support');
    expect(() => buildSqliteChildEnvironment(
      { NODE_OPTIONS: '--no-experimental-sqlite' },
      '22.13.0',
    )).toThrow('conflicts with required SQLite support');
    expect(() => buildSqliteChildEnvironment(
      { NODE_OPTIONS: '--no-experimental-sqlite' },
      '24.0.0',
    )).toThrow('conflicts with required SQLite support');
  });

  it('rejects a stable-Node SQLite disable flag before starting supervised work', async () => {
    const test = harness();
    const loadIndexerBuilder = vi.fn(async () => test.builder);

    await expect(startSupervisor({
      mode: 'dev',
      cwd: test.cwd,
      environment: { AGENT_SCOPE_CACHE_DIR: test.cacheDir, NODE_ENV: 'test', NODE_OPTIONS: '--no-experimental-sqlite' },
      nodeVersion: '22.13.0',
      spawnProcess: test.spawnProcess as never,
      waitUntilReady: test.waitUntilReady,
      loadIndexerBuilder: loadIndexerBuilder as never,
      exitProcess: vi.fn() as unknown as (code: number) => never,
    })).rejects.toThrow('conflicts with required SQLite support');

    expect(loadIndexerBuilder).not.toHaveBeenCalled();
    expect(test.builder.watchIndexerBuilds).not.toHaveBeenCalled();
    expect(test.spawnProcess).not.toHaveBeenCalled();
  });

  it('deploys successful dev generations serially without overlapping indexers', async () => {
    const test = harness();
    const supervisor = await startSupervisor({
      mode: 'dev',
      cwd: test.cwd,
      environment: { AGENT_SCOPE_CACHE_DIR: test.cacheDir, NODE_ENV: 'test' },
      spawnProcess: test.spawnProcess as never,
      waitUntilReady: test.waitUntilReady,
      loadIndexerBuilder: (async () => test.builder) as never,
      exitProcess: vi.fn() as unknown as (code: number) => never,
    });

    expect(test.events.slice(0, 5)).toEqual([
      'watch',
      'write:1',
      expect.stringMatching(/^spawn:indexer:/),
      'ready',
      expect.stringMatching(/^spawn:next:/),
    ]);
    const initialNext = supervisor.getNext();

    await Promise.all([
      test.getNotifyBuild()(successfulBuild(2)),
      test.getNotifyBuild()(successfulBuild(3)),
    ]);

    expect(test.builder.writeIndexerBuild).toHaveBeenCalledTimes(3);
    expect(test.events.filter(event => event === 'send:indexer:shutdown')).toHaveLength(2);
    expect(test.children.filter(child => child === initialNext)).toHaveLength(1);
    expect(supervisor.getNext()).toBe(initialNext);
    expect(test.activeIndexers).toHaveLength(1);
    expect(test.getMaxActiveIndexers()).toBe(1);

    await supervisor.stop();
    expect(test.watcher.dispose).toHaveBeenCalledOnce();
  });

  it('keeps the running dev sidecar when a rebuild fails', async () => {
    const test = harness();
    const supervisor = await startSupervisor({
      mode: 'dev',
      cwd: test.cwd,
      environment: { AGENT_SCOPE_CACHE_DIR: test.cacheDir, NODE_ENV: 'test' },
      spawnProcess: test.spawnProcess as never,
      waitUntilReady: test.waitUntilReady,
      loadIndexerBuilder: (async () => test.builder) as never,
      exitProcess: vi.fn() as unknown as (code: number) => never,
      logger: { error: vi.fn() } as never,
    });
    const indexer = supervisor.getIndexer();

    await test.getNotifyBuild()({ errors: [{}], warnings: [], outputFiles: [] } as never);

    expect(supervisor.getIndexer()).toBe(indexer);
    expect(test.builder.writeIndexerBuild).toHaveBeenCalledOnce();
    expect(test.events).not.toContain('send:indexer:shutdown');
    await supervisor.stop();
  });

  it('force-kills a stuck POSIX sidecar before launching its replacement', async () => {
    const test = harness({ ignoreGracefulIndexer: true });
    const supervisor = await startSupervisor({
      mode: 'dev',
      cwd: test.cwd,
      environment: { AGENT_SCOPE_CACHE_DIR: test.cacheDir, NODE_ENV: 'test' },
      platform: 'linux',
      spawnProcess: test.spawnProcess as never,
      waitUntilReady: test.waitUntilReady,
      loadIndexerBuilder: (async () => test.builder) as never,
      exitProcess: vi.fn() as unknown as (code: number) => never,
      stopTimeoutMs: 1,
      killTimeoutMs: 20,
    });
    const initialIndexer = supervisor.getIndexer();

    await test.getNotifyBuild()(successfulBuild(2));

    expect(test.events).toContain('send:indexer:shutdown');
    expect(test.events).toContain('kill:indexer:SIGKILL');
    expect(supervisor.getIndexer()).not.toBe(initialIndexer);
    expect(test.activeIndexers).toHaveLength(1);
    expect(test.getMaxActiveIndexers()).toBe(1);
    await supervisor.stop();
  });

  it('uses prebuilt artifacts in start mode without loading the dev builder', async () => {
    const test = harness();
    const loadIndexerBuilder = vi.fn(async () => {
      throw new Error('start mode must not load esbuild');
    });
    const supervisor = await startSupervisor({
      mode: 'start',
      cwd: test.cwd,
      environment: { AGENT_SCOPE_CACHE_DIR: test.cacheDir, NODE_ENV: 'test' },
      spawnProcess: test.spawnProcess as never,
      waitUntilReady: test.waitUntilReady,
      loadIndexerBuilder,
      exitProcess: vi.fn() as unknown as (code: number) => never,
    });

    expect(loadIndexerBuilder).not.toHaveBeenCalled();
    expect(test.events).toEqual([
      expect.stringMatching(/^spawn:indexer:/),
      'ready',
      expect.stringMatching(/^spawn:next:/),
    ]);
    fs.mkdirSync(test.cacheDir, { recursive: true });
    const lockPath = path.join(test.cacheDir, 'agentscope-session-index-v1.db.indexer.lock');
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999_999 }));
    await supervisor.stop();
    expect(fs.existsSync(lockPath)).toBe(true);
  });
});
