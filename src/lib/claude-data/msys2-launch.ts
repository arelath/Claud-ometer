import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';

export interface Msys2Install {
  root: string;
  bashPath: string;
  minttyPath: string;
}

export interface Msys2LaunchAvailability {
  available: boolean;
  root?: string;
  bashPath?: string;
  minttyPath?: string;
  error?: string;
}

export interface ManagedMsys2LaunchSnapshot {
  sessionId: string;
  cwd: string;
  startedAt: string;
  updatedAt: string;
  sequence: number;
  isRunning: boolean;
  transport: 'msys2-launch';
  windowPid?: number;
}

interface ManagedMsys2LaunchEntry {
  sessionId: string;
  cwd: string;
  install: Msys2Install;
  startedAtMs: number;
  updatedAtMs: number;
  sequence: number;
  windowProcess?: ChildProcess;
  windowPid?: number;
}

interface ManagedMsys2LaunchStore {
  sessions: Map<string, ManagedMsys2LaunchEntry>;
}

const globalStoreKey = Symbol.for('claudometer.managedMsys2LaunchSessions');

const LAUNCH_CLAUDE_SCRIPT = `
set -euo pipefail
cwd_windows="$1"
resume_id="$2"
cwd_posix="$(cygpath -u "$cwd_windows")"
cd "$cwd_posix"
claude_cmd=""
if command -v claude >/dev/null 2>&1; then
  claude_cmd="$(command -v claude)"
elif command -v claude.cmd >/dev/null 2>&1; then
  claude_cmd="$(command -v claude.cmd)"
elif [ -n "\${APPDATA:-}" ] && [ -f "$(cygpath -u "$APPDATA")/npm/claude.cmd" ]; then
  claude_cmd="$(cygpath -u "$APPDATA")/npm/claude.cmd"
fi
if [ -z "$claude_cmd" ]; then
  echo "claude or claude.cmd is not available inside the MSYS2 shell PATH." >&2
  echo "Press Enter to close this window." >&2
  read -r _ || true
  exit 127
fi
exec "$claude_cmd" --resume "$resume_id"
`;

function getStore(): ManagedMsys2LaunchStore {
  const globalValue = globalThis as typeof globalThis & { [globalStoreKey]?: ManagedMsys2LaunchStore };
  if (!globalValue[globalStoreKey]) {
    globalValue[globalStoreKey] = { sessions: new Map() };
  }
  return globalValue[globalStoreKey];
}

function getMsys2Bin(root: string, executable: string): string {
  return path.join(root, 'usr', 'bin', executable);
}

function normalizeRoot(root: string): string {
  return path.resolve(root.trim().replace(/^"|"$/g, ''));
}

function rootFromBashPath(bashPath: string): string {
  return path.resolve(path.dirname(bashPath), '..', '..');
}

function candidateRoots(): string[] {
  const candidates: string[] = [];
  const push = (value: string | undefined) => {
    if (value?.trim()) candidates.push(normalizeRoot(value));
  };

  push(process.env.CLAUD_OMETER_MSYS2_ROOT);
  push(process.env.CLAUD_OMETER_ELECTRON_RESOURCES_DIR
    ? path.join(process.env.CLAUD_OMETER_ELECTRON_RESOURCES_DIR, 'msys2')
    : undefined);
  push(path.join(process.cwd(), 'vendor', 'msys2'));
  push(path.join(process.cwd(), 'vender', 'msys2'));
  push(path.join(process.cwd(), 'resources', 'msys2'));
  push('C:\\msys64');
  push('C:\\tools\\msys64');
  push(process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'msys64') : undefined);
  push(process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'msys64') : undefined);

  return Array.from(new Set(candidates));
}

function getInstallFromRoot(root: string): Msys2Install | null {
  const bashPath = getMsys2Bin(root, 'bash.exe');
  const minttyPath = getMsys2Bin(root, 'mintty.exe');
  if (!fs.existsSync(bashPath) || !fs.existsSync(minttyPath)) return null;
  return { root, bashPath, minttyPath };
}

