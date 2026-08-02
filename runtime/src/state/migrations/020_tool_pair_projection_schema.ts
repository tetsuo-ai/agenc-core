import type { SqlMigration } from "./types.js";

/** Version 19 is reserved for the independently integrated B1 migration. */
export const TOOL_PAIR_PROJECTION_SCHEMA_VERSION = 20;

/**
 * Exact, rebuildable tool-call/result index for bounded durable-rollout reads.
 * This is deliberately separate from `in_flight_tool_calls`: the latter is
 * mutable execution state, while these rows are a derived integrity
 * projection that can be deleted and rebuilt from canonical rollout bytes.
 */
export const toolPairProjectionSchemaMigration: SqlMigration = {
  version: TOOL_PAIR_PROJECTION_SCHEMA_VERSION,
  name: "tool_pair_projection_schema",
  sql: `
CREATE TABLE IF NOT EXISTS tool_pair_projection_runs (
  projection_id TEXT PRIMARY KEY,
  source_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('building', 'valid', 'invalid', 'deferred')),
  call_count INTEGER NOT NULL DEFAULT 0 CHECK (call_count >= 0),
  resolved_count INTEGER NOT NULL DEFAULT 0 CHECK (resolved_count >= 0),
  open_call_count INTEGER NOT NULL DEFAULT 0 CHECK (open_call_count >= 0),
  maximum_open_call_count INTEGER NOT NULL DEFAULT 0 CHECK (maximum_open_call_count >= 0),
  logical_index_bytes INTEGER NOT NULL DEFAULT 0 CHECK (logical_index_bytes >= 0),
  failure_kind TEXT CHECK (failure_kind IN ('integrity_failure', 'operational_deferral')),
  failure_code TEXT,
  failure_index INTEGER CHECK (failure_index IS NULL OR failure_index >= 0),
  failure_reason TEXT,
  CHECK (resolved_count <= call_count),
  CHECK (open_call_count = call_count - resolved_count),
  CHECK (maximum_open_call_count >= open_call_count),
  CHECK (status <> 'valid' OR open_call_count = 0),
  CHECK (
    (status IN ('building', 'valid') AND failure_kind IS NULL AND failure_code IS NULL AND failure_index IS NULL AND failure_reason IS NULL)
    OR
    (status = 'invalid' AND failure_kind = 'integrity_failure' AND failure_code IS NOT NULL AND failure_reason IS NOT NULL)
    OR
    (status = 'deferred' AND failure_kind = 'operational_deferral' AND failure_code IS NOT NULL AND failure_reason IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS tool_pair_projection_entries (
  projection_id TEXT NOT NULL,
  call_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  assistant_index INTEGER NOT NULL CHECK (assistant_index >= 0),
  result_index INTEGER CHECK (result_index IS NULL OR result_index > assistant_index),
  result_id TEXT,
  original_result_digest TEXT,
  PRIMARY KEY (projection_id, call_id),
  FOREIGN KEY (projection_id)
    REFERENCES tool_pair_projection_runs(projection_id)
    ON DELETE CASCADE,
  CHECK (
    (result_index IS NULL AND result_id IS NULL AND original_result_digest IS NULL)
    OR
    (result_index IS NOT NULL AND (
      (result_id IS NULL AND original_result_digest IS NULL)
      OR (result_id IS NOT NULL AND original_result_digest IS NOT NULL)
    ))
  )
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_tool_pair_projection_source
  ON tool_pair_projection_runs(source_key, projection_id);

CREATE INDEX IF NOT EXISTS idx_tool_pair_projection_unresolved
  ON tool_pair_projection_entries(projection_id, assistant_index)
  WHERE result_index IS NULL;
`,
};
