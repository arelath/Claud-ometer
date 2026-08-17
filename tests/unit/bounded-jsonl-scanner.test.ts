import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { jsonlBoundaryHash, scanBoundedJsonlRecords } from '@/lib/agent-data/bounded-jsonl-scanner';

describe('bounded JSONL scanner', () => {
  const root = path.join(process.cwd(), '.test-artifacts', 'bounded-jsonl-scanner');
  const filePath = path.join(root, 'session.jsonl');

  beforeEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('returns record offsets and stops before a partial trailing record', () => {
    const complete = '{"id":1}\n{"id":2}\n';
    fs.writeFileSync(filePath, `${complete}{"id":3}`);

    const result = scanBoundedJsonlRecords<{ id: number }>(filePath, {
      startOffset: 0,
      endOffset: fs.statSync(filePath).size,
    });

    expect(result.records.map(record => record.value.id)).toEqual([1, 2]);
    expect(result.records.map(record => [record.recordStartOffset, record.recordEndOffset])).toEqual([
      [0, Buffer.byteLength('{"id":1}\n')],
      [Buffer.byteLength('{"id":1}\n'), Buffer.byteLength(complete)],
    ]);
    expect(result.nextOffset).toBe(Buffer.byteLength(complete));
    expect(result.partialTrailingRecord).toBe(true);
  });

  it('does not advance past a malformed complete record', () => {
    const first = '{"id":1}\n';
    fs.writeFileSync(filePath, `${first}{bad}\n{"id":3}\n`);

    const result = scanBoundedJsonlRecords(filePath, {
      startOffset: 0,
      endOffset: fs.statSync(filePath).size,
    });

    expect(result.records).toHaveLength(1);
    expect(result.nextOffset).toBe(Buffer.byteLength(first));
    expect(result.error).toContain(`at ${Buffer.byteLength(first)}`);
  });

  it('rejects a changed committed boundary', () => {
    fs.writeFileSync(filePath, '{"id":1}\n');
    const end = fs.statSync(filePath).size;
    const boundary = jsonlBoundaryHash(filePath, end);
    fs.writeFileSync(filePath, '{"id":9}\n');

    const result = scanBoundedJsonlRecords(filePath, {
      startOffset: end,
      endOffset: end,
      expectedBoundaryHash: boundary,
    });

    expect(result.error).toContain('boundary hash mismatch');
  });

  it('honors record limits without reading logical records past the batch', () => {
    fs.writeFileSync(filePath, '{"id":1}\n{"id":2}\n{"id":3}\n');
    const result = scanBoundedJsonlRecords(filePath, {
      startOffset: 0,
      endOffset: fs.statSync(filePath).size,
      maxRecords: 2,
    });

    expect(result.records.map(record => (record.value as { id: number }).id)).toEqual([1, 2]);
    expect(result.nextOffset).toBe(Buffer.byteLength('{"id":1}\n{"id":2}\n'));
    expect(result.reachedSnapshotEnd).toBe(false);
  });

  it('rejects a requested snapshot boundary that is no longer readable', () => {
    fs.writeFileSync(filePath, '{"id":1}\n');
    const requestedEnd = fs.statSync(filePath).size + 10;

    const result = scanBoundedJsonlRecords(filePath, {
      startOffset: 0,
      endOffset: requestedEnd,
    });

    expect(result.error).toContain(`snapshot end ${requestedEnd} exceeds file size`);
    expect(result.nextOffset).toBe(0);
  });

  it('accepts one complete record above the soft batch limit but enforces the hard record limit', () => {
    const line = `${JSON.stringify({ text: 'x'.repeat(256) })}\n`;
    fs.writeFileSync(filePath, line);

    const accepted = scanBoundedJsonlRecords(filePath, {
      startOffset: 0,
      endOffset: fs.statSync(filePath).size,
      maxBytes: 64,
      maxRecordBytes: 1024,
    });
    const rejected = scanBoundedJsonlRecords(filePath, {
      startOffset: 0,
      endOffset: fs.statSync(filePath).size,
      maxBytes: 64,
      maxRecordBytes: 128,
    });

    expect(accepted.records).toHaveLength(1);
    expect(accepted.nextOffset).toBe(Buffer.byteLength(line));
    expect(accepted.partialTrailingRecord).toBe(false);
    expect(rejected.records).toEqual([]);
    expect(rejected.error).toContain('exceeds 128 bytes');
  });
});
