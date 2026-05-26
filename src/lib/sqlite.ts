type Row = Record<string, unknown>;

export interface SqliteDatabase {
  query<T extends Row = Row>(sql: string, params?: unknown[]): T[];
  get<T extends Row = Row>(sql: string, params?: unknown[]): T | undefined;
  run(sql: string, params?: unknown[]): void;
  exec(sql: string): void;
  transaction<T>(callback: () => T): T;
  close(): void;
}

type DatabaseSyncCtor = new (filePath: string, options?: { readOnly?: boolean }) => {
  prepare(sql: string): {
    all(...params: unknown[]): Row[];
    get(...params: unknown[]): Row | undefined;
    run(...params: unknown[]): unknown;
  };
  exec?(sql: string): void;
  close(): void;
};

let DatabaseSync: DatabaseSyncCtor | null = null;
let loadAttempted = false;
let loadError: string | null = null;

const textDecoder = new TextDecoder('utf-8', { fatal: false });

function runtimeRequire(moduleName: string): unknown {
  // Keep this as an indirect require. Turbopack rewrites createRequire('node:sqlite')
  // to an unsupported external stub in dev, which makes the app fall back to JSON.
  return (eval('require') as NodeRequire)(moduleName);
}

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
    const sqlite = runtimeRequire('node:sqlite') as { DatabaseSync: DatabaseSyncCtor };
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

export function openDatabase(filePath: string, options: { readOnly?: boolean } = { readOnly: true }): SqliteDatabase {
  if (!loadDriver() || !DatabaseSync) {
    throw new Error(getSqliteLoadError());
  }

  const db = new DatabaseSync(filePath, { readOnly: options.readOnly !== false });
  try {
    db.exec?.('PRAGMA busy_timeout = 1000');
  } catch {
    // Best effort for older node:sqlite builds.
  }

  function exec(sql: string): void {
    if (db.exec) {
      db.exec(sql);
      return;
    }
    db.prepare(sql).run();
  }

  return {
    query<T extends Row = Row>(sql: string, params: unknown[] = []): T[] {
      return db.prepare(sql).all(...params) as T[];
    },
    get<T extends Row = Row>(sql: string, params: unknown[] = []): T | undefined {
      return db.prepare(sql).get(...params) as T | undefined;
    },
    run(sql: string, params: unknown[] = []) {
      db.prepare(sql).run(...params);
    },
    exec,
    transaction<T>(callback: () => T): T {
      exec('BEGIN IMMEDIATE');
      try {
        const result = callback();
        exec('COMMIT');
        return result;
      } catch (error) {
        try {
          exec('ROLLBACK');
        } catch {
          // Preserve the original transaction failure.
        }
        throw error;
      }
    },
    close() {
      db.close();
    },
  };
}

export function openWritableDatabase(filePath: string): SqliteDatabase {
  return openDatabase(filePath, { readOnly: false });
}
