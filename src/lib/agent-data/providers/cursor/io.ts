import fs from 'fs';
import path from 'path';
import { getActiveDataSource, getAgentDataDir, getLiveCursorUserDir } from '@/lib/agent-data/data-source';

const JSONL_READ_CHUNK_SIZE = 1024 * 1024;

export interface CursorTranscriptRecord {
  role?: string;
  message?: unknown;
  type?: string;
  timestamp?: string;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function getCursorDir(): string {
  return getAgentDataDir('cursor');
}

export function getCursorUserDir(): string {
  return getActiveDataSource() === 'imported'
    ? getAgentDataDir('cursor', 'imported')
    : getLiveCursorUserDir();
}

export function getCursorProjectsDir(rootDir = getCursorDir()): string {
  return path.basename(rootDir).toLowerCase() === 'projects'
    ? rootDir
    : path.join(rootDir, 'projects');
}

export function getCursorStateDbPath(userDir = getCursorUserDir()): string {
  const basename = path.basename(userDir).toLowerCase();
  if (basename === 'state.vscdb') return userDir;
  if (basename === 'globalstorage') return path.join(userDir, 'state.vscdb');
  return path.join(userDir, 'globalStorage', 'state.vscdb');
}

export function getCursorWorkspaceStorageDir(dbPath = getCursorStateDbPath()): string {
  return path.join(path.dirname(path.dirname(dbPath)), 'workspaceStorage');
}

export function getFileSignature(filePath: string): { mtimeMs: number; size: number } {
  try {
    const stat = fs.statSync(filePath);
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return { mtimeMs: 0, size: 0 };
  }
}

export function signatureToString(signature: { mtimeMs: number; size: number }): string {
  return `${signature.mtimeMs}:${signature.size}`;
}

export function getFileTimestampInfo(filePath: string): { createdAt: string; updatedAt: string } {
  try {
    const stat = fs.statSync(filePath);
    const createdMs = stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs;
    return {
      createdAt: new Date(createdMs).toISOString(),
      updatedAt: new Date(stat.mtimeMs).toISOString(),
    };
  } catch {
    const fallback = new Date(0).toISOString();
    return { createdAt: fallback, updatedAt: fallback };
  }
}

function parseCursorJsonlLine(line: string): CursorTranscriptRecord | null {
  if (!line.trim()) return null;
  try {
    const record = asRecord(JSON.parse(line));
    if (!record) return null;
    return {
      role: typeof record.role === 'string' ? record.role : undefined,
      message: record.message,
      type: typeof record.type === 'string' ? record.type : undefined,
      timestamp: typeof record.timestamp === 'string' ? record.timestamp : undefined,
    };
  } catch {
    // Cursor can leave a partial final JSONL line while the app is open.
    return null;
  }
}

export function forEachCursorJsonlLineSync(filePath: string, callback: (record: CursorTranscriptRecord) => void): void {
  if (!fs.existsSync(filePath)) return;

  const buffer = Buffer.allocUnsafe(JSONL_READ_CHUNK_SIZE);
  const fd = fs.openSync(filePath, 'r');
  let carry = '';

  try {
    while (true) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;

      carry += buffer.subarray(0, bytesRead).toString('utf-8');
      const lines = carry.split(/\r?\n/);
      carry = lines.pop() || '';

      for (const line of lines) {
        const parsed = parseCursorJsonlLine(line);
        if (parsed) callback(parsed);
      }
    }

    const parsed = parseCursorJsonlLine(carry);
    if (parsed) callback(parsed);
  } finally {
    fs.closeSync(fd);
  }
}

export function listCursorTranscriptFiles(projectsDir = getCursorProjectsDir()): string[] {
  if (!fs.existsSync(projectsDir)) return [];

  const files: string[] = [];
  const collectTranscriptFiles = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        collectTranscriptFiles(entryPath);
      } else if (entry.isFile() && (entry.name.endsWith('.jsonl') || entry.name.endsWith('.txt'))) {
        files.push(entryPath);
      }
    }
  };

  for (const project of fs.readdirSync(projectsDir, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const transcriptsDir = path.join(projectsDir, project.name, 'agent-transcripts');
    if (!fs.existsSync(transcriptsDir)) continue;
    collectTranscriptFiles(transcriptsDir);
  }

  return files.sort((left, right) => left.localeCompare(right));
}
