import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('app settings helpers', () => {
  const settingsDir = path.join(process.cwd(), '.test-artifacts', 'app-settings');
  const previousSettingsDir = process.env.AGENT_SCOPE_SETTINGS_DIR;
  const previousResumeTransport = process.env.AGENT_SCOPE_RESUME_TRANSPORT;
  let platformSpy: { mockRestore: () => void } | null = null;

  beforeEach(() => {
    platformSpy?.mockRestore();
    platformSpy = null;
    fs.rmSync(settingsDir, { recursive: true, force: true });
    process.env.AGENT_SCOPE_SETTINGS_DIR = settingsDir;
    delete process.env.AGENT_SCOPE_RESUME_TRANSPORT;
    vi.resetModules();
  });

  afterEach(() => {
    platformSpy?.mockRestore();
    fs.rmSync(settingsDir, { recursive: true, force: true });
    if (previousSettingsDir == null) delete process.env.AGENT_SCOPE_SETTINGS_DIR;
    else process.env.AGENT_SCOPE_SETTINGS_DIR = previousSettingsDir;
    if (previousResumeTransport == null) delete process.env.AGENT_SCOPE_RESUME_TRANSPORT;
    else process.env.AGENT_SCOPE_RESUME_TRANSPORT = previousResumeTransport;
  });

  it('defaults to MSYS2 launch on Windows and PTY elsewhere', async () => {
    const settings = await import('@/lib/claude-data/app-settings');

    platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    expect(settings.getAppSettings()).toMatchObject({ resumeTransport: 'msys2-launch', resumeTransportSource: 'default' });

    platformSpy.mockRestore();
    platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    expect(settings.getAppSettings()).toMatchObject({ resumeTransport: 'pty', resumeTransportSource: 'default' });
  });

  it('persists the selected resume transport', async () => {
    const settings = await import('@/lib/claude-data/app-settings');

    settings.setAppSettings({ resumeTransport: 'pty' });

    expect(settings.getAppSettings()).toMatchObject({ resumeTransport: 'pty', resumeTransportSource: 'stored' });
    expect(JSON.parse(fs.readFileSync(path.join(settingsDir, 'settings.json'), 'utf-8'))).toEqual({ resumeTransport: 'pty' });
  });

  it('lets an environment value override stored settings', async () => {
    const settings = await import('@/lib/claude-data/app-settings');

    settings.setAppSettings({ resumeTransport: 'pty' });
    process.env.AGENT_SCOPE_RESUME_TRANSPORT = 'msys2-launch';

    expect(settings.getAppSettings()).toMatchObject({ resumeTransport: 'msys2-launch', resumeTransportSource: 'env' });
  });

  it('maps legacy MSYS2 tmux setting values to MSYS2 launch', async () => {
    const settings = await import('@/lib/claude-data/app-settings');

    process.env.AGENT_SCOPE_RESUME_TRANSPORT = 'msys2-tmux';

    expect(settings.getAppSettings()).toMatchObject({ resumeTransport: 'msys2-launch', resumeTransportSource: 'env' });
  });
});
