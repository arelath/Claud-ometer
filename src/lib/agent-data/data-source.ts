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

function parseAgentList(value: string | undefined): AgentKind[] {
  if (!value?.trim()) return [];
  return normalizeAgents(value.split(',').map(item => item.trim().toLowerCase()));
}

function readSourceSettings(): SourceSettings {
  const settingsPath = getSourceSettingsPath();
  if (!fs.existsSync(settingsPath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    return { agents: normalizeAgents(parsed?.agents) };
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

export function getAgentDataDir(agentKind: AgentKind, mode: DataSourceMode = getActiveDataSource()): string {
  if (mode === 'imported') {
    const importDir = getImportDir();
    const newRoot = path.join(importDir, 'agent-data', agentKind);
    if (fs.existsSync(newRoot)) return newRoot;
    if (agentKind === 'claude') return path.join(importDir, 'claude-data');
    return path.join(importDir, 'codex-data');
  }

  return agentKind === 'claude' ? getLiveClaudeDir() : getLiveCodexDir();
}

export function getDetectedAgents(mode: DataSourceMode = getActiveDataSource()): AgentKind[] {
  return AGENT_KINDS.filter(agent => fs.existsSync(getAgentDataDir(agent, mode)));
}

export function getSelectedAgents(mode: DataSourceMode = getActiveDataSource()): AgentKind[] {
  const envAgents = parseAgentList(process.env.CLAUD_OMETER_AGENTS);
  if (envAgents.length > 0) return envAgents;

  const savedAgents = readSourceSettings().agents || [];
  if (savedAgents.length > 0) return savedAgents;

  const importMetaAgents = mode === 'imported' ? normalizeAgents(getImportMeta()?.agents) : [];
  if (importMetaAgents.length > 0) return importMetaAgents;

  const detected = getDetectedAgents(mode);
  if (detected.includes('claude')) return ['claude'];
  if (detected.includes('codex')) return ['codex'];
  return ['claude'];
}

export function setSelectedAgents(agents: AgentKind[]): void {
  const normalized = normalizeAgents(agents);
  writeSourceSettings({ agents: normalized.length > 0 ? normalized : ['claude'] });
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
