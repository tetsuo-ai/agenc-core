import type { SqliteDatabase } from "../sqlite-driver.js";
import type { SqlMigration } from "./types.js";

export const RUN_DURABILITY_SCHEMA_VERSION = 15;

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
 * Durable M4 run state and rebuildable rollout projections.
 *
 * The append-only rollout JSONL remains the canonical event journal. These
 * tables retain lifecycle/effect state that must survive restart and bind a
 * run to the existing `thread_rollout_items` projection; they never copy event
 * payloads into a competing journal.
 */
export const runDurabilitySchemaMigration: SqlMigration = {
  version: RUN_DURABILITY_SCHEMA_VERSION,
  name: "run_durability_schema",
  sql: `
CREATE TABLE IF NOT EXISTS run_lifecycle_epochs (
  run_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  opened_at TEXT NOT NULL,
  opened_event_id TEXT,
  reopened_from_epoch INTEGER,
  reopen_reason TEXT,
  PRIMARY KEY (run_id, epoch),
  FOREIGN KEY (run_id, reopened_from_epoch)
    REFERENCES run_lifecycle_epochs(run_id, epoch) ON DELETE RESTRICT,
  CHECK (length(run_id) > 0),
  CHECK (epoch > 0),
  CHECK (length(opened_at) > 0),
  CHECK (opened_event_id IS NULL OR length(opened_event_id) > 0),
  CHECK (
    (epoch = 1 AND reopened_from_epoch IS NULL AND reopen_reason IS NULL)
    OR
    (epoch > 1 AND reopened_from_epoch = epoch - 1
      AND reopen_reason IS NOT NULL AND length(reopen_reason) > 0
      AND opened_event_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_run_lifecycle_epochs_opened_event
  ON run_lifecycle_epochs(run_id, opened_event_id)
  WHERE opened_event_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_run_lifecycle_epochs_current
  ON run_lifecycle_epochs(run_id, epoch DESC);

CREATE TABLE IF NOT EXISTS run_terminal_results (
  run_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  status TEXT NOT NULL,
  exit_code INTEGER,
  stop_reason TEXT,
  final_message TEXT,
  usage_json TEXT,
  last_sequence INTEGER,
  finished_at TEXT NOT NULL,
  event_id TEXT NOT NULL,
  PRIMARY KEY (run_id, epoch),
  FOREIGN KEY (run_id, epoch)
    REFERENCES run_lifecycle_epochs(run_id, epoch) ON DELETE RESTRICT,
  CHECK (status IN ('completed', 'failed', 'cancelled', 'unknown_outcome')),
  CHECK (usage_json IS NULL OR json_valid(usage_json)),
  CHECK (last_sequence IS NULL OR last_sequence > 0),
  CHECK (length(finished_at) > 0),
  CHECK (length(event_id) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_run_terminal_results_event
  ON run_terminal_results(run_id, event_id);

CREATE INDEX IF NOT EXISTS idx_run_terminal_results_finished
  ON run_terminal_results(finished_at, run_id, epoch);

CREATE TRIGGER IF NOT EXISTS run_terminal_results_are_immutable
BEFORE UPDATE ON run_terminal_results
BEGIN
  SELECT RAISE(ABORT, 'run terminal result is immutable; explicitly reopen the run');
END;

CREATE TABLE IF NOT EXISTS run_effects (
  run_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  child_run_id TEXT,
  session_id TEXT NOT NULL,
  call_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  recovery_category TEXT NOT NULL,
  idempotency_key TEXT,
  intent_digest TEXT NOT NULL,
  intent_event_id TEXT NOT NULL,
  intent_sequence INTEGER NOT NULL,
  intent_at TEXT NOT NULL,
  outcome TEXT,
  result_event_id TEXT,
  result_sequence INTEGER,
  result_digest TEXT,
  result_json TEXT,
  evidence_json TEXT,
  unknown_reason TEXT,
  completed_at TEXT,
  review_status TEXT NOT NULL DEFAULT 'none',
  reviewed_at TEXT,
  reviewed_by TEXT,
  review_resolution TEXT,
  review_event_id TEXT,
  review_evidence_json TEXT,
  PRIMARY KEY (run_id, step_id),
  FOREIGN KEY (run_id, epoch)
    REFERENCES run_lifecycle_epochs(run_id, epoch) ON DELETE RESTRICT,
  CHECK (length(run_id) > 0),
  CHECK (length(step_id) > 0),
  CHECK (epoch > 0),
  CHECK (child_run_id IS NULL OR length(child_run_id) > 0),
  CHECK (length(session_id) > 0),
  CHECK (length(call_id) > 0),
  CHECK (length(tool_name) > 0),
  CHECK (recovery_category IN ('idempotent', 'side-effecting', 'interactive')),
  CHECK (
    (recovery_category = 'idempotent'
      AND idempotency_key IS NOT NULL AND length(idempotency_key) > 0)
    OR
    (recovery_category <> 'idempotent' AND idempotency_key IS NULL)
  ),
  CHECK (length(intent_digest) > 0),
  CHECK (length(intent_event_id) > 0),
  CHECK (intent_sequence > 0),
  CHECK (length(intent_at) > 0),
  CHECK (outcome IS NULL OR outcome IN (
    'committed', 'failed', 'cancelled', 'unknown_outcome'
  )),
  CHECK (
    (outcome IS NULL
      AND result_event_id IS NULL AND result_sequence IS NULL
      AND result_digest IS NULL AND result_json IS NULL
      AND evidence_json IS NULL AND unknown_reason IS NULL
      AND completed_at IS NULL AND review_status = 'none')
    OR
    (outcome IS NOT NULL
      AND result_event_id IS NOT NULL AND length(result_event_id) > 0
      AND result_sequence IS NOT NULL AND result_sequence > 0
      AND completed_at IS NOT NULL AND length(completed_at) > 0)
  ),
  CHECK (result_json IS NULL OR json_valid(result_json)),
  CHECK (evidence_json IS NULL OR json_valid(evidence_json)),
  CHECK (
    (outcome = 'unknown_outcome'
      AND recovery_category IN ('side-effecting', 'interactive')
      AND unknown_reason IS NOT NULL AND length(unknown_reason) > 0
      AND review_status IN ('pending', 'resolved'))
    OR
    ((outcome IS NULL OR outcome <> 'unknown_outcome')
      AND unknown_reason IS NULL AND review_status = 'none')
  ),
  CHECK (
    (review_status IN ('none', 'pending')
      AND reviewed_at IS NULL AND reviewed_by IS NULL
      AND review_resolution IS NULL AND review_event_id IS NULL
      AND review_evidence_json IS NULL)
    OR
    (review_status = 'resolved'
      AND reviewed_at IS NOT NULL AND length(reviewed_at) > 0
      AND reviewed_by IS NOT NULL AND length(reviewed_by) > 0
      AND review_resolution IS NOT NULL AND length(review_resolution) > 0
      AND review_event_id IS NOT NULL AND length(review_event_id) > 0
      AND (review_evidence_json IS NULL OR json_valid(review_evidence_json)))
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_run_effects_intent_sequence
  ON run_effects(run_id, intent_sequence);

CREATE UNIQUE INDEX IF NOT EXISTS idx_run_effects_result_sequence
  ON run_effects(run_id, result_sequence)
  WHERE result_sequence IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_run_effects_pending_review
  ON run_effects(run_id, review_status, intent_sequence)
  WHERE review_status = 'pending';

CREATE INDEX IF NOT EXISTS idx_run_effects_session
  ON run_effects(session_id, intent_sequence);

CREATE UNIQUE INDEX IF NOT EXISTS idx_run_effects_session_call
  ON run_effects(session_id, call_id);

CREATE TRIGGER IF NOT EXISTS run_effect_intent_is_immutable
BEFORE UPDATE ON run_effects
WHEN OLD.run_id IS NOT NEW.run_id
  OR OLD.step_id IS NOT NEW.step_id
  OR OLD.epoch IS NOT NEW.epoch
  OR OLD.child_run_id IS NOT NEW.child_run_id
  OR OLD.session_id IS NOT NEW.session_id
  OR OLD.call_id IS NOT NEW.call_id
  OR OLD.tool_name IS NOT NEW.tool_name
  OR OLD.recovery_category IS NOT NEW.recovery_category
  OR OLD.idempotency_key IS NOT NEW.idempotency_key
  OR OLD.intent_digest IS NOT NEW.intent_digest
  OR OLD.intent_event_id IS NOT NEW.intent_event_id
  OR OLD.intent_sequence IS NOT NEW.intent_sequence
  OR OLD.intent_at IS NOT NEW.intent_at
BEGIN
  SELECT RAISE(ABORT, 'run effect intent is immutable');
END;

CREATE TRIGGER IF NOT EXISTS run_effect_outcome_is_sticky
BEFORE UPDATE ON run_effects
WHEN OLD.outcome IS NOT NULL AND (
  OLD.outcome IS NOT NEW.outcome
  OR OLD.result_event_id IS NOT NEW.result_event_id
  OR OLD.result_sequence IS NOT NEW.result_sequence
  OR OLD.result_digest IS NOT NEW.result_digest
  OR OLD.result_json IS NOT NEW.result_json
  OR OLD.evidence_json IS NOT NEW.evidence_json
  OR OLD.unknown_reason IS NOT NEW.unknown_reason
  OR OLD.completed_at IS NOT NEW.completed_at
)
BEGIN
  SELECT RAISE(ABORT, 'run effect outcome is immutable');
END;

CREATE TRIGGER IF NOT EXISTS run_effect_review_is_monotonic
BEFORE UPDATE ON run_effects
WHEN NOT (
  OLD.review_status = NEW.review_status
  OR (OLD.review_status = 'none' AND NEW.review_status = 'pending')
  OR (OLD.review_status = 'pending' AND NEW.review_status = 'resolved')
)
BEGIN
  SELECT RAISE(ABORT, 'run effect review state cannot move backwards');
END;

CREATE TABLE IF NOT EXISTS run_journal_bindings (
  run_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  child_run_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  source_path TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  first_available_sequence INTEGER,
  last_sequence INTEGER,
  retired_through_sequence INTEGER,
  gap_reason TEXT,
  gap_observed_at TEXT,
  bound_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (run_id, epoch, source_path),
  UNIQUE (source_path),
  FOREIGN KEY (run_id, epoch)
    REFERENCES run_lifecycle_epochs(run_id, epoch) ON DELETE RESTRICT,
  CHECK (length(run_id) > 0),
  CHECK (epoch > 0),
  CHECK (length(child_run_id) > 0),
  CHECK (length(session_id) > 0),
  CHECK (length(source_path) > 0),
  CHECK (active IN (0, 1)),
  CHECK (first_available_sequence IS NULL OR first_available_sequence > 0),
  CHECK (last_sequence IS NULL OR last_sequence > 0),
  CHECK (
    first_available_sequence IS NULL OR last_sequence IS NULL
      OR last_sequence >= first_available_sequence
  ),
  CHECK (retired_through_sequence IS NULL OR retired_through_sequence >= 0),
  CHECK (
    (gap_reason IS NULL AND gap_observed_at IS NULL)
    OR
    (gap_reason IN ('retention', 'corruption_truncated', 'compaction')
      AND gap_observed_at IS NOT NULL AND length(gap_observed_at) > 0
      AND retired_through_sequence IS NOT NULL)
  ),
  CHECK (
    retired_through_sequence IS NULL OR first_available_sequence IS NULL
      OR retired_through_sequence < first_available_sequence
  ),
  CHECK (length(bound_at) > 0),
  CHECK (length(updated_at) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_run_journal_bindings_active
  ON run_journal_bindings(run_id, epoch)
  WHERE active = 1;

CREATE INDEX IF NOT EXISTS idx_run_journal_bindings_replay
  ON run_journal_bindings(
    run_id, epoch, first_available_sequence, last_sequence, source_path
  );

CREATE INDEX IF NOT EXISTS idx_run_journal_bindings_child
  ON run_journal_bindings(child_run_id, session_id, epoch);
`,
  apply: (db) => {
    // Artificial migration fixtures can contain only a subset of historical
    // tables. Real v1+ state databases always have the rollout projection; do
    // not manufacture it solely to install optional replay indexes.
    if (!tableExists(db, "thread_rollout_items")) return;
    db.exec(`
CREATE INDEX IF NOT EXISTS idx_thread_rollout_items_replay_source_sequence
  ON thread_rollout_items(source_path, event_seq, event_id)
  WHERE item_type = 'event_msg' AND event_seq IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_thread_rollout_items_replay_thread_sequence
  ON thread_rollout_items(thread_id, event_seq, event_id)
  WHERE item_type = 'event_msg' AND event_seq IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_thread_rollout_items_replay_source_identity
  ON thread_rollout_items(source_path, event_id, event_seq)
  WHERE item_type = 'event_msg' AND event_seq IS NOT NULL
    AND event_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_thread_rollout_items_replay_thread_identity
  ON thread_rollout_items(thread_id, event_id, event_seq)
  WHERE item_type = 'event_msg' AND event_seq IS NOT NULL
    AND event_id IS NOT NULL;
`);
  },
};