export function resolveMsys2Install(): Msys2Install {
  const explicitBashPath = process.env.CLAUD_OMETER_MSYS2_BASH?.trim();
  if (explicitBashPath) {
    const bashPath = path.resolve(explicitBashPath.replace(/^"|"$/g, ''));
    const root = rootFromBashPath(bashPath);
    const minttyPath = process.env.CLAUD_OMETER_MSYS2_MINTTY?.trim()
      ? path.resolve(process.env.CLAUD_OMETER_MSYS2_MINTTY.trim().replace(/^"|"$/g, ''))
      : getMsys2Bin(root, 'mintty.exe');

    if (!fs.existsSync(bashPath)) {
      throw new Error(`MSYS2 bash was not found at ${bashPath}.`);
    }
    if (!fs.existsSync(minttyPath)) {
      throw new Error(`MSYS2 mintty was not found at ${minttyPath}.`);
    }
    return { root, bashPath, minttyPath };
  }

  for (const root of candidateRoots()) {
    const install = getInstallFromRoot(root);
    if (install) return install;
  }

  throw new Error('MSYS2 with bash.exe and mintty.exe was not found. Install MSYS2 to C:\\msys64, set CLAUD_OMETER_MSYS2_ROOT, or bundle it under resources/msys2.');
}

export function getMsys2LaunchAvailability(): Msys2LaunchAvailability {
  try {
    const install = resolveMsys2Install();
    return {
      available: true,
      root: install.root,
      bashPath: install.bashPath,
      minttyPath: install.minttyPath,
    };
  } catch (error) {
    return {
      available: false,
      error: error instanceof Error ? error.message : 'MSYS2 launch is unavailable.',
    };
  }
}

function getMsys2Env(install: Msys2Install): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CHERE_INVOKING: '1',
    MSYSTEM: process.env.CLAUD_OMETER_MSYS2_SYSTEM || 'UCRT64',
    MSYS2_PATH_TYPE: process.env.MSYS2_PATH_TYPE || 'inherit',
    CLAUD_OMETER_MSYS2_ROOT_RESOLVED: install.root,
  };
}

function openClaudeWindow(install: Msys2Install, sessionId: string, cwd: string): ChildProcess {
  const child = spawn(
    install.minttyPath,
    [
      '--title',
      `Claude ${sessionId.slice(0, 8)}`,
      install.bashPath,
      '-lc',
      LAUNCH_CLAUDE_SCRIPT,
      'claudometer',
      cwd,
      sessionId,
    ],
    {
      cwd: install.root,
      detached: true,
      env: getMsys2Env(install),
      stdio: 'ignore',
      windowsHide: false,
    },
  );
  child.unref();
  return child;
}

function toSnapshot(entry: ManagedMsys2LaunchEntry): ManagedMsys2LaunchSnapshot {
  return {
    sessionId: entry.sessionId,
    cwd: entry.cwd,
    startedAt: new Date(entry.startedAtMs).toISOString(),
    updatedAt: new Date(entry.updatedAtMs).toISOString(),
    sequence: entry.sequence,
    isRunning: true,
    transport: 'msys2-launch',
    windowPid: entry.windowPid,
  };
}

export function startMsys2ClaudeResume(
  sessionId: string,
  cwd: string,
): ManagedMsys2LaunchSnapshot {
  const install = resolveMsys2Install();
  const store = getStore();
  const existing = store.sessions.get(sessionId);
  const windowProcess = openClaudeWindow(install, sessionId, cwd);
  const now = Date.now();

  if (existing) {
    existing.cwd = cwd;
    existing.install = install;
    existing.windowProcess = windowProcess;
    existing.windowPid = windowProcess.pid;
    existing.updatedAtMs = now;
    existing.sequence += 1;
    return toSnapshot(existing);
  }

  const entry: ManagedMsys2LaunchEntry = {
    sessionId,
    cwd,
    install,
    startedAtMs: now,
    updatedAtMs: now,
    sequence: 1,
    windowProcess,
    windowPid: windowProcess.pid,
  };
  store.sessions.set(sessionId, entry);
  return toSnapshot(entry);
}

export function resetManagedMsys2LaunchSessionsForTests(): void {
  for (const entry of getStore().sessions.values()) {
    try {
      entry.windowProcess?.kill();
    } catch {
      // Best-effort cleanup for mocked and real child processes in tests.
    }
  }
  getStore().sessions.clear();
}
