import type { SqlMigration } from "./types.js";

export const SET_BASED_CANCELLATION_SCHEMA_VERSION = 23;

/** Index every directed lookup used by bounded cancellation/ancestor CTEs. */
export const setBasedCancellationIndexesMigration: SqlMigration = {
  version: SET_BASED_CANCELLATION_SCHEMA_VERSION,
  name: "set_based_cancellation_indexes",
  apply: (db) => {
    if (tableExists(db, "thread_spawn_edges")) {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_thread_spawn_edges_parent_child
          ON thread_spawn_edges(parent_thread_id, child_thread_id);
        CREATE INDEX IF NOT EXISTS idx_thread_spawn_edges_child_parent
          ON thread_spawn_edges(child_thread_id, parent_thread_id);
      `);
    }
    if (
      tableExists(db, "agent_jobs") &&
      columnExists(db, "agent_jobs", "admission_run_id") &&
      columnExists(db, "agent_jobs", "admission_parent_run_id")
    ) {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_agent_jobs_admission_parent_run
          ON agent_jobs(admission_parent_run_id, admission_run_id)
          WHERE admission_parent_run_id IS NOT NULL
            AND admission_run_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_agent_jobs_admission_run_parent
          ON agent_jobs(admission_run_id, admission_parent_run_id)
          WHERE admission_run_id IS NOT NULL
            AND admission_parent_run_id IS NOT NULL;
      `);
    }
  },
};

function tableExists(
  db: Parameters<NonNullable<SqlMigration["apply"]>>[0],
  table: string,
): boolean {
  return (
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table) !== undefined
  );
}

function columnExists(
  db: Parameters<NonNullable<SqlMigration["apply"]>>[0],
  table: string,
  column: string,
): boolean {
  return db
    .prepare<[], { readonly name: string }>(`PRAGMA table_info(${table})`)
    .all()
    .some((row) => row.name === column);
}
