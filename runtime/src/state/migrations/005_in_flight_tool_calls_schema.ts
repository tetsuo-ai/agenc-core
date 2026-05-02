import type { SqlMigration } from "./types.js";

/**
 * In-flight tool-call recovery schema.
 */
export const inFlightToolCallsSchemaMigration: SqlMigration = {
  version: 5,
  name: "in_flight_tool_calls_schema",
  sql: `
CREATE TABLE IF NOT EXISTS in_flight_tool_calls (
  session_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  args_json TEXT NOT NULL,
  status TEXT NOT NULL,
  output_partial TEXT,
  started_at TEXT NOT NULL,
  PRIMARY KEY (session_id, tool_call_id)
);

CREATE INDEX IF NOT EXISTS idx_in_flight_tool_calls_session_status
  ON in_flight_tool_calls(session_id, status);
`,
};
