import fs from 'fs';

export interface JsonlOffsetReadOptions {
  chunkSize?: number;
}

export interface JsonlOffsetReadResult {
  lines: string[];
  nextOffset: number;
  partialCarry: string;
  startsMidLine: boolean;
  truncated: boolean;
}

export interface JsonlRecordReadResult<T> extends Omit<JsonlOffsetReadResult, 'lines'> {
  records: T[];
  error?: string;
}

const DEFAULT_CHUNK_SIZE = 1024 * 1024;

function stripTrailingCarriageReturn(buffer: Buffer): Buffer {
  return buffer.at(-1) === 0x0d ? buffer.subarray(0, buffer.length - 1) : buffer;
}

function isLineBoundary(filePath: string, offset: number): boolean {
  if (offset <= 0) return true;
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1);
    const bytesRead = fs.readSync(fd, buffer, 0, 1, offset - 1);
    return bytesRead === 1 && buffer[0] === 0x0a;
  } finally {
    fs.closeSync(fd);
  }
}

export function readCompleteJsonlLinesFromOffset(
  filePath: string,
  offset: number,
  options: JsonlOffsetReadOptions = {},
): JsonlOffsetReadResult {
  const stat = fs.statSync(filePath);
  const startOffset = Math.max(0, offset);
  if (startOffset > stat.size) {
    return {
      lines: [],
      nextOffset: stat.size,
      partialCarry: '',
      startsMidLine: false,
      truncated: true,
    };
  }
  if (!isLineBoundary(filePath, startOffset)) {
    return {
      lines: [],
      nextOffset: startOffset,
      partialCarry: '',
      startsMidLine: true,
      truncated: false,
    };
  }

  const chunkSize = Math.max(1, options.chunkSize || DEFAULT_CHUNK_SIZE);
  const fd = fs.openSync(filePath, 'r');
  const readBuffer = Buffer.allocUnsafe(chunkSize);
  const lines: string[] = [];
  let filePosition = startOffset;
  let carry = Buffer.alloc(0);
  let carryOffset = startOffset;
  let nextOffset = startOffset;

  try {
    while (true) {
      const bytesRead = fs.readSync(fd, readBuffer, 0, readBuffer.length, filePosition);
      if (bytesRead === 0) break;

      const chunk = Buffer.concat([carry, readBuffer.subarray(0, bytesRead)]);
      let scanStart = 0;
      for (let index = 0; index < chunk.length; index += 1) {
        if (chunk[index] !== 0x0a) continue;
        const lineBuffer = stripTrailingCarriageReturn(chunk.subarray(scanStart, index));
        lines.push(lineBuffer.toString('utf-8'));
        nextOffset = carryOffset + index + 1;
        scanStart = index + 1;
      }

      carry = chunk.subarray(scanStart);
      carryOffset = nextOffset;
      filePosition += bytesRead;
    }
  } finally {
    fs.closeSync(fd);
  }

  return {
    lines,
    nextOffset,
    partialCarry: stripTrailingCarriageReturn(carry).toString('utf-8'),
    startsMidLine: false,
    truncated: false,
  };
}

export function readJsonlRecordsFromOffset<T>(
  filePath: string,
  offset: number,
  parseRecord: (line: string) => T = line => JSON.parse(line) as T,
  options: JsonlOffsetReadOptions = {},
): JsonlRecordReadResult<T> {
  const lineResult = readCompleteJsonlLinesFromOffset(filePath, offset, options);
  const records: T[] = [];

  for (const line of lineResult.lines) {
    if (!line.trim()) continue;
    try {
      records.push(parseRecord(line));
    } catch (error) {
      return {
        records,
        nextOffset: lineResult.nextOffset,
        partialCarry: lineResult.partialCarry,
        startsMidLine: lineResult.startsMidLine,
        truncated: lineResult.truncated,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return {
    records,
    nextOffset: lineResult.nextOffset,
    partialCarry: lineResult.partialCarry,
    startsMidLine: lineResult.startsMidLine,
    truncated: lineResult.truncated,
  };
}
