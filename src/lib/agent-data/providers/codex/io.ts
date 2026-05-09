import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { getAgentDataDir } from '@/lib/agent-data/data-source';
import { codexEnvelopeSchema, type CodexEnvelope } from './schema';

export function getCodexDir(): string {
  return getAgentDataDir('codex');
}

export function getCodexSessionsDir(): string {
  return path.join(getCodexDir(), 'sessions');
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

export async function forEachCodexJsonlLine(filePath: string, callback: (record: CodexEnvelope) => void | Promise<void>): Promise<void> {
  if (!fs.existsSync(filePath)) return;
  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const parsed = codexEnvelopeSchema.safeParse(JSON.parse(line));
      if (parsed.success) await callback(parsed.data);
    } catch {
      // Codex rollouts can end with partial lines. Ignore them and keep reading.
    }
  }
}

export function listCodexSessionFiles(dirPath = getCodexSessionsDir()): string[] {
  if (!fs.existsSync(dirPath)) return [];

  const files: string[] = [];
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...listCodexSessionFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      files.push(entryPath);
    }
  }

  return files.sort((left, right) => left.localeCompare(right));
}
