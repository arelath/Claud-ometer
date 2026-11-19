import fs from 'fs';
import path from 'path';
import * as zlib from 'node:zlib';
import { Transform } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { Decompress } from 'fzstd';
import { getAgentDataDir } from '@/lib/agent-data/data-source';
import { codexEnvelopeSchema, type CodexEnvelope } from './schema';

const JSONL_READ_CHUNK_SIZE = 1024 * 1024;
const FIRST_LINE_READ_CAP = 1024 * 1024;
const YEAR_DIR_PATTERN = /^\d{4}$/;
const MONTH_OR_DAY_DIR_PATTERN = /^\d{2}$/;
const ROLLOUT_FILE_PATTERN = /^rollout-.*\.jsonl(?:\.zst)?$/;

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

// Node 22.15 added native Zstandard. Earlier supported runtimes use the
// streaming JS decoder so discovery and detail reads have the same semantics.
function zstdDecoder(): Transform {
  if (zlib.createZstdDecompress) return zlib.createZstdDecompress({ chunkSize: 128 * 1024 });
  const decoder = new Decompress(chunk => stream.push(Buffer.from(chunk)));
  const stream = new Transform({
    transform(chunk, _encoding, callback) {
      try { decoder.push(chunk); callback(); } catch (error) { callback(error as Error); }
    },
    flush(callback) {
      try { decoder.push(new Uint8Array(), true); callback(); } catch (error) { callback(error as Error); }
    },
  });
  return stream;
}

async function* rolloutChunks(filePath: string, inputChunkSize = JSONL_READ_CHUNK_SIZE): AsyncGenerator<Buffer> {
  const input = fs.createReadStream(filePath, { highWaterMark: inputChunkSize });
  const stream = filePath.endsWith('.zst') ? input.pipe(zstdDecoder()) : input;
  input.on('error', error => stream.destroy(error));
  try {
    for await (const chunk of stream) yield chunk as Buffer;
  } finally {
    input.destroy();
    stream.destroy();
  }
}

export async function readCodexPrefix(filePath: string, maxBytes = FIRST_LINE_READ_CAP): Promise<{ text: string; complete: boolean }> {
  let length = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of rolloutChunks(filePath, 32 * 1024)) {
    const remaining = maxBytes - length;
    chunks.push(chunk.subarray(0, remaining));
    length += Math.min(remaining, chunk.length);
    if (chunk.length > remaining) return { text: Buffer.concat(chunks).toString('utf8'), complete: false };
  }
  return { text: Buffer.concat(chunks).toString('utf8'), complete: true };
}

export async function forEachCodexJsonlLine(filePath: string, callback: (record: CodexEnvelope) => void, endOffset?: number): Promise<void> {
  if (!fs.existsSync(filePath)) return;
  if (endOffset != null && (!Number.isSafeInteger(endOffset) || endOffset < 0)) {
    throw new Error(`Invalid Codex history boundary ${endOffset} for ${filePath}`);
  }
  if (endOffset === 0) return;

  const decoder = new StringDecoder('utf8');
  let carry = '';
  let position = 0;
  const emit = (line: string) => {
    const parsed = parseCodexJsonlLine(line);
    if (parsed) callback(parsed);
  };
  for await (const chunk of rolloutChunks(filePath)) {
    const bytes = endOffset == null ? chunk : chunk.subarray(0, endOffset - position);
    position += bytes.length;
    const lines = decoder.write(bytes).split('\n');
    // Search only the new bytes for line breaks. A single embedded image can
    // span hundreds of chunks.
    for (let index = 0; index < lines.length - 1; index++) {
      emit(carry + lines[index]);
      carry = '';
    }
    carry += lines[lines.length - 1];
    if (position === endOffset) break;
  }
  carry += decoder.end();
  if (endOffset != null) {
    if (position !== endOffset) throw new Error(`Invalid Codex history boundary ${endOffset} for ${filePath}`);
    if (carry) throw new Error(`Codex history boundary ${endOffset} is not a record boundary for ${filePath}`);
  }
  if (carry) emit(carry);
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
          if (entry.isFile() && ROLLOUT_FILE_PATTERN.test(entry.name)) {
            files.push(entryPath);
          }
        }
      }
    }
  }

  return files.sort((left, right) => left.localeCompare(right));
}
