import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isValidResumeSessionId, launchClaudeResume } from '@/lib/claude-data/resume-session';

const { spawnMock, unrefMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  unrefMock: vi.fn(),
}));

vi.mock('child_process', () => ({
  spawn: spawnMock,
  default: { spawn: spawnMock },
}));

function mockPlatform(platform: NodeJS.Platform) {
  vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);
}

describe('resume session helpers', () => {
  const sessionId = '5abbc741-420b-40fc-9c5d-0a3cc4731b6b';
  const cwd = 'D:\\dev\\project';
  const previousTerminal = process.env.TERMINAL;

  beforeEach(() => {
    spawnMock.mockReset();
    unrefMock.mockReset();
    spawnMock.mockReturnValue({ unref: unrefMock });
    if (previousTerminal == null) delete process.env.TERMINAL;
    else process.env.TERMINAL = previousTerminal;
  });

  it('validates resume GUIDs', () => {
    expect(isValidResumeSessionId(sessionId)).toBe(true);
    expect(isValidResumeSessionId('not-a-session')).toBe(false);
    expect(isValidResumeSessionId('5abbc741-420b-40fc-9c5d-0a3cc4731b6b-extra')).toBe(false);
  });

  it('rejects invalid session ids before spawning a process', () => {
    expect(() => launchClaudeResume('not-a-session')).toThrow('Invalid session id');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('launches Claude resume in a new Windows command window', () => {
    mockPlatform('win32');

    launchClaudeResume(sessionId, cwd);

    expect(spawnMock).toHaveBeenCalledWith(
      'cmd.exe',
      ['/c', 'start', 'Claude Resume', '/D', cwd, 'cmd.exe', '/k', 'claude', '--resume', sessionId],
      { cwd, detached: true, stdio: 'ignore', windowsHide: false },
    );
    expect(unrefMock).toHaveBeenCalledTimes(1);
  });

  it('uses the configured terminal on Linux', () => {
    mockPlatform('linux');
    process.env.TERMINAL = 'alacritty';

    launchClaudeResume(sessionId, cwd);

    expect(spawnMock).toHaveBeenCalledWith(
      'alacritty',
      ['-e', 'bash', '-lc', `cd 'D:\\dev\\project' && claude --resume ${sessionId}; exec bash`],
      { cwd, detached: true, stdio: 'ignore' },
    );
    expect(unrefMock).toHaveBeenCalledTimes(1);
  });

  it('launches Claude resume in Terminal on macOS', () => {
    mockPlatform('darwin');

    launchClaudeResume(sessionId, cwd);

    expect(spawnMock).toHaveBeenCalledWith(
      'osascript',
      ['-e', `tell application "Terminal" to do script "cd 'D:\\\\dev\\\\project' && claude --resume ${sessionId}"`],
      { cwd, detached: true, stdio: 'ignore' },
    );
    expect(unrefMock).toHaveBeenCalledTimes(1);
  });

  it('shell-quotes cwd values for POSIX terminals', () => {
    mockPlatform('linux');

    launchClaudeResume(sessionId, "/Users/pat/O'Hara Project");

    expect(spawnMock).toHaveBeenCalledWith(
      'x-terminal-emulator',
      ['-e', 'bash', '-lc', `cd '/Users/pat/O'\\''Hara Project' && claude --resume ${sessionId}; exec bash`],
      { cwd: "/Users/pat/O'Hara Project", detached: true, stdio: 'ignore' },
    );
  });
});
