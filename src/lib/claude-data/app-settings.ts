import fs from 'fs';
import path from 'path';
import { getImportDir } from './data-source';

export type ResumeTransport = 'msys2-launch' | 'pty';

export interface AppSettings {
  resumeTransport: ResumeTransport;
}

export interface AppSettingsInfo extends AppSettings {
  resumeTransportSource: 'stored' | 'env' | 'default';
  envResumeTransport?: ResumeTransport;
}

const SETTINGS_FILE = 'settings.json';
const DEFAULT_WINDOWS_RESUME_TRANSPORT: ResumeTransport = 'msys2-launch';
const DEFAULT_POSIX_RESUME_TRANSPORT: ResumeTransport = 'pty';

function getSettingsDir(): string {
  return process.env.CLAUD_OMETER_SETTINGS_DIR?.trim() || path.join(getImportDir(), 'settings');
}

function getSettingsPath(): string {
  return path.join(getSettingsDir(), SETTINGS_FILE);
}

export function parseResumeTransport(value: unknown): ResumeTransport | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (
    normalized === 'msys2-launch'
    || normalized === 'launch'
    || normalized === 'msys2'
    || normalized === 'msys2-tmux'
    || normalized === 'tmux'
  ) {
    return 'msys2-launch';
  }
  if (normalized === 'pty' || normalized === 'managed-pty') return 'pty';
  return null;
}

function defaultResumeTransport(): ResumeTransport {
  return process.platform === 'win32' ? DEFAULT_WINDOWS_RESUME_TRANSPORT : DEFAULT_POSIX_RESUME_TRANSPORT;
}

function readStoredSettings(): Partial<AppSettings> {
  const settingsPath = getSettingsPath();
  if (!fs.existsSync(settingsPath)) return {};

  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as Partial<AppSettings>;
    return {
      resumeTransport: parseResumeTransport(parsed.resumeTransport) || undefined,
    };
  } catch {
    return {};
  }
}

export function getAppSettings(): AppSettingsInfo {
  const envResumeTransport = parseResumeTransport(process.env.CLAUD_OMETER_RESUME_TRANSPORT);
  if (envResumeTransport) {
    return {
      resumeTransport: envResumeTransport,
      resumeTransportSource: 'env',
      envResumeTransport,
    };
  }

  const stored = readStoredSettings();
  if (stored.resumeTransport) {
    return {
      resumeTransport: stored.resumeTransport,
      resumeTransportSource: 'stored',
    };
  }

  return {
    resumeTransport: defaultResumeTransport(),
    resumeTransportSource: 'default',
  };
}

export function setAppSettings(settings: Partial<AppSettings>): AppSettingsInfo {
  const current = readStoredSettings();
  const next: Partial<AppSettings> = { ...current };

  if ('resumeTransport' in settings) {
    const resumeTransport = parseResumeTransport(settings.resumeTransport);
    if (!resumeTransport) {
      throw new Error('Invalid resume transport');
    }
    next.resumeTransport = resumeTransport;
  }

  const settingsDir = getSettingsDir();
  fs.mkdirSync(settingsDir, { recursive: true });
  fs.writeFileSync(getSettingsPath(), JSON.stringify(next, null, 2));
  return getAppSettings();
}
