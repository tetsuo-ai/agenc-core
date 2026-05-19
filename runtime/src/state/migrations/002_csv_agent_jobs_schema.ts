import type { SqlMigration } from "./types.js";

/**
 * CSV agent job persistence schema.
 */
export const csvAgentJobsSchemaMigration: SqlMigration = {
  version: 2,
  name: "csv_agent_jobs_schema",
  sql: `
-- Imported agent-jobs surface, persisted. Tables are namespaced \`csv_*\` so
-- they do not collide with AgenC's pre-existing \`agent_jobs\` queue table
-- which carries a different schema (kind/priority/worker_id/...).
--
-- Mirrors the upstream batch-job schema with the max-runtime column folded in.
CREATE TABLE IF NOT EXISTS csv_agent_jobs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  instruction TEXT NOT NULL,
  output_schema_json TEXT,
  input_headers_json TEXT NOT NULL,
  input_csv_path TEXT NOT NULL,
  output_csv_path TEXT NOT NULL,
  auto_export INTEGER NOT NULL DEFAULT 1,
  max_runtime_seconds INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  last_error TEXT
);

CREATE TABLE IF NOT EXISTS csv_agent_job_items (
  job_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  row_index INTEGER NOT NULL,
  source_id TEXT,
  row_json TEXT NOT NULL,
  status TEXT NOT NULL,
  assigned_thread_id TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  result_json TEXT,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  reported_at INTEGER,
  PRIMARY KEY (job_id, item_id),
  FOREIGN KEY(job_id) REFERENCES csv_agent_jobs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_csv_agent_jobs_status
  ON csv_agent_jobs(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_csv_agent_job_items_status
  ON csv_agent_job_items(job_id, status, row_index ASC);
`,
};
