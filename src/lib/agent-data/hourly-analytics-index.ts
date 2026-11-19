import type { SqliteDatabase } from '@/lib/sqlite';

const HOUR = 'CAST(timestamp_ms / 3600000 AS INTEGER) * 3600000';
const ACTIVITY = 'CASE WHEN assistant_message_count > 0 OR (input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) > 0 THEN 1 ELSE 0 END';
const usageCounts = [
  'message_count', 'user_message_count', 'assistant_message_count', 'tool_call_count',
  'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'reasoning_output_tokens',
];
const costs = ['cost_api', 'cost_conservative', 'cost_subscription'];
const changes = ['added_lines', 'removed_lines', 'net_line_delta', 'changed_lines', 'file_count', 'edit_count'];

function summed(columns: string[]): string {
  return columns.map(column => `SUM(${column})`).join(', ');
}

const insertUsage = `
  INSERT INTO hourly_usage (source_key, utc_hour_ms, model, ${usageCounts}, ${costs}, activity_count, last_timestamp_ms)
  SELECT source_key, ${HOUR} AS utc_hour_ms, model, ${summed(usageCounts)}, ${summed(costs)},
         SUM(${ACTIVITY}), MAX(timestamp_ms)
  FROM usage_events WHERE source_key = ? AND timestamp_ms > 0
  GROUP BY utc_hour_ms, model`;
const insertChanges = `
  INSERT INTO hourly_changes (source_key, utc_hour_ms, ${changes})
  SELECT source_key, ${HOUR} AS utc_hour_ms, ${summed(changes)}
  FROM change_events WHERE source_key = ? AND timestamp_ms > 0
  GROUP BY utc_hour_ms`;

function hasHourlyIndex(db: SqliteDatabase): boolean {
  return Boolean(db.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'hourly_usage'"));
}

export function initializeHourlyAnalytics(db: SqliteDatabase): void {
  if (hasHourlyIndex(db)) return;
  // Publish both tables and the backfill together. Readers can still use the
  // original events while the indexer upgrades an existing WAL database.
  db.transaction(() => {
    if (hasHourlyIndex(db)) return;
    db.exec(`
      CREATE TABLE hourly_usage (
        source_key TEXT NOT NULL REFERENCES session_summaries(source_key) ON DELETE CASCADE,
        utc_hour_ms INTEGER NOT NULL, model TEXT NOT NULL,
        ${usageCounts.map(column => column + ' INTEGER NOT NULL').join(', ')},
        ${costs.map(column => column + ' REAL NOT NULL').join(', ')},
        activity_count INTEGER NOT NULL, last_timestamp_ms INTEGER NOT NULL,
        PRIMARY KEY (source_key, utc_hour_ms, model)
      ) WITHOUT ROWID;
      CREATE TABLE hourly_changes (
        source_key TEXT NOT NULL REFERENCES session_summaries(source_key) ON DELETE CASCADE,
        utc_hour_ms INTEGER NOT NULL,
        ${changes.map(column => column + ' INTEGER NOT NULL').join(', ')},
        PRIMARY KEY (source_key, utc_hour_ms)
      ) WITHOUT ROWID;
    `);
    for (const { sourceKey } of db.query<{ sourceKey: string }>('SELECT source_key AS sourceKey FROM session_summaries')) {
      db.run(insertUsage, [sourceKey]);
      db.run(insertChanges, [sourceKey]);
    }
  });
}

export function refreshSourceHourlyAnalytics(db: SqliteDatabase, sourceKey: string): void {
  db.run('DELETE FROM hourly_usage WHERE source_key = ?', [sourceKey]);
  db.run(insertUsage, [sourceKey]);
  db.run('DELETE FROM hourly_changes WHERE source_key = ?', [sourceKey]);
  db.run(insertChanges, [sourceKey]);
}

export function hourlyAnalyticsInputs(db: SqliteDatabase) {
  if (hasHourlyIndex(db)) return { usage: 'hourly_usage', changes: 'hourly_changes' };
  // Legacy read-only indexes and readers that arrive before the backfill commits.
  return {
    usage: `(SELECT *, ${HOUR} AS utc_hour_ms, ${ACTIVITY} AS activity_count, timestamp_ms AS last_timestamp_ms
             FROM usage_events WHERE timestamp_ms > 0)`,
    changes: `(SELECT *, ${HOUR} AS utc_hour_ms FROM change_events WHERE timestamp_ms > 0)`,
  };
}
