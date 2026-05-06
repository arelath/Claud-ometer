import { spawn } from 'child_process';
import type { SpawnOptions } from 'child_process';

const SESSION_ID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function isValidResumeSessionId(sessionId: string): boolean {
  return SESSION_ID_PATTERN.test(sessionId);
}

function getSpawnOptions(cwd?: string): SpawnOptions {
  return {
    detached: true,
    stdio: 'ignore',
    ...(cwd ? { cwd } : {}),
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function escapeAppleScriptString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function launchClaudeResume(sessionId: string, cwd?: string): void {
  if (!isValidResumeSessionId(sessionId)) {
    throw new Error('Invalid session id');
  }

  const platform = process.platform;

  if (platform === 'win32') {
    const child = spawn(
      'cmd.exe',
      cwd
        ? ['/c', 'start', 'Claude Resume', '/D', cwd, 'cmd.exe', '/k', 'claude', '--resume', sessionId]
        : ['/c', 'start', 'Claude Resume', 'cmd.exe', '/k', 'claude', '--resume', sessionId],
      { ...getSpawnOptions(cwd), windowsHide: false },
    );
    child.unref();
    return;
  }

  if (platform === 'darwin') {
    const command = cwd
      ? `cd ${shellQuote(cwd)} && claude --resume ${sessionId}`
      : `claude --resume ${sessionId}`;
    const child = spawn(
      'osascript',
      ['-e', `tell application "Terminal" to do script "${escapeAppleScriptString(command)}"`],
      getSpawnOptions(cwd),
    );
    child.unref();
    return;
  }

  const terminal = process.env.TERMINAL?.trim() || 'x-terminal-emulator';
  const command = cwd
    ? `cd ${shellQuote(cwd)} && claude --resume ${sessionId}; exec bash`
    : `claude --resume ${sessionId}; exec bash`;
  const child = spawn(
    terminal,
    ['-e', 'bash', '-lc', command],
    getSpawnOptions(cwd),
  );
  child.unref();
}
