import type { SqlMigration } from "./types.js";

export const RUN_RECOVERY_SCHEMA_VERSION = 18;

/**
 * Add durable, bounded recovery integrity evidence. These tables contain only
 * redacted metadata and source bindings; canonical rollout payloads remain in
 * their JSONL source.
 */
export const runRecoverySchemaMigration: SqlMigration = {
  version: RUN_RECOVERY_SCHEMA_VERSION,
  name: "run_recovery_schema",
  sql: `
ALTER TABLE run_journal_bindings
  ADD COLUMN authoritative_source_sha256 TEXT
    CHECK (
      authoritative_source_sha256 IS NULL OR (
        length(authoritative_source_sha256) = 64
        AND authoritative_source_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    );
ALTER TABLE run_journal_bindings
  ADD COLUMN authoritative_source_size_bytes INTEGER
    CHECK (
      authoritative_source_size_bytes IS NULL
      OR authoritative_source_size_bytes >= 0
    );
ALTER TABLE run_journal_bindings
  ADD COLUMN authoritative_source_mtime_ms REAL
    CHECK (
      authoritative_source_mtime_ms IS NULL
      OR authoritative_source_mtime_ms >= 0
    );
ALTER TABLE run_journal_bindings
  ADD COLUMN journal_format TEXT
    CHECK (
      journal_format IS NULL
      OR journal_format IN ('sequenced_v1', 'legacy_unsequenced_v1')
    );
ALTER TABLE run_journal_bindings
  ADD COLUMN minimum_reader_runtime TEXT
    CHECK (
      minimum_reader_runtime IS NULL OR length(minimum_reader_runtime) > 0
    );

CREATE TABLE run_recovery_quarantine (
  quarantine_id TEXT PRIMARY KEY,
  incident_fingerprint TEXT NOT NULL,
  run_id TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_path TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  safe_detail TEXT NOT NULL,
  line_number INTEGER,
  byte_offset INTEGER,
  expected_sequence INTEGER,
  observed_sequence INTEGER,
  source_size_bytes INTEGER NOT NULL,
  source_mtime_ms REAL NOT NULL,
  source_sha256 TEXT NOT NULL,
  confirmed_source_sha256 TEXT,
  first_detected_at_ms INTEGER NOT NULL,
  last_detected_at_ms INTEGER NOT NULL,
  detection_count INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL DEFAULT 'active',
  resolved_at_ms INTEGER,
  resolution_actor TEXT,
  resolution_note TEXT,
  supersedes_quarantine_id TEXT,
  minimum_reader_runtime TEXT NOT NULL,
  CHECK (length(quarantine_id) > 0),
  CHECK (
    length(incident_fingerprint) = 64
    AND incident_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (length(run_id) > 0),
  CHECK (source_kind IN ('rollout', 'run_journal')),
  CHECK (length(source_path) > 0),
  CHECK (reason_code IN (
    'malformed_json', 'unterminated_record', 'schema_invalid',
    'unsupported_format_version', 'sequence_gap', 'sequence_duplicate',
    'sequence_rewind', 'legacy_format_violation', 'identity_conflict',
    'required_terminal_missing', 'duplicate_terminal',
    'terminal_binding_mismatch', 'source_hash_mismatch', 'source_changed',
    'line_byte_limit', 'source_byte_limit', 'event_limit'
  )),
  CHECK (length(CAST(safe_detail AS BLOB)) <= 4096),
  CHECK (line_number IS NULL OR line_number > 0),
  CHECK (byte_offset IS NULL OR byte_offset >= 0),
  CHECK (expected_sequence IS NULL OR expected_sequence > 0),
  CHECK (observed_sequence IS NULL OR observed_sequence > 0),
  CHECK (source_size_bytes >= 0),
  CHECK (source_mtime_ms >= 0),
  CHECK (
    length(source_sha256) = 64
    AND source_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (
    confirmed_source_sha256 IS NULL OR (
      length(confirmed_source_sha256) = 64
      AND confirmed_source_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  CHECK (first_detected_at_ms >= 0),
  CHECK (last_detected_at_ms >= first_detected_at_ms),
  CHECK (detection_count > 0),
  CHECK (state IN ('active', 'repaired', 'abandoned')),
  CHECK (
    (state = 'active' AND resolved_at_ms IS NULL
      AND resolution_actor IS NULL AND resolution_note IS NULL
      AND confirmed_source_sha256 IS NULL)
    OR
    (state = 'repaired' AND resolved_at_ms IS NOT NULL
      AND resolution_actor IS NOT NULL AND length(resolution_actor) > 0
      AND resolution_note IS NOT NULL
      AND length(CAST(resolution_note AS BLOB)) <= 2048
      AND confirmed_source_sha256 IS NOT NULL)
    OR
    (state = 'abandoned' AND resolved_at_ms IS NOT NULL
      AND resolution_actor IS NOT NULL AND length(resolution_actor) > 0
      AND resolution_note IS NOT NULL
      AND length(CAST(resolution_note AS BLOB)) <= 2048
      AND confirmed_source_sha256 IS NULL)
  ),
  CHECK (
    supersedes_quarantine_id IS NULL
    OR supersedes_quarantine_id <> quarantine_id
  ),
  CHECK (length(minimum_reader_runtime) > 0)
);

CREATE UNIQUE INDEX idx_run_recovery_quarantine_active_source
  ON run_recovery_quarantine(run_id, source_kind, source_path)
  WHERE state = 'active';
CREATE INDEX idx_run_recovery_quarantine_listing
  ON run_recovery_quarantine(last_detected_at_ms DESC, quarantine_id DESC);
CREATE INDEX idx_run_recovery_quarantine_run_history
  ON run_recovery_quarantine(run_id, first_detected_at_ms DESC, quarantine_id DESC);

CREATE TRIGGER run_recovery_quarantine_evidence_immutable
BEFORE UPDATE ON run_recovery_quarantine
WHEN
  OLD.quarantine_id IS NOT NEW.quarantine_id
  OR OLD.incident_fingerprint IS NOT NEW.incident_fingerprint
  OR OLD.run_id IS NOT NEW.run_id
  OR OLD.source_kind IS NOT NEW.source_kind
  OR OLD.source_path IS NOT NEW.source_path
  OR OLD.reason_code IS NOT NEW.reason_code
  OR OLD.safe_detail IS NOT NEW.safe_detail
  OR OLD.line_number IS NOT NEW.line_number
  OR OLD.byte_offset IS NOT NEW.byte_offset
  OR OLD.expected_sequence IS NOT NEW.expected_sequence
  OR OLD.observed_sequence IS NOT NEW.observed_sequence
  OR OLD.source_size_bytes IS NOT NEW.source_size_bytes
  OR OLD.source_mtime_ms IS NOT NEW.source_mtime_ms
  OR OLD.source_sha256 IS NOT NEW.source_sha256
  OR OLD.first_detected_at_ms IS NOT NEW.first_detected_at_ms
  OR OLD.supersedes_quarantine_id IS NOT NEW.supersedes_quarantine_id
  OR OLD.minimum_reader_runtime IS NOT NEW.minimum_reader_runtime
BEGIN
  SELECT RAISE(ABORT, 'recovery quarantine evidence is immutable');
END;

CREATE TRIGGER run_recovery_quarantine_state_monotonic
BEFORE UPDATE OF state ON run_recovery_quarantine
WHEN NOT (
  OLD.state = NEW.state
  OR (OLD.state = 'active' AND NEW.state IN ('repaired', 'abandoned'))
)
BEGIN
  SELECT RAISE(ABORT, 'recovery quarantine state cannot move backwards');
END;

CREATE TRIGGER run_recovery_quarantine_confirmation_immutable
BEFORE UPDATE OF confirmed_source_sha256 ON run_recovery_quarantine
WHEN
  OLD.confirmed_source_sha256 IS NOT NEW.confirmed_source_sha256
  AND NOT (
    OLD.state = 'active'
    AND NEW.state = 'repaired'
    AND OLD.confirmed_source_sha256 IS NULL
    AND NEW.confirmed_source_sha256 IS NOT NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'recovery repair confirmation is immutable');
END;

CREATE TABLE run_recovery_quarantine_observations (
  observation_id TEXT PRIMARY KEY,
  quarantine_id TEXT NOT NULL,
  observation_fingerprint TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  safe_detail TEXT NOT NULL,
  line_number INTEGER,
  byte_offset INTEGER,
  expected_sequence INTEGER,
  observed_sequence INTEGER,
  first_observed_at_ms INTEGER NOT NULL,
  last_observed_at_ms INTEGER NOT NULL,
  observation_count INTEGER NOT NULL DEFAULT 1,
  UNIQUE (quarantine_id, observation_fingerprint),
  FOREIGN KEY (quarantine_id)
    REFERENCES run_recovery_quarantine(quarantine_id) ON DELETE CASCADE,
  CHECK (length(observation_id) > 0),
  CHECK (
    length(observation_fingerprint) = 64
    AND observation_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (length(reason_code) > 0),
  CHECK (length(CAST(safe_detail AS BLOB)) <= 4096),
  CHECK (line_number IS NULL OR line_number > 0),
  CHECK (byte_offset IS NULL OR byte_offset >= 0),
  CHECK (expected_sequence IS NULL OR expected_sequence > 0),
  CHECK (observed_sequence IS NULL OR observed_sequence > 0),
  CHECK (first_observed_at_ms >= 0),
  CHECK (last_observed_at_ms >= first_observed_at_ms),
  CHECK (observation_count > 0)
);

CREATE INDEX idx_run_recovery_quarantine_observations_incident
  ON run_recovery_quarantine_observations(
    quarantine_id, first_observed_at_ms ASC, observation_id ASC
  );

CREATE TRIGGER run_recovery_quarantine_observation_evidence_immutable
BEFORE UPDATE ON run_recovery_quarantine_observations
WHEN
  OLD.observation_id IS NOT NEW.observation_id
  OR OLD.quarantine_id IS NOT NEW.quarantine_id
  OR OLD.observation_fingerprint IS NOT NEW.observation_fingerprint
  OR OLD.reason_code IS NOT NEW.reason_code
  OR OLD.safe_detail IS NOT NEW.safe_detail
  OR OLD.line_number IS NOT NEW.line_number
  OR OLD.byte_offset IS NOT NEW.byte_offset
  OR OLD.expected_sequence IS NOT NEW.expected_sequence
  OR OLD.observed_sequence IS NOT NEW.observed_sequence
  OR OLD.first_observed_at_ms IS NOT NEW.first_observed_at_ms
BEGIN
  SELECT RAISE(ABORT, 'recovery quarantine observation evidence is immutable');
END;

CREATE TABLE run_recovery_deferred (
  block_id TEXT PRIMARY KEY,
  block_key TEXT NOT NULL,
  run_id TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_path TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  error_class TEXT NOT NULL,
  safe_detail TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 1,
  first_failed_at_ms INTEGER NOT NULL,
  last_failed_at_ms INTEGER NOT NULL,
  next_retry_ms INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'active',
  resolved_at_ms INTEGER,
  resolution_actor TEXT,
  resolution_note TEXT,
  supersedes_block_id TEXT,
  minimum_reader_runtime TEXT NOT NULL,
  CHECK (length(block_id) > 0),
  CHECK (length(block_key) = 64 AND block_key NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(run_id) > 0),
  CHECK (source_kind IN ('rollout', 'run_journal')),
  CHECK (length(source_path) > 0),
  CHECK (reason_code IN (
    'source_not_quiescent', 'recovery_lock_unavailable', 'database_busy',
    'database_io', 'database_unavailable', 'recovery_storage_unavailable',
    'projection_failure', 'startup_byte_budget', 'startup_time_budget',
    'descriptor_limit', 'concurrency_limit',
    'recovery_history_storage_limit'
  )),
  CHECK (length(error_class) > 0),
  CHECK (length(CAST(safe_detail AS BLOB)) <= 4096),
  CHECK (attempt_count > 0),
  CHECK (first_failed_at_ms >= 0),
  CHECK (last_failed_at_ms >= first_failed_at_ms),
  CHECK (next_retry_ms >= last_failed_at_ms),
  CHECK (state IN ('active', 'resolved', 'abandoned')),
  CHECK (
    (state = 'active' AND resolved_at_ms IS NULL
      AND resolution_actor IS NULL AND resolution_note IS NULL)
    OR
    (state IN ('resolved', 'abandoned') AND resolved_at_ms IS NOT NULL
      AND resolution_actor IS NOT NULL AND length(resolution_actor) > 0
      AND resolution_note IS NOT NULL
      AND length(CAST(resolution_note AS BLOB)) <= 2048)
  ),
  CHECK (supersedes_block_id IS NULL OR supersedes_block_id <> block_id),
  CHECK (length(minimum_reader_runtime) > 0)
);

CREATE UNIQUE INDEX idx_run_recovery_deferred_active_key
  ON run_recovery_deferred(block_key)
  WHERE state = 'active';
CREATE INDEX idx_run_recovery_deferred_listing
  ON run_recovery_deferred(last_failed_at_ms DESC, block_id DESC);
CREATE INDEX idx_run_recovery_deferred_retry
  ON run_recovery_deferred(state, next_retry_ms ASC, block_id ASC);
CREATE INDEX idx_run_recovery_deferred_run_history
  ON run_recovery_deferred(run_id, first_failed_at_ms DESC, block_id DESC);

CREATE TRIGGER run_recovery_deferred_evidence_immutable
BEFORE UPDATE ON run_recovery_deferred
WHEN
  OLD.block_id IS NOT NEW.block_id
  OR OLD.block_key IS NOT NEW.block_key
  OR OLD.run_id IS NOT NEW.run_id
  OR OLD.source_kind IS NOT NEW.source_kind
  OR OLD.source_path IS NOT NEW.source_path
  OR OLD.reason_code IS NOT NEW.reason_code
  OR OLD.error_class IS NOT NEW.error_class
  OR OLD.safe_detail IS NOT NEW.safe_detail
  OR OLD.first_failed_at_ms IS NOT NEW.first_failed_at_ms
  OR OLD.supersedes_block_id IS NOT NEW.supersedes_block_id
  OR OLD.minimum_reader_runtime IS NOT NEW.minimum_reader_runtime
BEGIN
  SELECT RAISE(ABORT, 'recovery deferred evidence is immutable');
END;

CREATE TRIGGER run_recovery_deferred_state_monotonic
BEFORE UPDATE OF state ON run_recovery_deferred
WHEN NOT (
  OLD.state = NEW.state
  OR (OLD.state = 'active' AND NEW.state IN ('resolved', 'abandoned'))
)
BEGIN
  SELECT RAISE(ABORT, 'recovery deferred state cannot move backwards');
END;

CREATE TABLE run_recovery_abandonments (
  abandonment_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE,
  source_kind TEXT NOT NULL,
  source_path TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  quarantine_id TEXT,
  block_id TEXT,
  actor TEXT NOT NULL,
  reason TEXT NOT NULL,
  abandoned_at_ms INTEGER NOT NULL,
  minimum_reader_runtime TEXT NOT NULL,
  FOREIGN KEY (quarantine_id)
    REFERENCES run_recovery_quarantine(quarantine_id) ON DELETE RESTRICT,
  FOREIGN KEY (block_id)
    REFERENCES run_recovery_deferred(block_id) ON DELETE RESTRICT,
  CHECK (length(abandonment_id) > 0),
  CHECK (length(run_id) > 0),
  CHECK (source_kind IN ('rollout', 'run_journal')),
  CHECK (length(source_path) > 0),
  CHECK (
    length(source_sha256) = 64
    AND source_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK ((quarantine_id IS NULL) <> (block_id IS NULL)),
  CHECK (length(actor) > 0),
  CHECK (length(CAST(reason AS BLOB)) <= 2048),
  CHECK (abandoned_at_ms >= 0),
  CHECK (length(minimum_reader_runtime) > 0)
);

CREATE INDEX idx_run_recovery_abandonments_time
  ON run_recovery_abandonments(abandoned_at_ms DESC, abandonment_id DESC);

CREATE TRIGGER run_recovery_abandonments_immutable
BEFORE UPDATE ON run_recovery_abandonments
BEGIN
  SELECT RAISE(ABORT, 'recovery abandonment is immutable');
END;
CREATE TRIGGER run_recovery_abandonments_no_delete
BEFORE DELETE ON run_recovery_abandonments
BEGIN
  SELECT RAISE(ABORT, 'recovery abandonment cannot be deleted');
END;
`,
};
