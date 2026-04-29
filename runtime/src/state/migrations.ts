export interface SqlMigration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export const STATE_DB_MIGRATIONS: readonly SqlMigration[] = [
  {
    version: 1,
    name: "initial_state_schema",
    sql: `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS import_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  finished_at TEXT,
  status TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS import_errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER,
  source_path TEXT,
  message TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (run_id) REFERENCES import_runs(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS threads (
  thread_id TEXT PRIMARY KEY,
  name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  cwd TEXT,
  originator TEXT,
  source_json TEXT,
  forked_from_id TEXT,
  model TEXT,
  model_provider TEXT,
  memory_mode TEXT,
  rollout_path TEXT,
  archived_rollout_path TEXT,
  last_import_run_id INTEGER,
  last_item_index INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (last_import_run_id) REFERENCES import_runs(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS thread_rollout_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT NOT NULL,
  source_path TEXT NOT NULL,
  line_number INTEGER NOT NULL,
  byte_offset INTEGER NOT NULL,
  item_index INTEGER NOT NULL,
  item_type TEXT NOT NULL,
  event_version INTEGER,
  event_id TEXT,
  event_seq INTEGER,
  payload_json TEXT NOT NULL,
  line_hash TEXT NOT NULL,
  imported_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (thread_id) REFERENCES threads(thread_id) ON DELETE CASCADE,
  UNIQUE (source_path, line_number)
);

CREATE INDEX IF NOT EXISTS idx_thread_rollout_items_thread
  ON thread_rollout_items(thread_id, item_index);

CREATE TABLE IF NOT EXISTS thread_spawn_edges (
  child_thread_id TEXT PRIMARY KEY,
  parent_thread_id TEXT NOT NULL,
  source_thread_id TEXT,
  source_path TEXT,
  call_id TEXT,
  parent_path TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_thread_spawn_edges_parent
  ON thread_spawn_edges(parent_thread_id);

CREATE TABLE IF NOT EXISTS rollout_receipts (
  thread_id TEXT NOT NULL,
  source_path TEXT NOT NULL,
  source_mtime_ms REAL NOT NULL,
  source_size INTEGER NOT NULL,
  source_sha256 TEXT NOT NULL,
  imported_line_count INTEGER NOT NULL,
  imported_item_count INTEGER NOT NULL,
  imported_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (thread_id, source_path),
  FOREIGN KEY (thread_id) REFERENCES threads(thread_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS backfill_files (
  source_path TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  mtime_ms REAL NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  line_count INTEGER NOT NULL,
  item_count INTEGER NOT NULL,
  last_import_run_id INTEGER,
  imported_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (thread_id) REFERENCES threads(thread_id) ON DELETE CASCADE,
  FOREIGN KEY (last_import_run_id) REFERENCES import_runs(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS memory_jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  input_json TEXT NOT NULL,
  result_json TEXT,
  error TEXT,
  worker_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  available_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_jobs_claim
  ON memory_jobs(status, available_at, priority, created_at);

CREATE TABLE IF NOT EXISTS agent_jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  input_json TEXT NOT NULL,
  result_json TEXT,
  error TEXT,
  worker_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  available_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_jobs_claim
  ON agent_jobs(status, available_at, priority, created_at);

CREATE TABLE IF NOT EXISTS agent_job_items (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  input_json TEXT NOT NULL,
  result_json TEXT,
  error TEXT,
  worker_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  available_at TEXT NOT NULL,
  FOREIGN KEY (job_id) REFERENCES agent_jobs(id) ON DELETE CASCADE,
  UNIQUE (job_id, ordinal)
);

CREATE INDEX IF NOT EXISTS idx_agent_job_items_claim
  ON agent_job_items(status, available_at, ordinal);

CREATE TABLE IF NOT EXISTS remote_control_storage (
  project_key TEXT NOT NULL,
  namespace TEXT NOT NULL,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_key, namespace, key)
);

CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  level TEXT NOT NULL,
  scope TEXT,
  thread_id TEXT,
  event_type TEXT,
  message TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp);
CREATE INDEX IF NOT EXISTS idx_logs_thread ON logs(thread_id, timestamp);
`,
  },
];

export const LOGS_DB_MIGRATIONS: readonly SqlMigration[] = [
  {
    version: 1,
    name: "initial_logs_schema",
    sql: `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  level TEXT NOT NULL,
  scope TEXT,
  thread_id TEXT,
  event_type TEXT,
  message TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp);
CREATE INDEX IF NOT EXISTS idx_logs_thread ON logs(thread_id, timestamp);
`,
  },
];
