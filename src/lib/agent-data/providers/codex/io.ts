import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { getAgentDataDir } from '@/lib/agent-data/data-source';
import { codexEnvelopeSchema, type CodexEnvelope } from './schema';

const JSONL_READ_CHUNK_SIZE = 1024 * 1024;

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

function parseCodexJsonlLine(line: string): CodexEnvelope | null {
  if (!line.trim()) return null;
  try {
    const parsed = codexEnvelopeSchema.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : null;
  } catch {
    // Codex rollouts can end with partial lines. Ignore them and keep reading.
    return null;
  }
}

export function forEachCodexJsonlLineSync(filePath: string, callback: (record: CodexEnvelope) => void): void {
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
        const parsed = parseCodexJsonlLine(line);
        if (parsed) callback(parsed);
      }
    }

    const parsed = parseCodexJsonlLine(carry);
    if (parsed) callback(parsed);
  } finally {
    fs.closeSync(fd);
  }
}

export async function forEachCodexJsonlLine(filePath: string, callback: (record: CodexEnvelope) => void | Promise<void>): Promise<void> {
  if (!fs.existsSync(filePath)) return;
  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  for await (const line of rl) {
    const parsed = parseCodexJsonlLine(line);
    if (parsed) await callback(parsed);
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
