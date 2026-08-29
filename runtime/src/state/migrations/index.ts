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
import { threadListingIndexesMigration } from "./013_thread_listing_indexes.js";
import { executionAdmissionSchemaMigration } from "./014_execution_admission_schema.js";
import { runDurabilitySchemaMigration } from "./015_run_durability_schema.js";
import { runEffectsSessionCallStepIndexMigration } from "./016_run_effects_session_call_step_index.js";
import { effectEvidenceV2Migration } from "./017_effect_evidence_v2.js";
import { runRecoverySchemaMigration } from "./018_run_recovery_schema.js";
import { csvJobIdentityReplayMigration } from "./019_csv_job_identity_replay.js";
import { toolPairProjectionSchemaMigration } from "./020_tool_pair_projection_schema.js";
import { csvJobSchedulerMigration } from "./021_csv_job_scheduler.js";
import { workflowHandoffArtifactsMigration } from "./022_workflow_handoff_artifacts.js";
import { setBasedCancellationIndexesMigration } from "./023_set_based_cancellation_indexes.js";
import { compactionTransactionMigration } from "./024_compaction_transaction.js";
import { csvOutputWriterIdentityMigration } from "./025_csv_output_writer_identity.js";
import { csvOutputOrphanAccountingMigration } from "./026_csv_output_orphan_accounting.js";
import { runSuspensionSchemaMigration } from "./027_run_suspension_schema.js";
import { runtimeSettingsCanonicalValuesMigration } from "./028_runtime_settings_canonical_values.js";
import { terminalAgentRunReconciliationMigration } from "./029_terminal_agent_run_reconciliation.js";
import { runtimeSettingsPermissionCapabilitiesMigration } from "./030_runtime_settings_permission_capabilities.js";
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
  threadListingIndexesMigration,
  executionAdmissionSchemaMigration,
  runDurabilitySchemaMigration,
  runEffectsSessionCallStepIndexMigration,
  effectEvidenceV2Migration,
  runRecoverySchemaMigration,
  csvJobIdentityReplayMigration,
  toolPairProjectionSchemaMigration,
  csvJobSchedulerMigration,
  workflowHandoffArtifactsMigration,
  setBasedCancellationIndexesMigration,
  compactionTransactionMigration,
  csvOutputWriterIdentityMigration,
  csvOutputOrphanAccountingMigration,
  runSuspensionSchemaMigration,
  runtimeSettingsCanonicalValuesMigration,
  terminalAgentRunReconciliationMigration,
  runtimeSettingsPermissionCapabilitiesMigration,
];

export const LOGS_DB_MIGRATIONS: readonly SqlMigration[] = [
  initialLogsSchemaMigration,
];

export type { SqlMigration } from "./types.js";
