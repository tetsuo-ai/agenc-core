import type { SqlMigration } from "./types.js";

/**
 * Initial AgenC logs database schema.
 */
export const initialLogsSchemaMigration: SqlMigration = {
  version: 1,
  name: "initial_logs_schema",
  sql: `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  level TEXT NOT NULL,
  scope TEXT,
  thread_id TEXT,
  event_type TEXT,
  message TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp);
CREATE INDEX IF NOT EXISTS idx_logs_thread ON logs(thread_id, timestamp);
`,
};
