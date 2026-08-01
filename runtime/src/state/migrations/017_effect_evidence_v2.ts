import type { SqlMigration } from "./types.js";

export const EFFECT_EVIDENCE_V2_SCHEMA_VERSION = 17;

/**
 * Link admission and effect state without collapsing them into one enum. The
 * rebuild tightens review/no-effect evidence checks while preserving the
 * canonical JSONL journal and every legacy byte in evidence/legacy_review.
 */
export const effectEvidenceV2Migration: SqlMigration = {
  version: EFFECT_EVIDENCE_V2_SCHEMA_VERSION,
  name: "effect_evidence_v2",
  sql: `
DROP TRIGGER IF EXISTS run_effect_intent_is_immutable;
DROP TRIGGER IF EXISTS run_effect_outcome_is_sticky;
DROP TRIGGER IF EXISTS run_effect_review_is_monotonic;
DROP INDEX IF EXISTS idx_run_effects_intent_sequence;
DROP INDEX IF EXISTS idx_run_effects_result_sequence;
DROP INDEX IF EXISTS idx_run_effects_pending_review;
DROP INDEX IF EXISTS idx_run_effects_session;
DROP INDEX IF EXISTS idx_run_effects_session_call;
DROP INDEX IF EXISTS idx_run_effects_session_call_step;

ALTER TABLE run_effects RENAME TO run_effects_v16;

CREATE TABLE run_effects (
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
  effect_format_version INTEGER NOT NULL,
  minimum_reader_runtime TEXT,
  outcome TEXT,
  effect_boundary TEXT,
  no_effect_evidence_json TEXT,
  result_event_id TEXT,
  result_sequence INTEGER,
  result_digest TEXT,
  result_json TEXT,
  evidence_json TEXT,
  unknown_reason TEXT,
  completed_at TEXT,
  review_status TEXT,
  reviewed_at TEXT,
  reviewed_by TEXT,
  review_resolution TEXT,
  review_event_id TEXT,
  review_evidence_json TEXT,
  review_resolution_version INTEGER,
  review_disposition TEXT,
  review_actor_kind TEXT,
  review_actor_id TEXT,
  review_evidence_kind TEXT,
  review_evidence_ref TEXT,
  review_evidence_sha256 TEXT,
  review_domain_action TEXT,
  legacy_review_json TEXT,
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
  CHECK (effect_format_version IN (1, 2)),
  CHECK (
    (effect_format_version = 1 AND minimum_reader_runtime IS NULL)
    OR
    (effect_format_version = 2 AND minimum_reader_runtime IS NOT NULL
      AND length(minimum_reader_runtime) > 0)
  ),
  CHECK (outcome IS NULL OR outcome IN (
    'committed', 'failed', 'cancelled', 'unknown_outcome'
  )),
  CHECK (effect_boundary IS NULL OR effect_boundary IN ('not_crossed', 'crossed')),
  CHECK (no_effect_evidence_json IS NULL OR json_valid(no_effect_evidence_json)),
  CHECK (
    (outcome IS NULL
      AND result_event_id IS NULL AND result_sequence IS NULL
      AND result_digest IS NULL AND result_json IS NULL
      AND evidence_json IS NULL AND unknown_reason IS NULL
      AND completed_at IS NULL AND review_status IS NULL)
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
      AND review_status IN ('pending', 'resolved', 'abandoned'))
    OR
    ((outcome IS NULL OR outcome <> 'unknown_outcome')
      AND unknown_reason IS NULL AND review_status IS NULL)
  ),
  CHECK (
    effect_format_version = 1 OR outcome IS NULL OR outcome = 'unknown_outcome'
      OR effect_boundary IS NOT NULL
  ),
  CHECK (
    no_effect_evidence_json IS NULL
      OR outcome IN ('failed', 'cancelled')
  ),
  CHECK (review_evidence_json IS NULL OR json_valid(review_evidence_json)),
  CHECK (legacy_review_json IS NULL OR json_valid(legacy_review_json)),
  CHECK (
    (review_status IS NULL
      AND reviewed_at IS NULL AND reviewed_by IS NULL
      AND review_resolution IS NULL AND review_event_id IS NULL
      AND review_evidence_json IS NULL
      AND review_resolution_version IS NULL
      AND review_disposition IS NULL AND review_actor_kind IS NULL
      AND review_actor_id IS NULL AND review_evidence_kind IS NULL
      AND review_evidence_ref IS NULL AND review_evidence_sha256 IS NULL
      AND review_domain_action IS NULL)
    OR
    (review_status = 'pending'
      AND (
        (review_resolution_version IS NULL
          AND review_disposition IS NULL AND review_actor_kind IS NULL
          AND review_actor_id IS NULL AND review_evidence_kind IS NULL
          AND review_evidence_ref IS NULL AND review_evidence_sha256 IS NULL
          AND reviewed_at IS NULL AND reviewed_by IS NULL
          AND review_resolution IS NULL AND review_event_id IS NULL
          AND review_evidence_json IS NULL AND review_domain_action IS NULL)
        OR
        (review_resolution_version = 1
          AND review_disposition = 'remains_unknown'
          AND review_actor_kind IN ('system_settlement', 'operator')
          AND review_actor_id IS NOT NULL AND length(review_actor_id) > 0
          AND review_evidence_kind IN (
            'provider_receipt', 'idempotency_lookup',
            'boundary_not_crossed', 'operator_evidence'
          )
          AND review_evidence_ref IS NOT NULL AND length(review_evidence_ref) > 0
          AND review_evidence_sha256 NOT GLOB '*[^0-9a-f]*'
          AND length(review_evidence_sha256) = 64
          AND reviewed_at IS NOT NULL AND length(reviewed_at) > 0
          AND reviewed_by = review_actor_id
          AND review_resolution = review_disposition
          AND review_event_id IS NOT NULL AND length(review_event_id) > 0
          AND review_domain_action IS NULL)
      ))
    OR
    (review_status IN ('resolved', 'abandoned')
      AND review_resolution_version = 1
      AND review_disposition IN (
        'confirmed_committed', 'confirmed_no_effect', 'remains_unknown'
      )
      AND review_actor_kind IN ('system_settlement', 'operator')
      AND review_actor_id IS NOT NULL AND length(review_actor_id) > 0
      AND review_evidence_kind IN (
        'provider_receipt', 'idempotency_lookup',
        'boundary_not_crossed', 'operator_evidence'
      )
      AND review_evidence_ref IS NOT NULL AND length(review_evidence_ref) > 0
      AND review_evidence_sha256 NOT GLOB '*[^0-9a-f]*'
      AND length(review_evidence_sha256) = 64
      AND reviewed_at IS NOT NULL AND length(reviewed_at) > 0
      AND reviewed_by = review_actor_id
      AND review_resolution = review_disposition
      AND review_event_id IS NOT NULL AND length(review_event_id) > 0
      AND review_domain_action IN (
        'mark_completed', 'retry_new_attempt', 'abandon_item'
      ))
  ),
  CHECK (
    review_actor_kind <> 'system_settlement'
      OR review_evidence_kind <> 'operator_evidence'
  ),
  CHECK (
    review_domain_action <> 'retry_new_attempt'
      OR review_disposition = 'confirmed_no_effect'
      OR (recovery_category = 'idempotent' AND idempotency_key IS NOT NULL)
  ),
  CHECK (
    review_status <> 'abandoned'
      OR (review_disposition = 'remains_unknown'
        AND review_domain_action = 'abandon_item')
  ),
  CHECK (
    review_status IS NULL
    OR review_resolution_version IS NULL
    OR (review_status = 'pending'
      AND review_disposition = 'remains_unknown'
      AND review_domain_action IS NULL)
    OR (review_status = 'resolved'
      AND review_disposition = 'confirmed_committed'
      AND review_domain_action = 'mark_completed')
    OR (review_status = 'resolved'
      AND review_disposition = 'confirmed_no_effect'
      AND review_domain_action = 'retry_new_attempt')
    OR (review_status = 'abandoned'
      AND review_disposition = 'remains_unknown'
      AND review_domain_action = 'abandon_item')
  )
);

INSERT INTO run_effects (
  run_id, step_id, epoch, child_run_id, session_id, call_id, tool_name,
  recovery_category, idempotency_key, intent_digest, intent_event_id,
  intent_sequence, intent_at, effect_format_version, minimum_reader_runtime,
  outcome, effect_boundary, no_effect_evidence_json, result_event_id,
  result_sequence, result_digest, result_json, evidence_json, unknown_reason,
  completed_at, review_status, reviewed_at, reviewed_by, review_resolution,
  review_event_id, review_evidence_json, legacy_review_json
)
SELECT
  run_id, step_id, epoch, child_run_id, session_id, call_id, tool_name,
  recovery_category, idempotency_key, intent_digest, intent_event_id,
  intent_sequence, intent_at, 1, NULL,
  CASE
    WHEN recovery_category <> 'idempotent' AND outcome IN ('failed', 'cancelled')
      THEN 'unknown_outcome'
    ELSE outcome
  END,
  CASE
    WHEN outcome = 'committed' THEN 'crossed'
    WHEN recovery_category = 'idempotent' AND outcome IN ('failed', 'cancelled')
      THEN 'crossed'
    ELSE NULL
  END,
  NULL, result_event_id, result_sequence, result_digest, result_json,
  evidence_json,
  CASE
    WHEN recovery_category <> 'idempotent' AND outcome IN ('failed', 'cancelled')
      THEN 'legacy_ambiguous_terminal_evidence'
    ELSE unknown_reason
  END,
  completed_at,
  CASE
    WHEN outcome = 'unknown_outcome'
      OR (recovery_category <> 'idempotent' AND outcome IN ('failed', 'cancelled'))
      THEN 'pending'
    ELSE NULL
  END,
  NULL, NULL, NULL, NULL, NULL,
  CASE
    WHEN review_status = 'resolved' THEN json_object(
      'status', review_status,
      'reviewedAt', reviewed_at,
      'reviewedBy', reviewed_by,
      'resolution', review_resolution,
      'eventId', review_event_id,
      'evidenceJson', review_evidence_json
    )
    ELSE NULL
  END
FROM run_effects_v16;

DROP TABLE run_effects_v16;

CREATE UNIQUE INDEX idx_run_effects_intent_sequence
  ON run_effects(run_id, intent_sequence);
CREATE UNIQUE INDEX idx_run_effects_result_sequence
  ON run_effects(run_id, result_sequence)
  WHERE result_sequence IS NOT NULL;
CREATE INDEX idx_run_effects_pending_review
  ON run_effects(run_id, review_status, intent_sequence)
  WHERE review_status = 'pending';
CREATE INDEX idx_run_effects_session
  ON run_effects(session_id, intent_sequence);
CREATE UNIQUE INDEX idx_run_effects_session_call_step
  ON run_effects(session_id, call_id, step_id);

CREATE TRIGGER run_effect_intent_is_immutable
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
  OR OLD.effect_format_version IS NOT NEW.effect_format_version
  OR OLD.minimum_reader_runtime IS NOT NEW.minimum_reader_runtime
BEGIN
  SELECT RAISE(ABORT, 'run effect intent is immutable');
END;

CREATE TRIGGER run_effect_outcome_is_sticky
BEFORE UPDATE ON run_effects
WHEN OLD.outcome IS NOT NULL AND (
  OLD.outcome IS NOT NEW.outcome
  OR OLD.effect_boundary IS NOT NEW.effect_boundary
  OR OLD.no_effect_evidence_json IS NOT NEW.no_effect_evidence_json
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

CREATE TRIGGER run_effect_review_is_monotonic
BEFORE UPDATE ON run_effects
WHEN NOT (
  OLD.review_status IS NEW.review_status
  OR (OLD.review_status IS NULL AND NEW.review_status = 'pending'
      AND OLD.outcome IS NULL AND NEW.outcome = 'unknown_outcome')
  OR (OLD.review_status = 'pending' AND NEW.review_status IN ('resolved', 'abandoned'))
)
BEGIN
  SELECT RAISE(ABORT, 'run effect review state cannot move backwards');
END;
`,
};
