import path from 'path';
import type { CachedSessionSummary } from './session-summary';

const PROJECT_PATH_ROUTE_PREFIX = 'path:';

export function normalizeProjectPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';

  const normalized = path.normalize(trimmed).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function getSummaryProjectPath(summary: Pick<CachedSessionSummary, 'cwd' | 'projectName'>): string {
  return normalizeProjectPath(summary.cwd || summary.projectName);
}

export function getProjectRowPath(row: { cwd?: string; project_name?: string; projectName?: string }): string {
  return normalizeProjectPath(row.cwd || row.project_name || row.projectName || '');
}

export function makeProjectPathRouteId(projectPath: string): string {
  const normalized = normalizeProjectPath(projectPath);
  return `${PROJECT_PATH_ROUTE_PREFIX}${Buffer.from(normalized, 'utf8').toString('base64url')}`;
}

export function parseProjectPathRouteId(projectId: string): string | null {
  if (!projectId.startsWith(PROJECT_PATH_ROUTE_PREFIX)) return null;
  const encoded = projectId.slice(PROJECT_PATH_ROUTE_PREFIX.length);
  if (!encoded) return null;

  try {
    return normalizeProjectPath(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

export function isSummaryInProjectPath(summary: Pick<CachedSessionSummary, 'cwd' | 'projectName'>, projectPath: string): boolean {
  return getSummaryProjectPath(summary) === normalizeProjectPath(projectPath);
}
