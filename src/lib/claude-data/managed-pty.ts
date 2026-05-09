type PtyProcess = {
  pid: number;
  write: (data: string) => void;
  resize?: (cols: number, rows: number) => void;
  onData: (callback: (data: string) => void) => void;
  onExit: (callback: (event: { exitCode: number; signal?: number }) => void) => void;
  kill: () => void;
};

export interface ManagedClaudeSessionSnapshot {
  sessionId: string;
  cwd: string;
  pid?: number;
  cols: number;
  rows: number;
  startedAt: string;
  updatedAt: string;
  exitedAt?: string;
  exitCode?: number;
  output: string;
  sequence: number;
  isRunning: boolean;
}

interface ManagedClaudeSessionEntry {
  sessionId: string;
  cwd: string;
  pty: PtyProcess;
  cols: number;
  rows: number;
  startedAtMs: number;
  updatedAtMs: number;
  exitedAtMs?: number;
  exitCode?: number;
  output: string;
  sequence: number;
}

interface ManagedClaudeStore {
  sessions: Map<string, ManagedClaudeSessionEntry>;
}

const OUTPUT_LIMIT = 200_000;
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 32;
const MIN_COLS = 20;
const MAX_COLS = 400;
const MIN_ROWS = 5;
const MAX_ROWS = 160;
const globalStoreKey = Symbol.for('claudometer.managedClaudePtys');

function getStore(): ManagedClaudeStore {
  const globalValue = globalThis as typeof globalThis & { [globalStoreKey]?: ManagedClaudeStore };
  if (!globalValue[globalStoreKey]) {
    globalValue[globalStoreKey] = { sessions: new Map() };
  }
  return globalValue[globalStoreKey];
}

function appendOutput(entry: ManagedClaudeSessionEntry, chunk: string): void {
  entry.output += chunk;
  if (entry.output.length > OUTPUT_LIMIT) {
    entry.output = entry.output.slice(entry.output.length - OUTPUT_LIMIT);
  }
  entry.updatedAtMs = Date.now();
  entry.sequence += 1;
}

function toSnapshot(entry: ManagedClaudeSessionEntry): ManagedClaudeSessionSnapshot {
  return {
    sessionId: entry.sessionId,
    cwd: entry.cwd,
    pid: entry.pty.pid,
    cols: entry.cols,
    rows: entry.rows,
    startedAt: new Date(entry.startedAtMs).toISOString(),
    updatedAt: new Date(entry.updatedAtMs).toISOString(),
    exitedAt: entry.exitedAtMs ? new Date(entry.exitedAtMs).toISOString() : undefined,
    exitCode: entry.exitCode,
    output: entry.output,
    sequence: entry.sequence,
    isRunning: entry.exitedAtMs == null,
  };
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function getShellCommand(sessionId: string): { command: string; args: string[] } {
  if (process.platform === 'win32') {
    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', `claude --resume ${sessionId}`],
    };
  }

  const shell = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
  return {
    command: shell,
    args: ['-lc', `claude --resume ${sessionId}`],
  };
}

async function loadNodePty(): Promise<{ spawn: (file: string, args: string[], options: Record<string, unknown>) => PtyProcess }> {
  try {
    return await import('node-pty');
  } catch (error) {
    throw new Error(error instanceof Error
      ? `Managed terminal support is unavailable: ${error.message}`
      : 'Managed terminal support is unavailable.');
  }
}

export function getManagedClaudeSession(sessionId: string): ManagedClaudeSessionSnapshot | null {
  const entry = getStore().sessions.get(sessionId);
  return entry ? toSnapshot(entry) : null;
}

export async function startManagedClaudeResume(sessionId: string, cwd: string): Promise<ManagedClaudeSessionSnapshot> {
  const store = getStore();
  const existing = store.sessions.get(sessionId);
  if (existing && existing.exitedAtMs == null) return toSnapshot(existing);

  const pty = await loadNodePty();
  const { command, args } = getShellCommand(sessionId);
  const now = Date.now();
  const terminal = pty.spawn(command, args, {
    name: 'xterm-256color',
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS,
    cwd,
    env: process.env,
  });

  const entry: ManagedClaudeSessionEntry = {
    sessionId,
    cwd,
    pty: terminal,
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS,
    startedAtMs: now,
    updatedAtMs: now,
    output: '',
    sequence: 0,
  };
  store.sessions.set(sessionId, entry);

  terminal.onData((data) => {
    appendOutput(entry, data);
  });
  terminal.onExit((event) => {
    entry.exitedAtMs = Date.now();
    entry.updatedAtMs = entry.exitedAtMs;
    entry.exitCode = event.exitCode;
    entry.sequence += 1;
  });

  return toSnapshot(entry);
}

export function sendTextToManagedClaudeSession(sessionId: string, text: string): ManagedClaudeSessionSnapshot | null {
  const entry = getStore().sessions.get(sessionId);
  if (!entry || entry.exitedAtMs != null) return null;

  entry.pty.write(text);
  entry.pty.write('\r');
  entry.updatedAtMs = Date.now();
  entry.sequence += 1;
  return toSnapshot(entry);
}

export function writeDataToManagedClaudeSession(sessionId: string, data: string): ManagedClaudeSessionSnapshot | null {
  const entry = getStore().sessions.get(sessionId);
  if (!entry || entry.exitedAtMs != null) return null;

  entry.pty.write(data);
  entry.updatedAtMs = Date.now();
  entry.sequence += 1;
  return toSnapshot(entry);
}

export function resizeManagedClaudeSession(sessionId: string, cols: number, rows: number): ManagedClaudeSessionSnapshot | null {
  const entry = getStore().sessions.get(sessionId);
  if (!entry || entry.exitedAtMs != null) return null;

  entry.cols = clampInteger(cols, MIN_COLS, MAX_COLS);
  entry.rows = clampInteger(rows, MIN_ROWS, MAX_ROWS);
  entry.pty.resize?.(entry.cols, entry.rows);
  entry.updatedAtMs = Date.now();
  entry.sequence += 1;
  return toSnapshot(entry);
}

export function resetManagedClaudeSessionsForTests(): void {
  for (const entry of getStore().sessions.values()) {
    if (entry.exitedAtMs == null) {
      try {
        entry.pty.kill();
      } catch {
        // Best-effort cleanup for mocked and real PTYs in tests.
      }
    }
  }
  getStore().sessions.clear();
}
