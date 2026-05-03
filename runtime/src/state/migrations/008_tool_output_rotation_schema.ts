import type { SqlMigration } from "./types.js";

/**
 * Tracks bounded tool-output spill files for in-flight tool-call recovery.
 */
export const toolOutputRotationSchemaMigration: SqlMigration = {
  version: 8,
  name: "tool_output_rotation_schema",
  sql: `
ALTER TABLE in_flight_tool_calls
  ADD COLUMN output_log_path TEXT;

ALTER TABLE in_flight_tool_calls
  ADD COLUMN output_log_bytes INTEGER NOT NULL DEFAULT 0;
`,
};
