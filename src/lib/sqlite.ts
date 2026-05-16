import { createRequire } from 'node:module';

type Row = Record<string, unknown>;

export interface SqliteDatabase {
  query<T extends Row = Row>(sql: string, params?: unknown[]): T[];
  close(): void;
}

type DatabaseSyncCtor = new (filePath: string, options?: { readOnly?: boolean }) => {
  prepare(sql: string): { all(...params: unknown[]): Row[] };
  exec?(sql: string): void;
  close(): void;
};

let DatabaseSync: DatabaseSyncCtor | null = null;
let loadAttempted = false;
let loadError: string | null = null;

const requireForSqlite = createRequire(import.meta.url);
const textDecoder = new TextDecoder('utf-8', { fatal: false });

export function blobToText(value: Uint8Array | string | null | undefined): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  return textDecoder.decode(value);
}

function loadDriver(): boolean {
  if (loadAttempted) return DatabaseSync !== null;
  loadAttempted = true;

  const originalEmit = process.emit.bind(process);
  let restored = false;
  const restoreEmit = () => {
    if (restored) return;
    restored = true;
    process.emit = originalEmit;
  };

  // node:sqlite is still marked experimental in some Node versions. Suppress
  // that one warning so reading Cursor data does not pollute server logs.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  process.emit = function patchedEmit(this: NodeJS.Process, event: string, ...args: any[]): boolean {
    if (event === 'warning') {
      const warning = args[0] as { name?: string; message?: string } | undefined;
      if (warning?.name === 'ExperimentalWarning' && /SQLite/i.test(warning.message || '')) {
        return false;
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (originalEmit as any).call(this, event, ...args);
  } as typeof process.emit;

  try {
    const sqlite = requireForSqlite('node:sqlite') as { DatabaseSync: DatabaseSyncCtor };
    DatabaseSync = sqlite.DatabaseSync;
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    loadError = `SQLite support needs Node 22+ with node:sqlite. Current Node: ${process.version}. (${message})`;
    return false;
  } finally {
    process.nextTick(restoreEmit);
  }
}

export function isSqliteAvailable(): boolean {
  return loadDriver();
}

export function getSqliteLoadError(): string {
  return loadError || 'SQLite driver not available';
}

export function openDatabase(filePath: string): SqliteDatabase {
  if (!loadDriver() || !DatabaseSync) {
    throw new Error(getSqliteLoadError());
  }

  const db = new DatabaseSync(filePath, { readOnly: true });
  try {
    db.exec?.('PRAGMA busy_timeout = 1000');
  } catch {
    // Best effort for older node:sqlite builds.
  }

  return {
    query<T extends Row = Row>(sql: string, params: unknown[] = []): T[] {
      return db.prepare(sql).all(...params) as T[];
    },
    close() {
      db.close();
    },
  };
}
