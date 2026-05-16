import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { getAgentDataDir } from '@/lib/agent-data/data-source';
import { codexEnvelopeSchema, type CodexEnvelope } from './schema';

const JSONL_READ_CHUNK_SIZE = 1024 * 1024;
export const FIRST_LINE_READ_CAP = 1024 * 1024;
const YEAR_DIR_PATTERN = /^\d{4}$/;
const MONTH_OR_DAY_DIR_PATTERN = /^\d{2}$/;
const ROLLOUT_FILE_PATTERN = /^rollout-.*\.jsonl$/;

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

function readFirstLine(filePath: string, maxBytes = FIRST_LINE_READ_CAP): string {
  const fd = fs.openSync(filePath, 'r');
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    while (totalBytes < maxBytes) {
      const remaining = maxBytes - totalBytes;
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      const newlineIndex = chunk.indexOf(0x0a);
      if (newlineIndex >= 0) {
        chunks.push(chunk.subarray(0, newlineIndex));
        break;
      }
      chunks.push(chunk);
      totalBytes += bytesRead;
    }
  } finally {
    fs.closeSync(fd);
  }

  return Buffer.concat(chunks).toString('utf-8').replace(/\r$/, '');
}

export function isValidCodexSessionFile(filePath: string): boolean {
  try {
    const firstLine = readFirstLine(filePath);
    const record = parseCodexJsonlLine(firstLine);
    if (record?.type !== 'session_meta') return false;
    const originator = record.payload?.originator;
    return typeof originator === 'string' && originator.toLowerCase().startsWith('codex');
  } catch {
    return false;
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

export function listCodexSessionFiles(sessionsDir = getCodexSessionsDir()): string[] {
  if (!fs.existsSync(sessionsDir)) return [];
  const files: string[] = [];

  for (const year of fs.readdirSync(sessionsDir, { withFileTypes: true })) {
    if (!year.isDirectory() || !YEAR_DIR_PATTERN.test(year.name)) continue;
    const yearDir = path.join(sessionsDir, year.name);
    for (const month of fs.readdirSync(yearDir, { withFileTypes: true })) {
      if (!month.isDirectory() || !MONTH_OR_DAY_DIR_PATTERN.test(month.name)) continue;
      const monthDir = path.join(yearDir, month.name);
      for (const day of fs.readdirSync(monthDir, { withFileTypes: true })) {
        if (!day.isDirectory() || !MONTH_OR_DAY_DIR_PATTERN.test(day.name)) continue;
        const dayDir = path.join(monthDir, day.name);
        for (const entry of fs.readdirSync(dayDir, { withFileTypes: true })) {
          const entryPath = path.join(dayDir, entry.name);
          if (entry.isFile() && ROLLOUT_FILE_PATTERN.test(entry.name) && isValidCodexSessionFile(entryPath)) {
            files.push(entryPath);
          }
        }
      }
    }
  }

  return files.sort((left, right) => left.localeCompare(right));
}
