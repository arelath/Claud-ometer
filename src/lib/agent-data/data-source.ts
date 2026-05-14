import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AgentKind } from './types';
import { AGENT_KINDS, isAgentKind } from './types';

export type DataSourceMode = 'live' | 'imported';

export interface ImportMeta {
  importedAt: string;
  exportedAt: string;
  exportedFrom: string;
  projectCount: number;
  sessionCount: number;
  fileCount?: number;
  totalSize?: number;
  agents?: AgentKind[];
  agentCounts?: Partial<Record<AgentKind, { projectCount: number; sessionCount: number }>>;
}

export interface AgentDataSourceInfo {
  active: DataSourceMode;
  agents: AgentKind[];
  detectedAgents: AgentKind[];
  hasImportedData: boolean;
  importMeta: ImportMeta | null;
}

interface SourceSettings {
  agents?: AgentKind[];
}

function resolveImportDir(): string {
  return process.env.CLAUD_OMETER_IMPORT_DIR?.trim() || path.join(process.cwd(), '.dashboard-data');
}

function getImportMetaPath(): string {
  return path.join(resolveImportDir(), 'meta.json');
}

function getSourceSettingsPath(): string {
  return path.join(resolveImportDir(), 'source-settings.json');
}

function getUseImportedFlagPath(): string {
  return path.join(resolveImportDir(), '.use-imported');
}

function normalizeAgents(agents: unknown): AgentKind[] {
  if (!Array.isArray(agents)) return [];
  const seen = new Set<AgentKind>();
  for (const agent of agents) {
    if (isAgentKind(agent)) seen.add(agent);
  }
  return AGENT_KINDS.filter(agent => seen.has(agent));
}

function parseAgentList(value: string | undefined): AgentKind[] | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === 'none' || normalized === 'off') return [];
  const agents = normalizeAgents(normalized.split(',').map(item => item.trim()));
  return agents.length > 0 ? agents : undefined;
}

