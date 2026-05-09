import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getManagedClaudeSession,
  resetManagedClaudeSessionsForTests,
  sendTextToManagedClaudeSession,
  resizeManagedClaudeSession,
  startManagedClaudeResume,
  writeDataToManagedClaudeSession,
} from '@/lib/claude-data/managed-pty';

const {
  killMock,
  onDataMock,
  onExitMock,
  resizeMock,
  spawnMock,
  writeMock,
} = vi.hoisted(() => ({
  killMock: vi.fn(),
  onDataMock: vi.fn(),
  onExitMock: vi.fn(),
  resizeMock: vi.fn(),
  spawnMock: vi.fn(),
  writeMock: vi.fn(),
}));

vi.mock('node-pty', () => ({
  spawn: spawnMock,
}));

function mockPlatform(platform: NodeJS.Platform) {
  vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);
}

describe('managed PTY sessions', () => {
  const sessionId = '00000000-0000-4000-8000-000000000123';

  beforeEach(() => {
    resetManagedClaudeSessionsForTests();
    killMock.mockReset();
    onDataMock.mockReset();
    onExitMock.mockReset();
    resizeMock.mockReset();
    spawnMock.mockReset();
    writeMock.mockReset();
    spawnMock.mockReturnValue({
      pid: 1234,
      write: writeMock,
      resize: resizeMock,
      onData: onDataMock,
      onExit: onExitMock,
      kill: killMock,
    });
  });

  it('starts Claude resume inside a PTY from the provided cwd', async () => {
    mockPlatform('linux');

    const snapshot = await startManagedClaudeResume(sessionId, '/work/project');

    expect(spawnMock).toHaveBeenCalledWith(
      process.env.SHELL || '/bin/bash',
      ['-lc', `claude --resume ${sessionId}`],
      expect.objectContaining({
        cwd: '/work/project',
        cols: 120,
        rows: 32,
      }),
    );
    expect(snapshot).toMatchObject({
      sessionId,
      cwd: '/work/project',
      pid: 1234,
      isRunning: true,
    });
  });

  it('sends prompt text followed by Enter to the managed PTY', async () => {
    await startManagedClaudeResume(sessionId, '/work/project');

    const snapshot = sendTextToManagedClaudeSession(sessionId, 'Continue please.');

    expect(snapshot?.isRunning).toBe(true);
    expect(writeMock).toHaveBeenNthCalledWith(1, 'Continue please.');
    expect(writeMock).toHaveBeenNthCalledWith(2, '\r');
  });

  it('writes raw terminal data without altering control sequences', async () => {
    await startManagedClaudeResume(sessionId, '/work/project');

    const snapshot = writeDataToManagedClaudeSession(sessionId, '\u001b[A');

    expect(snapshot?.isRunning).toBe(true);
    expect(writeMock).toHaveBeenCalledWith('\u001b[A');
  });

  it('resizes the managed PTY', async () => {
    await startManagedClaudeResume(sessionId, '/work/project');

    const snapshot = resizeManagedClaudeSession(sessionId, 132, 43);

    expect(snapshot).toMatchObject({ cols: 132, rows: 43 });
    expect(resizeMock).toHaveBeenCalledWith(132, 43);
  });

  it('captures terminal output and exit status', async () => {
    await startManagedClaudeResume(sessionId, '/work/project');
    const onData = onDataMock.mock.calls[0][0] as (data: string) => void;
    const onExit = onExitMock.mock.calls[0][0] as (event: { exitCode: number }) => void;

    onData('Claude says hello');
    expect(getManagedClaudeSession(sessionId)?.output).toContain('Claude says hello');

    onExit({ exitCode: 0 });
    expect(getManagedClaudeSession(sessionId)).toMatchObject({
      isRunning: false,
      exitCode: 0,
    });
    expect(sendTextToManagedClaudeSession(sessionId, 'after exit')).toBeNull();
  });
});
