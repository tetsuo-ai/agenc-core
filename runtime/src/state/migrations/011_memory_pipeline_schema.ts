import type { SqlMigration } from "./types.js";

interface TableColumnRow {
  readonly name: string;
}

/**
 * Persist the MM-01 stage1/phase2 memory pipeline state.
 */
export const memoryPipelineSchemaMigration: SqlMigration = {
  version: 11,
  name: "memory_pipeline_schema",
  apply: (db) => {
    db.exec(`
CREATE TABLE IF NOT EXISTS stage1_outputs (
  thread_id TEXT PRIMARY KEY,
  rollout_path TEXT NOT NULL DEFAULT '',
  source_updated_at INTEGER NOT NULL,
  raw_memory TEXT NOT NULL,
  rollout_summary TEXT NOT NULL,
  rollout_slug TEXT,
  generated_at INTEGER NOT NULL,
  usage_count INTEGER NOT NULL DEFAULT 0,
  last_usage INTEGER,
  selected_for_phase2 INTEGER NOT NULL DEFAULT 0,
  selected_for_phase2_source_updated_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_stage1_outputs_phase2
  ON stage1_outputs(selected_for_phase2, source_updated_at);

CREATE INDEX IF NOT EXISTS idx_stage1_outputs_retention
  ON stage1_outputs(selected_for_phase2, last_usage, source_updated_at);
`);

    if (hasTable(db, "memory_jobs")) {
      addColumnIfMissing(db, "memory_jobs", "job_key", "TEXT");
      addColumnIfMissing(db, "memory_jobs", "ownership_token", "TEXT");
      addColumnIfMissing(db, "memory_jobs", "started_at", "INTEGER");
      addColumnIfMissing(db, "memory_jobs", "finished_at", "INTEGER");
      addColumnIfMissing(db, "memory_jobs", "lease_until", "INTEGER");
      addColumnIfMissing(db, "memory_jobs", "retry_at", "INTEGER");
      addColumnIfMissing(db, "memory_jobs", "retry_remaining", "INTEGER");
      addColumnIfMissing(db, "memory_jobs", "last_error", "TEXT");
      addColumnIfMissing(db, "memory_jobs", "input_watermark", "INTEGER");
      addColumnIfMissing(db, "memory_jobs", "last_success_watermark", "INTEGER");
      db.exec(`
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_jobs_kind_job_key
  ON memory_jobs(kind, job_key)
  WHERE job_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_memory_jobs_pipeline_claim
  ON memory_jobs(kind, status, lease_until, retry_at);
`);
    }
  },
};

function hasTable(
  db: Parameters<NonNullable<SqlMigration["apply"]>>[0],
  table: string,
): boolean {
  return (
    db
      .prepare<[string], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get(table) !== undefined
  );
}

function hasColumn(
  db: Parameters<NonNullable<SqlMigration["apply"]>>[0],
  table: string,
  column: string,
): boolean {
  return db
    .prepare<[], TableColumnRow>(`PRAGMA table_info(${table})`)
    .all()
    .some((row) => row.name === column);
}

function addColumnIfMissing(
  db: Parameters<NonNullable<SqlMigration["apply"]>>[0],
  table: string,
  column: string,
  definition: string,
): void {
  if (!hasColumn(db, table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
