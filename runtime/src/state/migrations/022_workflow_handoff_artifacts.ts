import type { SqlMigration } from "./types.js";

export const WORKFLOW_HANDOFF_ARTIFACTS_SCHEMA_VERSION = 22;

/**
 * Durable workflow handoff intents, immutable commits, reachability, and
 * restart cursors. Quota accounting includes every non-deleted intent so a
 * crash cannot make reserved bytes or inodes disappear from the ledger.
 */
export const workflowHandoffArtifactsMigration: SqlMigration = {
  version: WORKFLOW_HANDOFF_ARTIFACTS_SCHEMA_VERSION,
  name: "workflow_handoff_artifacts",
  sql: `
CREATE TABLE workflow_handoff_artifacts (
  artifact_id TEXT PRIMARY KEY,
  format_version INTEGER NOT NULL,
  kind TEXT NOT NULL,
  compatibility_epoch TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  run_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  producer_step_id TEXT NOT NULL,
  digest TEXT NOT NULL,
  byte_length INTEGER NOT NULL,
  token_count INTEGER NOT NULL,
  storage_ref TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  preview TEXT NOT NULL,
  preview_truncated INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  committed_at_ms INTEGER,
  commit_sequence INTEGER,
  last_access_at_ms INTEGER NOT NULL,
  unreferenced_at_ms INTEGER,
  UNIQUE (run_id, idempotency_key),
  CHECK (length(artifact_id) = 51),
  CHECK (artifact_id GLOB 'wh_*'),
  CHECK (substr(artifact_id, 4) NOT GLOB '*[^0-9a-f]*'),
  CHECK (format_version = 1),
  CHECK (kind = 'workflow_handoff'),
  CHECK (compatibility_epoch = 'workflow_handoff.v1/state-schema.22'),
  CHECK (length(idempotency_key) > 0
    AND length(CAST(idempotency_key AS BLOB)) <= 1024),
  CHECK (length(run_id) > 0 AND length(CAST(run_id AS BLOB)) <= 1024),
  CHECK (length(workflow_id) > 0
    AND length(CAST(workflow_id AS BLOB)) <= 1024),
  CHECK (length(producer_step_id) > 0
    AND length(CAST(producer_step_id AS BLOB)) <= 1024),
  CHECK (length(digest) = 71),
  CHECK (digest GLOB 'sha256:*'),
  CHECK (substr(digest, 8) NOT GLOB '*[^0-9a-f]*'),
  CHECK (byte_length BETWEEN 0 AND 16777216),
  CHECK (token_count BETWEEN 0 AND 131072),
  CHECK (storage_ref = 'workflow-handoff:' || artifact_id),
  CHECK (status IN ('intent', 'committed', 'deleting', 'conflict')),
  CHECK (preview_truncated IN (0, 1)),
  CHECK (length(CAST(preview AS BLOB)) <= 2048),
  CHECK (created_at_ms >= 0),
  CHECK (last_access_at_ms >= created_at_ms),
  CHECK (unreferenced_at_ms IS NULL OR unreferenced_at_ms >= created_at_ms),
  CHECK (
    (status = 'intent'
      AND committed_at_ms IS NULL AND commit_sequence IS NULL)
    OR
    (status IN ('committed', 'deleting')
      AND committed_at_ms IS NOT NULL AND committed_at_ms >= created_at_ms
      AND commit_sequence IS NOT NULL AND commit_sequence > 0)
    OR
    (status = 'conflict'
      AND ((committed_at_ms IS NULL AND commit_sequence IS NULL)
        OR (committed_at_ms IS NOT NULL AND committed_at_ms >= created_at_ms
          AND commit_sequence IS NOT NULL AND commit_sequence > 0)))
  )
);

CREATE UNIQUE INDEX idx_workflow_handoff_commit_sequence
  ON workflow_handoff_artifacts(commit_sequence)
  WHERE commit_sequence IS NOT NULL;
CREATE INDEX idx_workflow_handoff_run_quota
  ON workflow_handoff_artifacts(run_id, status, artifact_id);
CREATE INDEX idx_workflow_handoff_cleanup_lru
  ON workflow_handoff_artifacts(
    status, unreferenced_at_ms, last_access_at_ms, artifact_id
  );

CREATE TABLE workflow_handoff_references (
  artifact_id TEXT NOT NULL,
  reference_id TEXT NOT NULL,
  consumer_run_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (artifact_id, reference_id),
  FOREIGN KEY (artifact_id)
    REFERENCES workflow_handoff_artifacts(artifact_id) ON DELETE RESTRICT,
  CHECK (length(reference_id) > 0
    AND length(CAST(reference_id AS BLOB)) <= 1024),
  CHECK (length(consumer_run_id) > 0
    AND length(CAST(consumer_run_id AS BLOB)) <= 1024),
  CHECK (created_at_ms >= 0)
);

CREATE INDEX idx_workflow_handoff_references_consumer
  ON workflow_handoff_references(consumer_run_id, artifact_id);

CREATE TABLE workflow_handoff_sequence (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  next_commit_sequence INTEGER NOT NULL CHECK (next_commit_sequence > 0)
);
INSERT INTO workflow_handoff_sequence(singleton, next_commit_sequence)
VALUES (1, 1);

CREATE TABLE workflow_handoff_quota_global (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  artifact_count INTEGER NOT NULL CHECK (artifact_count >= 0),
  artifact_bytes INTEGER NOT NULL CHECK (artifact_bytes >= 0)
);
INSERT INTO workflow_handoff_quota_global(
  singleton, artifact_count, artifact_bytes
) VALUES (1, 0, 0);

CREATE TABLE workflow_handoff_quota_runs (
  run_id TEXT PRIMARY KEY,
  artifact_count INTEGER NOT NULL CHECK (artifact_count > 0),
  artifact_bytes INTEGER NOT NULL CHECK (artifact_bytes >= 0),
  CHECK (length(run_id) > 0 AND length(CAST(run_id AS BLOB)) <= 1024)
);

CREATE TRIGGER workflow_handoff_quota_after_insert
AFTER INSERT ON workflow_handoff_artifacts
BEGIN
  UPDATE workflow_handoff_quota_global
  SET artifact_count = artifact_count + 1,
      artifact_bytes = artifact_bytes + NEW.byte_length
  WHERE singleton = 1;
  INSERT INTO workflow_handoff_quota_runs (
    run_id, artifact_count, artifact_bytes
  ) VALUES (NEW.run_id, 1, NEW.byte_length)
  ON CONFLICT(run_id) DO UPDATE SET
    artifact_count = artifact_count + 1,
    artifact_bytes = artifact_bytes + NEW.byte_length;
END;

CREATE TRIGGER workflow_handoff_quota_after_delete
AFTER DELETE ON workflow_handoff_artifacts
BEGIN
  UPDATE workflow_handoff_quota_global
  SET artifact_count = artifact_count - 1,
      artifact_bytes = artifact_bytes - OLD.byte_length
  WHERE singleton = 1;
  DELETE FROM workflow_handoff_quota_runs
  WHERE run_id = OLD.run_id AND artifact_count = 1;
  UPDATE workflow_handoff_quota_runs
  SET artifact_count = artifact_count - 1,
      artifact_bytes = artifact_bytes - OLD.byte_length
  WHERE run_id = OLD.run_id AND artifact_count > 1;
END;

CREATE TABLE workflow_handoff_cursors (
  cursor_name TEXT PRIMARY KEY,
  sort_ms INTEGER NOT NULL CHECK (sort_ms >= 0),
  artifact_id TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
  CHECK (cursor_name IN ('intent_recovery', 'retention_cleanup'))
);

CREATE TRIGGER workflow_handoff_identity_is_immutable
BEFORE UPDATE ON workflow_handoff_artifacts
WHEN OLD.artifact_id IS NOT NEW.artifact_id
  OR OLD.format_version IS NOT NEW.format_version
  OR OLD.kind IS NOT NEW.kind
  OR OLD.compatibility_epoch IS NOT NEW.compatibility_epoch
  OR OLD.idempotency_key IS NOT NEW.idempotency_key
  OR OLD.run_id IS NOT NEW.run_id
  OR OLD.workflow_id IS NOT NEW.workflow_id
  OR OLD.producer_step_id IS NOT NEW.producer_step_id
  OR OLD.digest IS NOT NEW.digest
  OR OLD.byte_length IS NOT NEW.byte_length
  OR OLD.token_count IS NOT NEW.token_count
  OR OLD.storage_ref IS NOT NEW.storage_ref
  OR OLD.preview IS NOT NEW.preview
  OR OLD.preview_truncated IS NOT NEW.preview_truncated
  OR OLD.created_at_ms IS NOT NEW.created_at_ms
BEGIN
  SELECT RAISE(ABORT, 'workflow handoff identity is immutable');
END;

CREATE TRIGGER workflow_handoff_status_is_monotonic
BEFORE UPDATE OF status ON workflow_handoff_artifacts
WHEN NOT (
  OLD.status = NEW.status
  OR (OLD.status = 'intent' AND NEW.status IN ('committed', 'conflict'))
  OR (OLD.status = 'committed' AND NEW.status = 'deleting')
  OR (OLD.status = 'deleting' AND NEW.status = 'conflict')
)
BEGIN
  SELECT RAISE(ABORT, 'workflow handoff status cannot move backwards');
END;
`,
};
