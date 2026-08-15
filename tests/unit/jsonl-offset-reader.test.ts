import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  readCompleteJsonlLinesFromOffset,
  readJsonlRecordsFromOffset,
} from '@/lib/agent-data/jsonl-offset-reader';

describe('JSONL offset reader', () => {
  const root = path.join(process.cwd(), '.test-artifacts', 'jsonl-offset-reader');
  const filePath = path.join(root, 'session.jsonl');

  beforeEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('returns complete lines and leaves an unterminated final line as carry', () => {
    const complete = '{"a":1}\n{"a":2}\n';
    fs.writeFileSync(filePath, `${complete}{"a":3}`);

    const result = readCompleteJsonlLinesFromOffset(filePath, 0, { chunkSize: 4 });

    expect(result).toMatchObject({
      lines: ['{"a":1}', '{"a":2}'],
      nextOffset: Buffer.byteLength(complete),
      partialCarry: '{"a":3}',
      startsMidLine: false,
      truncated: false,
    });
  });

  it('decodes UTF-8 records even when reads split multibyte characters', () => {
    fs.writeFileSync(filePath, '{"text":"hello star"}\n{"text":"snowman ☃"}\n', 'utf-8');

    const result = readJsonlRecordsFromOffset<{ text: string }>(filePath, 0, undefined, { chunkSize: 5 });

    expect(result.records).toEqual([
      { text: 'hello star' },
      { text: 'snowman ☃' },
    ]);
    expect(result.partialCarry).toBe('');
    expect(result.error).toBeUndefined();
  });

  it('flags checkpoints that start in the middle of a line', () => {
    fs.writeFileSync(filePath, '{"a":1}\n{"a":2}\n');

    const result = readCompleteJsonlLinesFromOffset(filePath, 2);

    expect(result).toMatchObject({
      lines: [],
      nextOffset: 2,
      startsMidLine: true,
      truncated: false,
    });
  });

  it('reports malformed complete records while preserving earlier records', () => {
    fs.writeFileSync(filePath, '{"ok":1}\n{bad}\n{"partial":');

    const result = readJsonlRecordsFromOffset<{ ok: number }>(filePath, 0);

    expect(result.records).toEqual([{ ok: 1 }]);
    expect(result.error).toBeTruthy();
    expect(result.partialCarry).toBe('{"partial":');
  });

  it('marks offsets beyond EOF as truncated', () => {
    fs.writeFileSync(filePath, '{"a":1}\n');

    const result = readCompleteJsonlLinesFromOffset(filePath, 100);

    expect(result).toMatchObject({
      lines: [],
      nextOffset: Buffer.byteLength('{"a":1}\n'),
      partialCarry: '',
      startsMidLine: false,
      truncated: true,
    });
  });
});
