import { describe, expect, it } from 'vitest';
import { parseTmuxPaneList, resolveTmuxTargetFromPanes } from '@/lib/claude-data/tmux-live-input';

describe('tmux live input helpers', () => {
  it('parses tmux pane output', () => {
    const panes = parseTmuxPaneList([
      '%1\t100\tclaude\tD:/dev/project\tclaude-live:0.0',
      'malformed',
      '%2\t200\tbash\tD:/dev/other\tother:0.0',
      '',
    ].join('\n'));

    expect(panes).toEqual([
      {
        paneId: '%1',
        panePid: 100,
        command: 'claude',
        cwd: 'D:/dev/project',
        target: 'claude-live:0.0',
      },
      {
        paneId: '%2',
        panePid: 200,
        command: 'bash',
        cwd: 'D:/dev/other',
        target: 'other:0.0',
      },
    ]);
  });

  it('resolves a pane by live session process ancestry', () => {
    const target = resolveTmuxTargetFromPanes(
      {
        sessionId: '00000000-0000-4000-8000-000000000123',
        pid: 120,
        cwd: 'D:\\dev\\project',
      },
      [
        { paneId: '%1', panePid: 100, command: 'bash', cwd: 'D:/dev/project', target: 'project:0.0' },
        { paneId: '%2', panePid: 200, command: 'bash', cwd: 'D:/dev/project', target: 'project:0.1' },
      ],
      new Map([
        [120, 110],
        [110, 100],
      ]),
    );

    expect(target).toBe('%1');
  });

  it('uses cwd to disambiguate multiple process-ancestry matches', () => {
    const target = resolveTmuxTargetFromPanes(
      {
        sessionId: '00000000-0000-4000-8000-000000000123',
        pid: 130,
        cwd: 'D:\\dev\\project',
      },
      [
        { paneId: '%1', panePid: 100, command: 'bash', cwd: 'D:/dev/other', target: 'project:0.0' },
        { paneId: '%2', panePid: 110, command: 'bash', cwd: 'D:/dev/project', target: 'project:0.1' },
      ],
      new Map([
        [130, 120],
        [120, 110],
        [110, 100],
      ]),
    );

    expect(target).toBe('%2');
  });

  it('uses a single Claude pane in the same cwd as a fallback', () => {
    const target = resolveTmuxTargetFromPanes(
      {
        sessionId: '00000000-0000-4000-8000-000000000123',
        cwd: 'D:\\dev\\project',
      },
      [
        { paneId: '%1', panePid: 100, command: 'bash', cwd: 'D:/dev/project', target: 'project:0.0' },
        { paneId: '%2', panePid: 200, command: 'claude', cwd: 'D:/dev/project', target: 'project:0.1' },
      ],
    );

    expect(target).toBe('%2');
  });

  it('matches Claude on Windows when using cwd fallback', () => {
    const target = resolveTmuxTargetFromPanes(
      {
        sessionId: '00000000-0000-4000-8000-000000000123',
        cwd: 'D:\\dev\\project',
      },
      [
        { paneId: '%1', panePid: 100, command: 'powershell', cwd: 'D:/dev/project', target: 'project:0.0' },
        { paneId: '%2', panePid: 200, command: 'claude.exe', cwd: 'D:/dev/project', target: 'project:0.1' },
      ],
    );

    expect(target).toBe('%2');
  });

  it('does not guess when multiple cwd matches are ambiguous', () => {
    const target = resolveTmuxTargetFromPanes(
      {
        sessionId: '00000000-0000-4000-8000-000000000123',
        cwd: 'D:\\dev\\project',
      },
      [
        { paneId: '%1', panePid: 100, command: 'bash', cwd: 'D:/dev/project', target: 'project:0.0' },
        { paneId: '%2', panePid: 200, command: 'zsh', cwd: 'D:/dev/project', target: 'project:0.1' },
      ],
    );

    expect(target).toBeNull();
  });
});
