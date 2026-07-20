import type { SqlMigration } from "./types.js";

export const RUN_EFFECTS_SESSION_CALL_STEP_INDEX_VERSION = 16;

/**
 * Allow one `run_effects` row per (session, call, step) instead of per
 * (session, call).
 *
 * Physical re-dispatches of the same logical tool call — bounded transient
 * retry and sandbox escalation in the orchestrator — register one effect
 * intent per admission step; the stepId carries a `:dispatchN` suffix so the
 * durable anti-duplicate guarantee (PRIMARY KEY (run_id, step_id) plus
 * `beginEffect`'s intent-content conflict check) still holds. The previous
 * UNIQUE(session_id, call_id) index wrongly forbade the legitimate second
 * attempt: a sandbox-escalated Write died with
 * `UNIQUE constraint failed: run_effects.session_id, run_effects.call_id`
 * instead of running unsandboxed, and the model retried in a loop.
 */
export const runEffectsSessionCallStepIndexMigration: SqlMigration = {
  version: RUN_EFFECTS_SESSION_CALL_STEP_INDEX_VERSION,
  name: "run_effects_session_call_step_index",
  sql: `
DROP INDEX IF EXISTS idx_run_effects_session_call;
CREATE UNIQUE INDEX IF NOT EXISTS idx_run_effects_session_call_step
  ON run_effects(session_id, call_id, step_id);
`,
};
