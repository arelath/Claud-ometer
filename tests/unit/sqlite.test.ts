import fs from 'fs';
import path from 'path';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isSqliteAvailable, openWritableDatabase } from '@/lib/sqlite';

const requireForSqlite = createRequire(import.meta.url);
const sqliteDescribe = isSqliteAvailable() ? describe : describe.skip;

sqliteDescribe('SQLite wrapper', () => {
  const root = path.join(process.cwd(), '.test-artifacts', 'sqlite-wrapper');
  const dbPath = path.join(root, 'cache.db');
  let prepareSpy: ReturnType<typeof vi.spyOn> | undefined;

  function spyOnPrepare() {
    const { DatabaseSync } = requireForSqlite('node:sqlite') as {
      DatabaseSync: new (filePath: string, options?: { readOnly?: boolean }) => {
        prepare(sql: string): unknown;
      };
    };
    prepareSpy = vi.spyOn(DatabaseSync.prototype, 'prepare');
    return prepareSpy;
  }

  function prepareCallsFor(spy: ReturnType<typeof vi.spyOn>, sql: string): unknown[][] {
    return spy.mock.calls.filter((call: unknown[]) => call[0] === sql);
  }

  beforeEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });
  });

  afterEach(() => {
    prepareSpy?.mockRestore();
    prepareSpy = undefined;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('reuses statements per connection and clears them after exec and close', () => {
    const spy = spyOnPrepare();
    const insertSql = 'INSERT INTO items (value) VALUES (?)';

    const db = openWritableDatabase(dbPath);
    db.exec('CREATE TABLE items (value TEXT)');
    spy.mockClear();

    db.run(insertSql, ['one']);
    db.run(insertSql, ['two']);
    expect(prepareCallsFor(spy, insertSql)).toHaveLength(1);

    db.exec('CREATE INDEX idx_items_value ON items(value)');
    db.run(insertSql, ['three']);
    expect(prepareCallsFor(spy, insertSql)).toHaveLength(2);
    db.close();

    const reopened = openWritableDatabase(dbPath);
    reopened.run(insertSql, ['four']);
    expect(prepareCallsFor(spy, insertSql)).toHaveLength(3);
    reopened.close();
  });
});
