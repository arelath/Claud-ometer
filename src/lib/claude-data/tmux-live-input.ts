import { spawn } from 'child_process';
import type { LiveSessionInfo } from './types';

export interface TmuxPane {
  paneId: string;
  panePid: number;
  command: string;
  cwd: string;
  target: string;
}

type LiveSessionTarget = Pick<LiveSessionInfo, 'sessionId' | 'pid' | 'cwd'>;

const TMUX_PANE_FORMAT = [
  '#{pane_id}',
  '#{pane_pid}',
  '#{pane_current_command}',
  '#{pane_current_path}',
  '#{session_name}:#{window_index}.#{pane_index}',
].join('\t');

const COMMAND_TIMEOUT_MS = 5_000;

class TmuxCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TmuxCommandError';
  }
}

function runTmux(args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('tmux', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timeout = setTimeout(() => {
      child.kill();
      finish(new TmuxCommandError('tmux command timed out.'));
    }, COMMAND_TIMEOUT_MS);

    function finish(error: Error | null, output = '') {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(output);
    }

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });
    child.on('error', error => {
      const message = 'code' in error && error.code === 'ENOENT'
        ? 'tmux is not available on PATH.'
        : error.message;
      finish(new TmuxCommandError(message));
    });
    child.on('close', code => {
      if (code === 0) {
        finish(null, stdout);
        return;
      }

      finish(new TmuxCommandError(stderr.trim() || `tmux exited with code ${code}.`));
    });

    child.stdin.end(input ?? '');
  });
}

function normalizeComparablePath(value: string | undefined): string {
  return (value || '')
    .replace(/\\/g, '/')
    .replace(/\/+$/g, '')
    .toLowerCase();
}

function commandLooksLikeClaude(command: string): boolean {
  return /\bclaude(?:\.exe)?\b/i.test(command);
}

function isPidDescendant(pid: number, ancestorPid: number, parentByPid: Map<number, number>): boolean {
  if (pid === ancestorPid) return true;

  const seen = new Set<number>();
  let current = pid;
  for (let depth = 0; depth < 256; depth++) {
    if (seen.has(current)) return false;
    seen.add(current);

    const parent = parentByPid.get(current);
    if (!parent || parent === current) return false;
    if (parent === ancestorPid) return true;
    current = parent;
  }

  return false;
}

async function getParentPidMap(): Promise<Map<number, number>> {
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn('ps', ['-eo', 'pid=,ppid='], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let output = '';
      let errorOutput = '';

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        output += chunk;
      });
      child.stderr.on('data', chunk => {
        errorOutput += chunk;
      });
      child.on('error', reject);
      child.on('close', code => {
        if (code === 0) resolve(output);
        else reject(new Error(errorOutput.trim() || `ps exited with code ${code}`));
      });
    });

    const map = new Map<number, number>();
    for (const line of stdout.split(/\r?\n/)) {
      const [pidText, ppidText] = line.trim().split(/\s+/);
      const pid = Number(pidText);
      const ppid = Number(ppidText);
      if (Number.isFinite(pid) && Number.isFinite(ppid)) map.set(pid, ppid);
    }
    return map;
  } catch {
    return new Map();
  }
}

function uniqueStrings(values: (string | undefined)[]): string[] {
  return Array.from(new Set(values.map(value => value?.trim()).filter((value): value is string => Boolean(value))));
}

function getScopedTargetEnvKey(sessionId: string): string {
  return `CLAUD_OMETER_TMUX_TARGET_${sessionId.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}`;
}

async function getPaneIdForTarget(target: string): Promise<string | null> {
  try {
    const paneId = (await runTmux(['display-message', '-p', '-t', target, '#{pane_id}'])).trim();
    return paneId || null;
  } catch {
    return null;
  }
}

async function listTmuxPanes(): Promise<TmuxPane[]> {
  const stdout = await runTmux(['list-panes', '-a', '-F', TMUX_PANE_FORMAT]);
  return parseTmuxPaneList(stdout);
}

function makeBufferName(sessionId: string): string {
  const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32) || 'session';
  return `claudometer-${safeId}-${Date.now()}`;
}

export function parseTmuxPaneList(stdout: string): TmuxPane[] {
  return stdout
    .split(/\r?\n/)
    .map(line => line.trimEnd())
    .filter(Boolean)
    .map(line => {
      const [paneId, pidText, command, cwd, target] = line.split('\t');
      const panePid = Number(pidText);
      if (!paneId || !Number.isFinite(panePid)) return null;
      return {
        paneId,
        panePid,
        command: command || '',
        cwd: cwd || '',
        target: target || paneId,
      };
    })
    .filter((pane): pane is TmuxPane => Boolean(pane));
}

export function resolveTmuxTargetFromPanes(
  session: LiveSessionTarget,
  panes: TmuxPane[],
  parentByPid = new Map<number, number>(),
): string | null {
  if (session.pid) {
    const pidMatches = panes.filter(pane => isPidDescendant(session.pid as number, pane.panePid, parentByPid));
    if (pidMatches.length === 1) return pidMatches[0].paneId;

    const cwd = normalizeComparablePath(session.cwd);
    const pidAndCwdMatches = pidMatches.filter(pane => cwd && normalizeComparablePath(pane.cwd) === cwd);
    if (pidAndCwdMatches.length === 1) return pidAndCwdMatches[0].paneId;
  }

  const cwd = normalizeComparablePath(session.cwd);
  if (!cwd) return null;

  const cwdMatches = panes.filter(pane => normalizeComparablePath(pane.cwd) === cwd);
  const claudeCwdMatches = cwdMatches.filter(pane => commandLooksLikeClaude(pane.command));
  if (claudeCwdMatches.length === 1) return claudeCwdMatches[0].paneId;
  if (cwdMatches.length === 1) return cwdMatches[0].paneId;

  return null;
}

export async function resolveTmuxTarget(session: LiveSessionTarget): Promise<string> {
  const explicitTargets = uniqueStrings([
    process.env[getScopedTargetEnvKey(session.sessionId)],
    process.env.CLAUD_OMETER_TMUX_TARGET,
    session.sessionId,
    session.sessionId.slice(0, 8),
    session.pid?.toString(),
  ]);

  for (const candidate of explicitTargets) {
    const paneId = await getPaneIdForTarget(candidate);
    if (paneId) return paneId;
  }

  const panes = await listTmuxPanes();
  const parentByPid = session.pid ? await getParentPidMap() : new Map<number, number>();
  const resolved = resolveTmuxTargetFromPanes(session, panes, parentByPid);
  if (resolved) return resolved;

  throw new TmuxCommandError('Could not find a tmux pane for this live session.');
}

export async function sendTextToTmuxLiveSession(session: LiveSessionTarget, text: string): Promise<string> {
  const target = await resolveTmuxTarget(session);
  const bufferName = makeBufferName(session.sessionId);

  await runTmux(['load-buffer', '-b', bufferName, '-'], text);
  await runTmux(['paste-buffer', '-d', '-b', bufferName, '-t', target]);
  await runTmux(['send-keys', '-t', target, 'Enter']);

  return target;
}
