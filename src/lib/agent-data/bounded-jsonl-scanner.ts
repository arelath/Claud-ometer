import { createHash } from 'crypto';
import fs from 'fs';

export interface BoundedJsonlRecord<T> {
  recordStartOffset: number;
  recordEndOffset: number;
  rawByteCount: number;
  value: T;
}

export interface BoundedJsonlScanOptions<T> {
  startOffset: number;
  endOffset: number;
  maxBytes?: number;
  maxRecords?: number;
  maxRecordBytes?: number;
  expectedBoundaryHash?: string;
  parseRecord?: (line: string) => T;
}

export interface BoundedJsonlScanResult<T> {
  records: BoundedJsonlRecord<T>[];
  nextOffset: number;
  bytesConsumed: number;
  reachedSnapshotEnd: boolean;
  partialTrailingRecord: boolean;
  boundaryHash: string;
  error?: string;
}

const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_MAX_RECORDS = 1000;
const DEFAULT_MAX_RECORD_BYTES = 4 * 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
const BOUNDARY_WINDOW_BYTES = 4096;

export function jsonlBoundaryHash(filePath: string, completeOffset: number): string {
  const boundedOffset = Math.max(0, completeOffset);
  const start = Math.max(0, boundedOffset - BOUNDARY_WINDOW_BYTES);
  const length = boundedOffset - start;
  const buffer = Buffer.alloc(length);
  if (length > 0) {
    const fd = fs.openSync(filePath, 'r');
    try {
      const bytesRead = fs.readSync(fd, buffer, 0, length, start);
      if (bytesRead !== length) throw new Error(`Unable to read JSONL boundary at ${boundedOffset}`);
    } finally {
      fs.closeSync(fd);
    }
  }
  return createHash('sha256').update(buffer).digest('hex');
}

function isLineBoundary(filePath: string, offset: number): boolean {
  if (offset === 0) return true;
  const fd = fs.openSync(filePath, 'r');
  try {
    const byte = Buffer.allocUnsafe(1);
    return fs.readSync(fd, byte, 0, 1, offset - 1) === 1 && byte[0] === 0x0a;
  } finally {
    fs.closeSync(fd);
  }
}

export function scanBoundedJsonlRecords<T = unknown>(
  filePath: string,
  options: BoundedJsonlScanOptions<T>,
): BoundedJsonlScanResult<T> {
  const stat = fs.statSync(filePath);
  const startOffset = Math.max(0, options.startOffset);
  const requestedEndOffset = Math.max(startOffset, options.endOffset);
  const endOffset = requestedEndOffset;
  const maxBytes = Math.max(1, options.maxBytes || DEFAULT_MAX_BYTES);
  const maxRecords = Math.max(1, options.maxRecords || DEFAULT_MAX_RECORDS);
  const maxRecordBytes = Math.max(1, options.maxRecordBytes || DEFAULT_MAX_RECORD_BYTES);
  const parseRecord = options.parseRecord || ((line: string) => JSON.parse(line) as T);
  const records: BoundedJsonlRecord<T>[] = [];

  const failure = (error: string): BoundedJsonlScanResult<T> => ({
    records,
    nextOffset: startOffset,
    bytesConsumed: 0,
    reachedSnapshotEnd: false,
    partialTrailingRecord: false,
    boundaryHash: startOffset <= stat.size ? jsonlBoundaryHash(filePath, startOffset) : '',
    error,
  });

  if (startOffset > stat.size) return failure(`JSONL cursor ${startOffset} exceeds file size ${stat.size}`);
  if (requestedEndOffset > stat.size) {
    return failure(`JSONL snapshot end ${requestedEndOffset} exceeds file size ${stat.size}`);
  }
  if (!isLineBoundary(filePath, startOffset)) return failure(`JSONL cursor ${startOffset} is not a record boundary`);
  if (options.expectedBoundaryHash && jsonlBoundaryHash(filePath, startOffset) !== options.expectedBoundaryHash) {
    return failure(`JSONL boundary hash mismatch at ${startOffset}`);
  }

  const fd = fs.openSync(filePath, 'r');
  let readPosition = startOffset;
  let recordStartOffset = startOffset;
  let carry = Buffer.alloc(0);
  let nextOffset = startOffset;
  let partialTrailingRecord = false;
  let error: string | undefined;

  try {
    while (readPosition < endOffset && records.length < maxRecords && nextOffset - startOffset < maxBytes) {
      const remaining = endOffset - readPosition;
      const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, remaining));
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, readPosition);
      if (bytesRead === 0) {
        error = `Unexpected EOF before JSONL snapshot end ${endOffset}`;
        break;
      }
      readPosition += bytesRead;
      const combined = Buffer.concat([carry, buffer.subarray(0, bytesRead)]);
      const combinedStartOffset = recordStartOffset;
      let segmentStart = 0;

      for (let index = 0; index < combined.length; index += 1) {
        if (combined[index] !== 0x0a) continue;
        const recordEndOffset = combinedStartOffset + index + 1;
        const recordBytes = recordEndOffset - recordStartOffset;
        if (recordBytes > maxRecordBytes) {
          error = `JSONL record at ${recordStartOffset} exceeds ${maxRecordBytes} bytes`;
          break;
        }
        if (records.length >= maxRecords || (records.length > 0 && recordEndOffset - startOffset > maxBytes)) break;
        let lineBuffer = combined.subarray(segmentStart, index);
        if (lineBuffer.at(-1) === 0x0d) lineBuffer = lineBuffer.subarray(0, lineBuffer.length - 1);
        const line = lineBuffer.toString('utf8');
        if (line.trim()) {
          try {
            records.push({
              recordStartOffset,
              recordEndOffset,
              rawByteCount: recordBytes,
              value: parseRecord(line),
            });
          } catch (parseError) {
            error = `Malformed JSONL record at ${recordStartOffset}: ${parseError instanceof Error ? parseError.message : String(parseError)}`;
            break;
          }
        }
        nextOffset = recordEndOffset;
        segmentStart = index + 1;
        recordStartOffset = recordEndOffset;
      }

      if (error) break;
      carry = combined.subarray(segmentStart);
      if (carry.length > maxRecordBytes) {
        error = `JSONL record at ${recordStartOffset} exceeds ${maxRecordBytes} bytes`;
        break;
      }
      if (records.length >= maxRecords || nextOffset - startOffset >= maxBytes) break;
    }
    partialTrailingRecord = readPosition >= endOffset && carry.length > 0 && carry.indexOf(0x0a) < 0;
  } finally {
    fs.closeSync(fd);
  }

  return {
    records,
    nextOffset,
    bytesConsumed: nextOffset - startOffset,
    reachedSnapshotEnd: !error && nextOffset === endOffset && !partialTrailingRecord,
    partialTrailingRecord,
    boundaryHash: jsonlBoundaryHash(filePath, nextOffset),
    error,
  };
}
