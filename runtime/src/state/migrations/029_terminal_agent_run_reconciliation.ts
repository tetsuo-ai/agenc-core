import type { SqliteDatabase } from "../sqlite-driver.js";
import type { SqlMigration } from "./types.js";

export const TERMINAL_AGENT_RUN_RECONCILIATION_SCHEMA_VERSION = 29;

function tableExists(db: SqliteDatabase, table: string): boolean {
  return (
    db
      .prepare<[string], { readonly name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get(table) !== undefined
  );
}

/**
 * Repair compatibility rail rows written before terminal projection and the
 * agent-run status were committed together. Only a terminal for the latest
 * lifecycle epoch is authoritative; a reopened run with no new terminal stays
 * running, child runs without a rail row remain absent, and cancel-locked rows
 * retain their stronger operator/recovery verdict.
 */
export const terminalAgentRunReconciliationMigration: SqlMigration = {
  version: TERMINAL_AGENT_RUN_RECONCILIATION_SCHEMA_VERSION,
  name: "terminal_agent_run_reconciliation",
  apply(db) {
    if (
      !tableExists(db, "agent_runs") ||
      !tableExists(db, "run_lifecycle_epochs") ||
      !tableExists(db, "run_terminal_results")
    ) {
      return;
    }
    db.exec(`
      WITH current_terminal AS (
        SELECT terminal.run_id, terminal.status, terminal.finished_at
        FROM run_terminal_results AS terminal
        JOIN (
          SELECT run_id, MAX(epoch) AS epoch
          FROM run_lifecycle_epochs
          GROUP BY run_id
        ) AS current_epoch
          ON current_epoch.run_id = terminal.run_id
         AND current_epoch.epoch = terminal.epoch
      )
      UPDATE agent_runs
      SET status = (
            SELECT current_terminal.status
            FROM current_terminal
            WHERE current_terminal.run_id = agent_runs.id
          ),
          last_active_at = (
            SELECT current_terminal.finished_at
            FROM current_terminal
            WHERE current_terminal.run_id = agent_runs.id
          )
      WHERE status NOT IN ('cancelled', 'unknown_outcome')
        AND EXISTS (
          SELECT 1
          FROM current_terminal
          WHERE current_terminal.run_id = agent_runs.id
        );
    `);
  },
};
