import fs from 'fs';
import path from 'path';
import { getAgentDataDir } from '@/lib/agent-data/data-source';

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

export function getCursorProjectsDir(rootDir = getCursorDir()): string {
  return path.basename(rootDir).toLowerCase() === 'projects'
    ? rootDir
    : path.join(rootDir, 'projects');
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
  for (const project of fs.readdirSync(projectsDir, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const transcriptsDir = path.join(projectsDir, project.name, 'agent-transcripts');
    if (!fs.existsSync(transcriptsDir)) continue;

    for (const session of fs.readdirSync(transcriptsDir, { withFileTypes: true })) {
      if (!session.isDirectory()) continue;
      const sessionDir = path.join(transcriptsDir, session.name);
      for (const entry of fs.readdirSync(sessionDir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          files.push(path.join(sessionDir, entry.name));
        }
      }
    }
  }

  return files.sort((left, right) => left.localeCompare(right));
}
