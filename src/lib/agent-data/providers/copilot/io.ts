import fs from 'fs';
import path from 'path';
import { getAgentDataDir } from '@/lib/agent-data/data-source';

const JSONL_READ_CHUNK_SIZE = 1024 * 1024;

export interface CopilotTranscriptRecord {
  type: string;
  data?: unknown;
  id?: string;
  timestamp?: string;
  parentId?: string | null;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function getCopilotDir(): string {
  return getAgentDataDir('copilot');
}

export function getCopilotWorkspaceStorageDir(rootDir = getCopilotDir()): string {
  return path.basename(rootDir).toLowerCase() === 'workspacestorage'
    ? rootDir
    : path.join(rootDir, 'workspaceStorage');
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

function parseCopilotJsonlLine(line: string): CopilotTranscriptRecord | null {
  if (!line.trim()) return null;
  try {
    const record = asRecord(JSON.parse(line));
    if (!record || typeof record.type !== 'string') return null;
    return {
      type: record.type,
      data: record.data,
      id: typeof record.id === 'string' ? record.id : undefined,
      timestamp: typeof record.timestamp === 'string' ? record.timestamp : undefined,
      parentId: typeof record.parentId === 'string' || record.parentId === null ? record.parentId : undefined,
    };
  } catch {
    // Copilot can leave a partial final JSONL line while VS Code is open.
    return null;
  }
}

export function forEachCopilotJsonlLineSync(filePath: string, callback: (record: CopilotTranscriptRecord) => void): void {
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
        const parsed = parseCopilotJsonlLine(line);
        if (parsed) callback(parsed);
      }
    }

    const parsed = parseCopilotJsonlLine(carry);
    if (parsed) callback(parsed);
  } finally {
    fs.closeSync(fd);
  }
}

export function listCopilotTranscriptFiles(workspaceStorageDir = getCopilotWorkspaceStorageDir()): string[] {
  if (!fs.existsSync(workspaceStorageDir)) return [];

  const files: string[] = [];
  for (const workspace of fs.readdirSync(workspaceStorageDir, { withFileTypes: true })) {
    if (!workspace.isDirectory()) continue;
    const transcriptsDir = path.join(workspaceStorageDir, workspace.name, 'GitHub.copilot-chat', 'transcripts');
    if (!fs.existsSync(transcriptsDir)) continue;

    for (const entry of fs.readdirSync(transcriptsDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        files.push(path.join(transcriptsDir, entry.name));
      }
    }
  }

  return files.sort((left, right) => left.localeCompare(right));
}

export function listCopilotChatSessionFiles(workspaceStorageDir = getCopilotWorkspaceStorageDir()): string[] {
  if (!fs.existsSync(workspaceStorageDir)) return [];

  const files: string[] = [];
  for (const workspace of fs.readdirSync(workspaceStorageDir, { withFileTypes: true })) {
    if (!workspace.isDirectory()) continue;
    const chatSessionsDir = path.join(workspaceStorageDir, workspace.name, 'chatSessions');
    if (!fs.existsSync(chatSessionsDir)) continue;

    for (const entry of fs.readdirSync(chatSessionsDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        files.push(path.join(chatSessionsDir, entry.name));
      }
    }
  }

  return files.sort((left, right) => left.localeCompare(right));
}
