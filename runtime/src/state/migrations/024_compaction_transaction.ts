import type { SqlMigration } from "./types.js";

const COMPACTION_TRANSACTION_SCHEMA_VERSION = 24;

/** Durable pin, rollback, failure-guard, and reconciliation authority. */
export const compactionTransactionMigration: SqlMigration = {
  version: COMPACTION_TRANSACTION_SCHEMA_VERSION,
  name: "compaction_transaction",
  sql: `
CREATE TABLE compaction_retention_pins (
  attempt_id TEXT PRIMARY KEY,
  format_version INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  source_binding TEXT NOT NULL,
  first_sequence INTEGER NOT NULL,
  last_sequence INTEGER NOT NULL,
  source_sha256 TEXT NOT NULL,
  source_bytes INTEGER NOT NULL,
  history_digest TEXT NOT NULL,
  source_manifest_json TEXT NOT NULL,
  selected_history_indexes_json TEXT NOT NULL,
  policy_digest TEXT NOT NULL,
  configuration_digest TEXT NOT NULL,
  accounting_ref TEXT NOT NULL,
  automatic INTEGER NOT NULL,
  admission_required INTEGER NOT NULL,
  planned_provider_calls INTEGER NOT NULL,
  state TEXT NOT NULL,
  reference_count INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  intent_at_ms INTEGER,
  committed_at_ms INTEGER,
  retention_deadline_ms INTEGER,
  rollback_extended_until_ms INTEGER,
  release_tombstone_at_ms INTEGER,
  released_at_ms INTEGER,
  commit_sha256 TEXT,
  reference_scan_generation INTEGER,
  cleanup_state TEXT NOT NULL,
  projection_state TEXT NOT NULL,
  prune_cursor INTEGER NOT NULL,
  UNIQUE (session_id, epoch, source_sha256, attempt_id),
  CHECK (format_version = 1),
  CHECK (length(attempt_id) > 0 AND length(CAST(attempt_id AS BLOB)) <= 1024),
  CHECK (length(session_id) > 0 AND length(CAST(session_id AS BLOB)) <= 1024),
  CHECK (epoch > 0),
  CHECK (length(source_binding) > 0
    AND length(CAST(source_binding AS BLOB)) <= 4096),
  CHECK (first_sequence > 0 AND last_sequence >= first_sequence),
  CHECK (length(source_sha256) = 64
    AND source_sha256 NOT GLOB '*[^0-9a-f]*'),
  CHECK (source_bytes BETWEEN 1 AND 67108864),
  CHECK (length(history_digest) = 64
    AND history_digest NOT GLOB '*[^0-9a-f]*'),
  CHECK (json_valid(source_manifest_json)
    AND json_type(source_manifest_json) = 'array'
    AND length(CAST(source_manifest_json AS BLOB)) <= 67108864),
  CHECK (json_valid(selected_history_indexes_json)
    AND json_type(selected_history_indexes_json) = 'array'
    AND json_array_length(selected_history_indexes_json) BETWEEN 1 AND 100000
    AND length(CAST(selected_history_indexes_json AS BLOB)) <= 1048576),
  CHECK (length(policy_digest) = 64
    AND policy_digest NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(configuration_digest) = 64
    AND configuration_digest NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(accounting_ref) = 64
    AND accounting_ref NOT GLOB '*[^0-9a-f]*'),
  CHECK (automatic IN (0, 1)),
  CHECK (admission_required = 1),
  CHECK (planned_provider_calls BETWEEN 1 AND 73),
  CHECK (state IN (
    'preparing', 'intent_bound', 'committed_reference',
    'release_pending', 'released'
  )),
  CHECK (reference_count >= 0),
  CHECK (created_at_ms >= 0),
  CHECK (intent_at_ms IS NULL OR intent_at_ms >= created_at_ms),
  CHECK (committed_at_ms IS NULL OR committed_at_ms >= created_at_ms),
  CHECK (retention_deadline_ms IS NULL OR retention_deadline_ms >= created_at_ms),
  CHECK (rollback_extended_until_ms IS NULL
    OR rollback_extended_until_ms >= retention_deadline_ms),
  CHECK (release_tombstone_at_ms IS NULL
    OR release_tombstone_at_ms >= created_at_ms),
  CHECK (released_at_ms IS NULL OR released_at_ms >= release_tombstone_at_ms),
  CHECK (commit_sha256 IS NULL OR (
    length(commit_sha256) = 64 AND commit_sha256 NOT GLOB '*[^0-9a-f]*'
  )),
  CHECK (reference_scan_generation IS NULL OR reference_scan_generation > 0),
  CHECK (cleanup_state IN ('not_started', 'pending', 'complete')),
  CHECK (projection_state IN (
    'not_committed', 'pending', 'complete', 'reconstruction_required'
  )),
  CHECK (prune_cursor >= 0),
  CHECK (
    (state = 'preparing' AND intent_at_ms IS NULL AND committed_at_ms IS NULL)
    OR (state = 'intent_bound' AND intent_at_ms IS NOT NULL
      AND committed_at_ms IS NULL)
    OR (state = 'committed_reference' AND intent_at_ms IS NOT NULL
      AND committed_at_ms IS NOT NULL AND retention_deadline_ms IS NOT NULL
      AND commit_sha256 IS NOT NULL)
    OR (state = 'release_pending' AND release_tombstone_at_ms IS NOT NULL)
    OR (state = 'released' AND release_tombstone_at_ms IS NOT NULL
      AND released_at_ms IS NOT NULL)
  )
);

CREATE INDEX idx_compaction_pins_reconcile
  ON compaction_retention_pins(session_id, created_at_ms, attempt_id)
  WHERE state != 'released';
CREATE INDEX idx_compaction_pins_session_quota
  ON compaction_retention_pins(session_id, state, attempt_id);
CREATE INDEX idx_compaction_pins_global_bytes
  ON compaction_retention_pins(state, source_bytes, attempt_id);
CREATE INDEX idx_compaction_pins_release_pending
  ON compaction_retention_pins(session_id, retention_deadline_ms, attempt_id)
  WHERE state = 'release_pending';
CREATE INDEX idx_compaction_pins_release_eligible
  ON compaction_retention_pins(
    session_id,
    MAX(retention_deadline_ms, COALESCE(rollback_extended_until_ms, 0)),
    attempt_id
  )
  WHERE state = 'committed_reference'
    AND projection_state = 'complete'
    AND reference_count = 0
    AND retention_deadline_ms IS NOT NULL;
CREATE INDEX idx_compaction_pins_released_gc
  ON compaction_retention_pins(released_at_ms, attempt_id)
  WHERE state = 'released';
CREATE INDEX idx_compaction_pins_source
  ON compaction_retention_pins(source_binding, state, attempt_id);

CREATE TABLE compaction_retention_references (
  attempt_id TEXT NOT NULL,
  reference_kind TEXT NOT NULL,
  reference_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  released_at_ms INTEGER,
  PRIMARY KEY (attempt_id, reference_kind, reference_id),
  FOREIGN KEY (attempt_id)
    REFERENCES compaction_retention_pins(attempt_id) ON DELETE RESTRICT,
  CHECK (reference_kind IN (
    'active_history', 'checkpoint', 'branch', 'descendant_compaction',
    'rollback_window', 'rollback_extension', 'provenance'
  )),
  CHECK (length(reference_id) > 0
    AND length(CAST(reference_id AS BLOB)) <= 4096),
  CHECK (created_at_ms >= 0),
  CHECK (released_at_ms IS NULL OR released_at_ms >= created_at_ms)
);

CREATE INDEX idx_compaction_references_active
  ON compaction_retention_references(
    attempt_id, released_at_ms, reference_kind, reference_id
  );
CREATE INDEX idx_compaction_references_active_descendant
  ON compaction_retention_references(reference_id, attempt_id)
  WHERE reference_kind = 'descendant_compaction'
    AND released_at_ms IS NULL;

CREATE TABLE compaction_failure_guards (
  session_id TEXT NOT NULL,
  history_digest TEXT NOT NULL,
  configuration_digest TEXT NOT NULL,
  failure_count INTEGER NOT NULL,
  attempt_ids_json TEXT NOT NULL,
  last_failure_at_ms INTEGER NOT NULL,
  PRIMARY KEY (session_id, history_digest, configuration_digest),
  CHECK (length(session_id) > 0 AND length(CAST(session_id AS BLOB)) <= 1024),
  CHECK (length(history_digest) = 64
    AND history_digest NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(configuration_digest) = 64
    AND configuration_digest NOT GLOB '*[^0-9a-f]*'),
  CHECK (failure_count BETWEEN 1 AND 2),
  CHECK (json_valid(attempt_ids_json)),
  CHECK (json_type(attempt_ids_json) = 'array'),
  CHECK (length(CAST(attempt_ids_json AS BLOB)) <= 8192),
  CHECK (last_failure_at_ms >= 0)
);

CREATE TABLE compaction_reconciliation_cursors (
  cursor_name TEXT PRIMARY KEY,
  created_at_ms INTEGER NOT NULL,
  attempt_id TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  CHECK (length(cursor_name) > 0
    AND length(CAST(cursor_name AS BLOB)) <= 1024),
  CHECK (created_at_ms >= 0),
  CHECK (length(attempt_id) <= 1024),
  CHECK (updated_at_ms >= 0)
);

CREATE TABLE compaction_recovery_deferrals (
  deferral_id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  attempt_id TEXT,
  reason TEXT NOT NULL,
  detail_digest TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  resolved_at_ms INTEGER,
  CHECK (session_id IS NULL OR (
    length(session_id) > 0 AND length(CAST(session_id AS BLOB)) <= 1024
  )),
  CHECK (attempt_id IS NULL OR (
    length(attempt_id) > 0 AND length(CAST(attempt_id AS BLOB)) <= 1024
  )),
  CHECK (reason IN (
    'pin_quota', 'pin_history_quota', 'pinned_bytes_quota',
    'startup_page_budget', 'startup_time_budget', 'source_proof_unavailable',
    'failure_append_unavailable', 'cleanup_pending', 'projection_reconstruction'
  )),
  CHECK (length(detail_digest) = 64
    AND detail_digest NOT GLOB '*[^0-9a-f]*'),
  CHECK (created_at_ms >= 0),
  CHECK (resolved_at_ms IS NULL OR resolved_at_ms >= created_at_ms)
);

CREATE INDEX idx_compaction_deferrals_unresolved
  ON compaction_recovery_deferrals(resolved_at_ms, deferral_id);

CREATE TRIGGER compaction_pin_identity_immutable
BEFORE UPDATE ON compaction_retention_pins
WHEN OLD.attempt_id IS NOT NEW.attempt_id
  OR OLD.format_version IS NOT NEW.format_version
  OR OLD.session_id IS NOT NEW.session_id
  OR OLD.epoch IS NOT NEW.epoch
  OR OLD.source_binding IS NOT NEW.source_binding
  OR OLD.first_sequence IS NOT NEW.first_sequence
  OR OLD.last_sequence IS NOT NEW.last_sequence
  OR OLD.source_sha256 IS NOT NEW.source_sha256
  OR OLD.source_bytes IS NOT NEW.source_bytes
  OR OLD.history_digest IS NOT NEW.history_digest
  OR OLD.source_manifest_json IS NOT NEW.source_manifest_json
  OR OLD.selected_history_indexes_json IS NOT NEW.selected_history_indexes_json
  OR OLD.policy_digest IS NOT NEW.policy_digest
  OR OLD.configuration_digest IS NOT NEW.configuration_digest
  OR OLD.accounting_ref IS NOT NEW.accounting_ref
  OR OLD.automatic IS NOT NEW.automatic
  OR OLD.admission_required IS NOT NEW.admission_required
  OR OLD.planned_provider_calls IS NOT NEW.planned_provider_calls
  OR OLD.created_at_ms IS NOT NEW.created_at_ms
BEGIN
  SELECT RAISE(ABORT, 'compaction pin identity is immutable');
END;

CREATE TRIGGER compaction_pin_state_monotonic
BEFORE UPDATE OF state ON compaction_retention_pins
WHEN NOT (
  OLD.state = NEW.state
  OR (OLD.state = 'preparing' AND NEW.state IN ('intent_bound', 'release_pending'))
  OR (OLD.state = 'intent_bound'
    AND NEW.state IN ('committed_reference', 'release_pending'))
  OR (OLD.state = 'committed_reference' AND NEW.state = 'release_pending')
  OR (OLD.state = 'release_pending' AND NEW.state = 'released')
)
BEGIN
  SELECT RAISE(ABORT, 'compaction pin state cannot move backwards');
END;

CREATE TRIGGER compaction_retention_extension_monotonic
BEFORE UPDATE OF rollback_extended_until_ms ON compaction_retention_pins
WHEN OLD.rollback_extended_until_ms IS NOT NULL
  AND (NEW.rollback_extended_until_ms IS NULL
    OR NEW.rollback_extended_until_ms < OLD.rollback_extended_until_ms)
BEGIN
  SELECT RAISE(ABORT, 'compaction rollback extension cannot be shortened');
END;
`,
};
