import { initialLogsSchemaMigration } from "./001_initial_logs_schema.js";
import { initialStateSchemaMigration } from "./001_initial_state_schema.js";
import { csvAgentJobsSchemaMigration } from "./002_csv_agent_jobs_schema.js";
import { agentRunsSchemaMigration } from "./003_agent_runs_schema.js";
import { sessionStateSnapshotsSchemaMigration } from "./004_session_state_snapshots_schema.js";
import { inFlightToolCallsSchemaMigration } from "./005_in_flight_tool_calls_schema.js";
import { threadModelProviderColumnsMigration } from "./006_thread_model_provider_columns.js";
import { sessionAgentLinksSchemaMigration } from "./007_session_agent_links_schema.js";
import type { SqlMigration } from "./types.js";

/**
 * Versioned SQLite migration registry for AgenC state stores.
 */
export const STATE_DB_MIGRATIONS: readonly SqlMigration[] = [
  initialStateSchemaMigration,
  csvAgentJobsSchemaMigration,
  agentRunsSchemaMigration,
  sessionStateSnapshotsSchemaMigration,
  inFlightToolCallsSchemaMigration,
  threadModelProviderColumnsMigration,
  sessionAgentLinksSchemaMigration,
];

export const LOGS_DB_MIGRATIONS: readonly SqlMigration[] = [
  initialLogsSchemaMigration,
];

export type { SqlMigration } from "./types.js";
