import type { SqlMigration } from "./types.js";

/**
 * Daemon background-agent run tracking schema.
 */
export const agentRunsSchemaMigration: SqlMigration = {
  version: 3,
  name: "agent_runs_schema",
  sql: `
CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  objective TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  last_active_at TEXT NOT NULL,
  current_session_id TEXT,
  created_by_client TEXT,
  last_snapshot_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_status_last_active
  ON agent_runs(status, last_active_at);
CREATE INDEX IF NOT EXISTS idx_agent_runs_current_session
  ON agent_runs(current_session_id);
`,
};
