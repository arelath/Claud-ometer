import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getMsys2LaunchAvailability,
  resetManagedMsys2LaunchSessionsForTests,
  startMsys2ClaudeResume,
} from '@/lib/claude-data/msys2-launch';

const { spawnMock, unrefMock, killMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  unrefMock: vi.fn(),
  killMock: vi.fn(),
}));

vi.mock('child_process', () => ({
  spawn: spawnMock,
  default: { spawn: spawnMock },
}));

function makeChild(pid: number) {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    unref: ReturnType<typeof vi.fn>;
    kill: ReturnType<typeof vi.fn>;
  };
  child.pid = pid;
  child.unref = unrefMock;
  child.kill = killMock;
  return child;
}

describe('MSYS2 Claude launch', () => {
  const msysRoot = path.join(process.cwd(), '.test-artifacts', 'msys2');
  const sessionId = '5abbc741-420b-40fc-9c5d-0a3cc4731b6b';
  const previousRoot = process.env.AGENT_SCOPE_MSYS2_ROOT;
  let nextPid = 1000;

  beforeEach(() => {
    resetManagedMsys2LaunchSessionsForTests();
    fs.rmSync(msysRoot, { recursive: true, force: true });
    fs.mkdirSync(path.join(msysRoot, 'usr', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(msysRoot, 'usr', 'bin', 'bash.exe'), '');
    fs.writeFileSync(path.join(msysRoot, 'usr', 'bin', 'mintty.exe'), '');
    process.env.AGENT_SCOPE_MSYS2_ROOT = msysRoot;
    spawnMock.mockReset();
    unrefMock.mockReset();
    killMock.mockReset();
    nextPid = 1000;
    spawnMock.mockImplementation(() => makeChild(nextPid++));
  });

  afterEach(() => {
    resetManagedMsys2LaunchSessionsForTests();
    fs.rmSync(msysRoot, { recursive: true, force: true });
    if (previousRoot == null) delete process.env.AGENT_SCOPE_MSYS2_ROOT;
    else process.env.AGENT_SCOPE_MSYS2_ROOT = previousRoot;
  });

  it('reports MSYS2 launch availability from the configured root', () => {
    expect(getMsys2LaunchAvailability()).toMatchObject({
      available: true,
      root: msysRoot,
    });
  });

  it('starts Claude directly in a visible mintty window', () => {
    const snapshot = startMsys2ClaudeResume(sessionId, 'D:\\dev\\project');

    expect(snapshot).toMatchObject({
      sessionId,
      transport: 'msys2-launch',
      isRunning: true,
      windowPid: 1000,
    });
    expect(spawnMock).toHaveBeenCalledWith(
      path.join(msysRoot, 'usr', 'bin', 'mintty.exe'),
      expect.arrayContaining([
        path.join(msysRoot, 'usr', 'bin', 'bash.exe'),
        '-lc',
        expect.stringContaining('exec "$claude_cmd" --resume "$resume_id"'),
        'agentscope',
        'D:\\dev\\project',
        sessionId,
      ]),
      expect.objectContaining({
        detached: true,
        windowsHide: false,
      }),
    );
    const allArgs = spawnMock.mock.calls.flatMap(call => call[1]);
    expect(allArgs).not.toEqual(expect.arrayContaining([
      expect.stringContaining('tmux'),
      expect.stringContaining('attach-session'),
      expect.stringContaining('new-session'),
    ]));
    expect(unrefMock).toHaveBeenCalledTimes(1);
  });

  it('starts another Claude process when launch is requested again', () => {
    startMsys2ClaudeResume(sessionId, 'D:\\dev\\project');

    const snapshot = startMsys2ClaudeResume(sessionId, 'D:\\dev\\project');

    expect(snapshot).toMatchObject({
      sequence: 2,
      windowPid: 1001,
    });
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });
});