function readSourceSettings(): SourceSettings {
  const settingsPath = getSourceSettingsPath();
  if (!fs.existsSync(settingsPath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    return Array.isArray(parsed?.agents)
      ? { agents: normalizeAgents(parsed.agents) }
      : {};
  } catch {
    return {};
  }
}

function writeSourceSettings(settings: SourceSettings): void {
  const importDir = resolveImportDir();
  if (!fs.existsSync(importDir)) fs.mkdirSync(importDir, { recursive: true });
  fs.writeFileSync(getSourceSettingsPath(), JSON.stringify(settings, null, 2));
}

export function getImportDir(): string {
  return resolveImportDir();
}

export function hasImportedData(): boolean {
  return fs.existsSync(getImportMetaPath());
}

export function getImportMeta(): ImportMeta | null {
  const metaPath = getImportMetaPath();
  if (!fs.existsSync(metaPath)) return null;
  return JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
}

export function getActiveDataSource(): DataSourceMode {
  if (fs.existsSync(getUseImportedFlagPath()) && hasImportedData()) return 'imported';
  return 'live';
}

export function setDataSource(source: DataSourceMode): void {
  const importDir = resolveImportDir();
  const flagPath = getUseImportedFlagPath();
  if (source === 'imported') {
    if (!fs.existsSync(importDir)) fs.mkdirSync(importDir, { recursive: true });
    fs.writeFileSync(flagPath, '1');
  } else if (fs.existsSync(flagPath)) {
    fs.unlinkSync(flagPath);
  }
}

export function clearImportedData(): void {
  const importDir = resolveImportDir();
  if (fs.existsSync(importDir)) {
    fs.rmSync(importDir, { recursive: true, force: true });
  }
}

export function getLiveClaudeDir(): string {
  return process.env.CLAUD_OMETER_CLAUDE_DIR?.trim() || path.join(os.homedir(), '.claude');
}

export function getLiveCodexDir(): string {
  return process.env.CLAUD_OMETER_CODEX_DIR?.trim() || path.join(os.homedir(), '.codex');
}

export function getLiveCopilotDir(): string {
  const explicitRoot = process.env.CLAUD_OMETER_COPILOT_DIR?.trim();
  if (explicitRoot) return explicitRoot;

  const explicitUserDir = process.env.CLAUD_OMETER_COPILOT_VSCODE_USER_DIR?.trim();
  if (explicitUserDir) return explicitUserDir;

  const candidates = process.platform === 'win32'
    ? [
        path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Code', 'User'),
        path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Code - Insiders', 'User'),
      ]
    : process.platform === 'darwin'
      ? [
          path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User'),
          path.join(os.homedir(), 'Library', 'Application Support', 'Code - Insiders', 'User'),
        ]
      : [
          path.join(os.homedir(), '.config', 'Code', 'User'),
          path.join(os.homedir(), '.config', 'Code - Insiders', 'User'),
        ];

  return candidates.find(candidate => hasCopilotData(candidate))
    || candidates.find(candidate => fs.existsSync(candidate))
    || candidates[0];
}

export function getLiveCursorDir(): string {
  return process.env.CLAUD_OMETER_CURSOR_DIR?.trim() || path.join(os.homedir(), '.cursor');
}

function getCopilotWorkspaceStorageDir(copilotDir: string): string {
  return path.basename(copilotDir).toLowerCase() === 'workspacestorage'
    ? copilotDir
    : path.join(copilotDir, 'workspaceStorage');
}

function isCopilotChatSessionFile(filePath: string): boolean {
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const buffer = Buffer.allocUnsafe(32 * 1024);
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
      return /GitHub Copilot|copilot\//i.test(buffer.subarray(0, bytesRead).toString('utf-8'));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

function hasCopilotData(copilotDir: string): boolean {
  const workspaceStorageDir = getCopilotWorkspaceStorageDir(copilotDir);
  if (!fs.existsSync(workspaceStorageDir)) return false;

  for (const workspace of fs.readdirSync(workspaceStorageDir, { withFileTypes: true })) {
    if (!workspace.isDirectory()) continue;
    const transcriptsDir = path.join(workspaceStorageDir, workspace.name, 'GitHub.copilot-chat', 'transcripts');
    if (fs.existsSync(transcriptsDir) && fs.readdirSync(transcriptsDir, { withFileTypes: true }).some(entry => entry.isFile() && entry.name.endsWith('.jsonl'))) {
      return true;
    }

    const chatSessionsDir = path.join(workspaceStorageDir, workspace.name, 'chatSessions');
    if (!fs.existsSync(chatSessionsDir)) continue;
    for (const entry of fs.readdirSync(chatSessionsDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.jsonl') && isCopilotChatSessionFile(path.join(chatSessionsDir, entry.name))) {
        return true;
      }
    }
  }

  return false;
}

function getCursorProjectsDir(cursorDir: string): string {
  return path.basename(cursorDir).toLowerCase() === 'projects'
    ? cursorDir
    : path.join(cursorDir, 'projects');
}

function hasCursorData(cursorDir: string): boolean {
  const projectsDir = getCursorProjectsDir(cursorDir);
  if (!fs.existsSync(projectsDir)) return false;

  for (const project of fs.readdirSync(projectsDir, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const transcriptsDir = path.join(projectsDir, project.name, 'agent-transcripts');
    if (!fs.existsSync(transcriptsDir)) continue;

    for (const session of fs.readdirSync(transcriptsDir, { withFileTypes: true })) {
      if (!session.isDirectory()) continue;
      const sessionDir = path.join(transcriptsDir, session.name);
      if (fs.readdirSync(sessionDir, { withFileTypes: true }).some(entry => entry.isFile() && entry.name.endsWith('.jsonl'))) {
        return true;
      }
    }
  }

  return false;
}

export function getAgentDataDir(agentKind: AgentKind, mode: DataSourceMode = getActiveDataSource()): string {
  if (mode === 'imported') {
    const importDir = getImportDir();
    const newRoot = path.join(importDir, 'agent-data', agentKind);
    if (fs.existsSync(newRoot)) return newRoot;
    if (agentKind === 'claude') return path.join(importDir, 'claude-data');
    if (agentKind === 'codex') return path.join(importDir, 'codex-data');
    return newRoot;
  }

  if (agentKind === 'claude') return getLiveClaudeDir();
  if (agentKind === 'codex') return getLiveCodexDir();
  if (agentKind === 'copilot') return getLiveCopilotDir();
  return getLiveCursorDir();
}

export function getDetectedAgents(mode: DataSourceMode = getActiveDataSource()): AgentKind[] {
  return AGENT_KINDS.filter(agent => {
    const agentDir = getAgentDataDir(agent, mode);
    if (agent === 'copilot') return hasCopilotData(agentDir);
    if (agent === 'cursor') return hasCursorData(agentDir);
    return fs.existsSync(agentDir);
  });
}

export function getSelectedAgents(mode: DataSourceMode = getActiveDataSource()): AgentKind[] {
  const envAgents = parseAgentList(process.env.CLAUD_OMETER_AGENTS);
  if (envAgents !== undefined) return envAgents;

  const savedSettings = readSourceSettings();
  if (savedSettings.agents !== undefined) return savedSettings.agents;

  const importMetaAgents = mode === 'imported' ? normalizeAgents(getImportMeta()?.agents) : [];
  if (importMetaAgents.length > 0) return importMetaAgents;

  const detected = getDetectedAgents(mode);
  if (detected.includes('claude')) return ['claude'];
  if (detected.includes('codex')) return ['codex'];
  if (detected.includes('copilot')) return ['copilot'];
  if (detected.includes('cursor')) return ['cursor'];
  return ['claude'];
}

export function setSelectedAgents(agents: AgentKind[]): void {
  const normalized = normalizeAgents(agents);
  writeSourceSettings({ agents: normalized });
}

export function getActiveAgentDataSource(): AgentDataSourceInfo {
  const active = getActiveDataSource();
  const importMeta = getImportMeta();
  return {
    active,
    agents: getSelectedAgents(active),
    detectedAgents: getDetectedAgents(active),
    hasImportedData: hasImportedData(),
    importMeta,
  };
}
