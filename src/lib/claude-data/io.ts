import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';
import { z } from 'zod';
import { getActiveDataSource, getImportDir } from './data-source';
import type { SessionMessage } from './types';

const looseRecord = z.record(z.string(), z.unknown());

export const sessionMessageSchema = z.object({
  type: z.string().optional(),
  uuid: z.string().optional(),
  timestamp: z.string().optional(),
  sessionId: z.string().optional(),
  cwd: z.string().optional(),
  gitBranch: z.string().optional(),
  version: z.string().optional(),
  isMeta: z.boolean().optional(),
  message: looseRecord.optional(),
  attachment: looseRecord.optional(),
  compactMetadata: looseRecord.optional(),
  microcompactMetadata: looseRecord.optional(),
  toolUseResult: looseRecord.optional(),
  sourceToolAssistantUUID: z.string().optional(),
}).catchall(z.unknown());

export async function forEachJsonlLine(filePath: string, callback: (msg: SessionMessage) => void | Promise<void>): Promise<void> {
  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const parsed = sessionMessageSchema.safeParse(JSON.parse(line));
      if (parsed.success) await callback(parsed.data as SessionMessage);
    } catch {
      // skip malformed line
    }
  }
}

export function getClaudeDir(): string {
  if (getActiveDataSource() === 'imported') {
    return path.join(getImportDir(), 'claude-data');
  }
  return path.join(os.homedir(), '.claude');
}

export function getProjectsDir(): string {
  return path.join(getClaudeDir(), 'projects');
}

export function getTopLevelSessionFiles(projectPath: string): string[] {
  return fs.readdirSync(projectPath).filter(entry => entry.endsWith('.jsonl'));
}

export function collectJsonlFilesRecursively(dirPath: string): string[] {
  if (!fs.existsSync(dirPath)) return [];

  const files: string[] = [];
  for (const entry of fs.readdirSync(dirPath)) {
    const entryPath = path.join(dirPath, entry);
    const stat = fs.statSync(entryPath);
    if (stat.isDirectory()) {
      files.push(...collectJsonlFilesRecursively(entryPath));
      continue;
    }
    if (entry.endsWith('.jsonl')) files.push(entryPath);
  }

  return files;
}

export function getSessionAggregateFilePaths(filePath: string): string[] {
  const sessionId = path.basename(filePath, '.jsonl');
  const subagentDir = path.join(path.dirname(filePath), sessionId, 'subagents');
  return [filePath, ...collectJsonlFilesRecursively(subagentDir)];
}
