import type { SqlMigration } from "./types.js";
import { runSuspensionSchemaMigration } from "./027_run_suspension_schema.js";

// Preserve every lifecycle row and constraint while widening only the reason
// vocabulary. The source migration is immutable and also owns the indexes.
const suspensionSchema = runSuspensionSchemaMigration.sql!.split("CREATE TABLE IF NOT EXISTS run_runtime_settings")[0]!
  .replace("CHECK (reason = 'daemon_shutdown_idle')", "CHECK (reason IN ('daemon_shutdown_idle', 'workflow_user_pause'))")
  .replace("('daemon_startup_restore', 'explicit_continue')", "('daemon_startup_restore', 'explicit_continue', 'workflow_user_resume')");

export const workflowPauseMigration: SqlMigration = {
  version: 37,
  name: "workflow_pause",
  sql: `
DROP INDEX idx_run_suspensions_resume_event;
DROP INDEX idx_run_suspensions_unresolved_epoch;
DROP INDEX idx_run_suspensions_activation_event;
DROP INDEX idx_run_suspensions_current;
ALTER TABLE run_suspensions RENAME TO run_suspensions_before_workflow_pause;
${suspensionSchema}
INSERT INTO run_suspensions SELECT * FROM run_suspensions_before_workflow_pause;
DROP TABLE run_suspensions_before_workflow_pause;
`,
};
