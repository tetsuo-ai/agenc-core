import { initialLogsSchemaMigration } from "./001_initial_logs_schema.js";
import { initialStateSchemaMigration } from "./001_initial_state_schema.js";
import { csvAgentJobsSchemaMigration } from "./002_csv_agent_jobs_schema.js";
import { agentRunsSchemaMigration } from "./003_agent_runs_schema.js";
import { sessionStateSnapshotsSchemaMigration } from "./004_session_state_snapshots_schema.js";
import { inFlightToolCallsSchemaMigration } from "./005_in_flight_tool_calls_schema.js";
import { threadModelProviderColumnsMigration } from "./006_thread_model_provider_columns.js";
import { sessionAgentLinksSchemaMigration } from "./007_session_agent_links_schema.js";
import { toolOutputRotationSchemaMigration } from "./008_tool_output_rotation_schema.js";
import { agentRunMetadataSchemaMigration } from "./009_agent_run_metadata_schema.js";
import { toolRecoveryCategorySchemaMigration } from "./010_tool_recovery_category_schema.js";
import { memoryPipelineSchemaMigration } from "./011_memory_pipeline_schema.js";
import { agentRoleWorkspaceProvenanceMigration } from "./012_agent_role_workspace_provenance.js";
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
  toolOutputRotationSchemaMigration,
  agentRunMetadataSchemaMigration,
  toolRecoveryCategorySchemaMigration,
  memoryPipelineSchemaMigration,
  agentRoleWorkspaceProvenanceMigration,
];

export const LOGS_DB_MIGRATIONS: readonly SqlMigration[] = [
  initialLogsSchemaMigration,
];

export type { SqlMigration } from "./types.js";
