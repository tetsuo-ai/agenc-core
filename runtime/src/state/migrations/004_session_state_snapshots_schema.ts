import type { SqlMigration } from "./types.js";

/**
 * Durable daemon session snapshot schema.
 */
export const sessionStateSnapshotsSchemaMigration: SqlMigration = {
  version: 4,
  name: "session_state_snapshots_schema",
  sql: `
CREATE TABLE IF NOT EXISTS session_state_snapshots (
  session_id TEXT NOT NULL,
  snapshot_at TEXT NOT NULL,
  conversation_json TEXT NOT NULL,
  tool_state_json TEXT NOT NULL,
  mcp_connection_state_json TEXT NOT NULL,
  PRIMARY KEY (session_id, snapshot_at)
);

CREATE INDEX IF NOT EXISTS idx_session_state_snapshots_latest
  ON session_state_snapshots(session_id, snapshot_at DESC);
`,
};
