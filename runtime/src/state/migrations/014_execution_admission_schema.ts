import type { SqliteDatabase } from "../sqlite-driver.js";
import type { SqlMigration } from "./types.js";

export const EXECUTION_ADMISSION_SCHEMA_VERSION = 14;

interface TableColumnRow {
  readonly name: string;
}

function tableExists(db: SqliteDatabase, table: string): boolean {
  return (
    db
      .prepare<[string], { readonly name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get(table) !== undefined
  );
}

function addAgentJobColumn(
  db: SqliteDatabase,
  columns: Set<string>,
  name: string,
  declaration: string,
): void {
  if (columns.has(name)) return;
  db.exec(`ALTER TABLE agent_jobs ADD COLUMN ${name} ${declaration}`);
  columns.add(name);
}

/**
 * Durable execution admission state.
 *
 * The pre-existing generic `agent_jobs` table remains the sole persisted work
 * queue. Admission-specific columns are nullable so legacy/non-admission jobs
 * retain their exact shape and behavior. Reservations, hierarchical allocation
 * accounts, cancellation locks, and the append-only decision journal use
 * dedicated tables because they have different retention and idempotency
 * requirements from a queue row.
 */
export const executionAdmissionSchemaMigration: SqlMigration = {
  version: EXECUTION_ADMISSION_SCHEMA_VERSION,
  name: "execution_admission_schema",
  apply: (db) => {
    // Artificial migration fixtures may contain only one historical table.
    // Every real v1+ state database has `agent_jobs`; record v14 as a no-op for
    // incomplete fixtures instead of manufacturing a second queue.
    if (!tableExists(db, "agent_jobs")) return;

    const columns = new Set(
      db
        .prepare<[], TableColumnRow>("PRAGMA table_info(agent_jobs)")
        .all()
        .map((column) => column.name),
    );
    addAgentJobColumn(db, columns, "admission_run_id", "TEXT");
    addAgentJobColumn(db, columns, "admission_step_id", "TEXT");
    addAgentJobColumn(db, columns, "admission_parent_run_id", "TEXT");
    addAgentJobColumn(db, columns, "admission_workspace_id", "TEXT");
    addAgentJobColumn(db, columns, "admission_session_id", "TEXT");
    addAgentJobColumn(db, columns, "admission_parent_id", "TEXT");
    addAgentJobColumn(db, columns, "admission_provider", "TEXT");
    addAgentJobColumn(db, columns, "admission_model", "TEXT");
    addAgentJobColumn(db, columns, "admission_autonomous", "INTEGER");
    addAgentJobColumn(db, columns, "admission_deadline_at", "TEXT");
    addAgentJobColumn(db, columns, "admission_approval_required", "INTEGER");
    addAgentJobColumn(db, columns, "admission_max_input_tokens", "INTEGER");
    addAgentJobColumn(db, columns, "admission_max_output_tokens", "INTEGER");
    addAgentJobColumn(db, columns, "admission_max_cost_nanos", "INTEGER");
    addAgentJobColumn(db, columns, "admission_attempts", "INTEGER");
    addAgentJobColumn(db, columns, "admission_queue_sequence", "INTEGER");
    addAgentJobColumn(db, columns, "admission_owner_pid", "INTEGER");
    addAgentJobColumn(db, columns, "admission_owner_id", "TEXT");
    addAgentJobColumn(
      db,
      columns,
      "admission_attached",
      "INTEGER NOT NULL DEFAULT 0",
    );
    addAgentJobColumn(db, columns, "admission_admitted_at", "TEXT");
    addAgentJobColumn(db, columns, "admission_dispatched_at", "TEXT");
    addAgentJobColumn(db, columns, "admission_completed_at", "TEXT");
    addAgentJobColumn(db, columns, "admission_reason", "TEXT");
    addAgentJobColumn(db, columns, "admission_reservation_id", "TEXT");

    db.exec(`
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_jobs_admission_step
  ON agent_jobs(admission_run_id, admission_step_id)
  WHERE admission_run_id IS NOT NULL AND admission_step_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_jobs_admission_queue_sequence
  ON agent_jobs(admission_queue_sequence)
  WHERE admission_queue_sequence IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_agent_jobs_admission_claim
  ON agent_jobs(status, available_at, priority DESC, admission_queue_sequence ASC)
  WHERE admission_run_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_agent_jobs_admission_deadline
  ON agent_jobs(status, admission_deadline_at, admission_queue_sequence)
  WHERE admission_run_id IS NOT NULL AND admission_deadline_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_agent_jobs_admission_workspace_active
  ON agent_jobs(admission_workspace_id, status, admission_queue_sequence)
  WHERE admission_run_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_agent_jobs_admission_session_active
  ON agent_jobs(admission_session_id, status, admission_queue_sequence)
  WHERE admission_run_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_agent_jobs_admission_parent_active
  ON agent_jobs(admission_parent_id, status, admission_queue_sequence)
  WHERE admission_run_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_agent_jobs_admission_parent_run
  ON agent_jobs(admission_parent_run_id, admission_run_id)
  WHERE admission_parent_run_id IS NOT NULL
    AND admission_run_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_agent_jobs_admission_provider_active
  ON agent_jobs(admission_provider, status, admission_queue_sequence)
  WHERE admission_run_id IS NOT NULL AND admission_provider IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_agent_jobs_admission_reservation
  ON agent_jobs(admission_reservation_id)
  WHERE admission_reservation_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS execution_admission_allocations (
  scope_key TEXT PRIMARY KEY,
  owner_run_id TEXT NOT NULL,
  parent_scope_key TEXT,
  max_tokens INTEGER,
  max_cost_nanos INTEGER,
  used_tokens INTEGER NOT NULL DEFAULT 0,
  used_cost_nanos INTEGER NOT NULL DEFAULT 0,
  held_tokens INTEGER NOT NULL DEFAULT 0,
  held_cost_nanos INTEGER NOT NULL DEFAULT 0,
  blocked_by_provider_overrun INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (length(scope_key) > 0),
  CHECK (length(owner_run_id) > 0),
  CHECK (max_tokens IS NULL OR max_tokens >= 0),
  CHECK (max_cost_nanos IS NULL OR max_cost_nanos >= 0),
  CHECK (used_tokens >= 0),
  CHECK (used_cost_nanos >= 0),
  CHECK (held_tokens >= 0),
  CHECK (held_cost_nanos >= 0),
  CHECK (blocked_by_provider_overrun IN (0, 1))
);

CREATE INDEX IF NOT EXISTS idx_execution_admission_allocations_owner
  ON execution_admission_allocations(owner_run_id, scope_key);

CREATE INDEX IF NOT EXISTS idx_execution_admission_allocations_parent
  ON execution_admission_allocations(parent_scope_key, scope_key)
  WHERE parent_scope_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS execution_admission_run_limits (
  run_id TEXT PRIMARY KEY,
  deadline_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (length(run_id) > 0),
  CHECK (deadline_at IS NULL OR length(deadline_at) > 0)
);

CREATE INDEX IF NOT EXISTS idx_execution_admission_run_limits_deadline
  ON execution_admission_run_limits(deadline_at, run_id)
  WHERE deadline_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS execution_admission_reservations (
  reservation_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  parent_run_id TEXT,
  kind TEXT NOT NULL,
  model TEXT,
  provider TEXT,
  status TEXT NOT NULL,
  reserved_input_tokens INTEGER NOT NULL,
  reserved_output_tokens INTEGER NOT NULL,
  reserved_tokens INTEGER NOT NULL,
  reserved_cost_nanos INTEGER NOT NULL,
  actual_input_tokens INTEGER,
  actual_output_tokens INTEGER,
  actual_tokens INTEGER,
  actual_cost_nanos INTEGER,
  provider_request_id TEXT,
  dispatched_at TEXT,
  resolved_at TEXT,
  resolution_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (job_id) REFERENCES agent_jobs(id) ON DELETE RESTRICT,
  UNIQUE (run_id, step_id, attempt),
  CHECK (status IN (
    'reserved', 'dispatched', 'reconciled', 'voided',
    'held_unknown', 'provider_overrun'
  )),
  CHECK (attempt > 0),
  CHECK (reserved_input_tokens >= 0),
  CHECK (reserved_output_tokens >= 0),
  CHECK (reserved_tokens >= 0),
  CHECK (reserved_cost_nanos >= 0),
  CHECK (actual_input_tokens IS NULL OR actual_input_tokens >= 0),
  CHECK (actual_output_tokens IS NULL OR actual_output_tokens >= 0),
  CHECK (actual_tokens IS NULL OR actual_tokens >= 0),
  CHECK (actual_cost_nanos IS NULL OR actual_cost_nanos >= 0)
);

CREATE INDEX IF NOT EXISTS idx_execution_admission_reservations_status
  ON execution_admission_reservations(status, updated_at, reservation_id);

CREATE INDEX IF NOT EXISTS idx_execution_admission_reservations_run
  ON execution_admission_reservations(run_id, created_at, reservation_id);

CREATE INDEX IF NOT EXISTS idx_execution_admission_reservations_job
  ON execution_admission_reservations(job_id, attempt);

CREATE TABLE IF NOT EXISTS execution_admission_reservation_allocations (
  reservation_id TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  reserved_tokens INTEGER NOT NULL,
  reserved_cost_nanos INTEGER NOT NULL,
  PRIMARY KEY (reservation_id, scope_key),
  FOREIGN KEY (reservation_id)
    REFERENCES execution_admission_reservations(reservation_id) ON DELETE RESTRICT,
  FOREIGN KEY (scope_key)
    REFERENCES execution_admission_allocations(scope_key) ON DELETE RESTRICT,
  CHECK (reserved_tokens >= 0),
  CHECK (reserved_cost_nanos >= 0)
);

CREATE INDEX IF NOT EXISTS idx_execution_admission_reservation_allocations_scope
  ON execution_admission_reservation_allocations(scope_key, reservation_id);

CREATE TABLE IF NOT EXISTS execution_admission_cancellations (
  run_id TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  cancelled_at TEXT NOT NULL,
  CHECK (length(run_id) > 0),
  CHECK (length(reason) > 0)
);

CREATE TABLE IF NOT EXISTS execution_admission_journal (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  timestamp TEXT NOT NULL,
  job_id TEXT,
  reservation_id TEXT,
  run_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  event TEXT NOT NULL,
  reason TEXT,
  model TEXT,
  provider TEXT,
  reserved_tokens INTEGER,
  reserved_cost_nanos INTEGER,
  actual_tokens INTEGER,
  actual_cost_nanos INTEGER,
  details_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY (job_id) REFERENCES agent_jobs(id) ON DELETE RESTRICT,
  FOREIGN KEY (reservation_id)
    REFERENCES execution_admission_reservations(reservation_id) ON DELETE RESTRICT,
  CHECK (length(event_id) > 0),
  CHECK (length(run_id) > 0),
  CHECK (length(step_id) > 0),
  CHECK (event IN (
    'queued', 'allowed', 'denied', 'approval_required', 'dispatched',
    'reconciled', 'voided', 'held_unknown', 'provider_overrun',
    'cancelled', 'recovered', 'fallback'
  )),
  CHECK (reserved_tokens IS NULL OR reserved_tokens >= 0),
  CHECK (reserved_cost_nanos IS NULL OR reserved_cost_nanos >= 0),
  CHECK (actual_tokens IS NULL OR actual_tokens >= 0),
  CHECK (actual_cost_nanos IS NULL OR actual_cost_nanos >= 0)
);

CREATE INDEX IF NOT EXISTS idx_execution_admission_journal_run_sequence
  ON execution_admission_journal(run_id, sequence);

CREATE INDEX IF NOT EXISTS idx_execution_admission_journal_step_sequence
  ON execution_admission_journal(run_id, step_id, sequence);

CREATE INDEX IF NOT EXISTS idx_execution_admission_journal_reservation
  ON execution_admission_journal(reservation_id, sequence)
  WHERE reservation_id IS NOT NULL;
`);
  },
};
