import { createHash } from "node:crypto";
import type { SqliteDatabase } from "../sqlite-driver.js";
import type { SqlMigration } from "./types.js";
import {
  CSV_DEFAULT_MAX_CONCURRENCY,
  CSV_MAX_JOB_CONCURRENCY,
  CSV_MAX_OUTPUT_BYTES,
  CSV_MAX_OUTPUT_STAGING_BYTES_GLOBAL,
  CSV_MAX_RESULT_BYTES,
  CSV_MAX_RESULT_BYTES_PER_JOB,
  CSV_MAX_ROWS,
  CSV_OUTPUT_CONTRACT_VERSION,
  CSV_OUTPUT_SCHEMA_CONTRACT_VERSION,
} from "../../contracts/csv-job-contract.js";
import {
  assertCsvOutputSchemaMigrationCompatible,
  compileCsvOutputSchema,
} from "../../agents/jobs/csv-schema.js";
import {
  deriveCsvItemIdentity,
  type CsvRow,
} from "../../agents/jobs/csv-reader.js";

export const CSV_JOB_IDENTITY_REPLAY_SCHEMA_VERSION = 19;

function tableExists(db: SqliteDatabase, table: string): boolean {
  return (
    db
      .prepare<[string], { readonly name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get(table) !== undefined
  );
}

function legacyCsvIdentityJson(
  jobIdValue: unknown,
  rowIndexValue: unknown,
  headersJsonValue: unknown,
  rowJsonValue: unknown,
): string {
  if (
    typeof jobIdValue !== "string" ||
    !Number.isSafeInteger(rowIndexValue) ||
    (rowIndexValue as number) < 0 ||
    typeof headersJsonValue !== "string" ||
    typeof rowJsonValue !== "string"
  ) {
    throw new Error("legacy CSV identity input is invalid");
  }
  const headers = JSON.parse(headersJsonValue) as unknown;
  const parsedRow = JSON.parse(rowJsonValue) as unknown;
  if (
    !Array.isArray(headers) ||
    headers.some((header) => typeof header !== "string") ||
    typeof parsedRow !== "object" ||
    parsedRow === null ||
    Array.isArray(parsedRow)
  ) {
    throw new Error("legacy CSV row/header representation is invalid");
  }
  const row = Object.create(null) as Record<string, string>;
  const parsedRecord = parsedRow as Record<string, unknown>;
  for (const header of headers as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(parsedRecord, header);
    const value =
      descriptor !== undefined && "value" in descriptor
        ? descriptor.value
        : undefined;
    if (value !== undefined && typeof value !== "string") {
      throw new Error("legacy CSV row contains a non-string field");
    }
    Object.defineProperty(row, header, {
      configurable: false,
      enumerable: true,
      writable: false,
      value: value ?? "",
    });
  }
  return JSON.stringify(
    deriveCsvItemIdentity(
      jobIdValue,
      rowIndexValue as number,
      headers as string[],
      row as CsvRow,
    ),
  );
}

/**
 * Separate operator-provided CSV identifiers from repository and worker
 * identities, add an atomic import visibility fence, and make ambiguous
 * dispatches non-executable until reviewed.
 */
export const csvJobIdentityReplayMigration: SqlMigration = {
  version: CSV_JOB_IDENTITY_REPLAY_SCHEMA_VERSION,
  name: "csv_job_identity_replay",
  apply: (db) => {
    // Narrow historical fixtures may record migration 2 without constructing
    // its tables. A real v2+ state database always has both tables.
    if (
      !tableExists(db, "csv_agent_jobs") ||
      !tableExists(db, "csv_agent_job_items")
    ) {
      return;
    }
    const legacySchemas = db
      .prepare<
        [],
        {
          readonly id: string;
          readonly status: string;
          readonly output_schema_json: string | null;
        }
      >(`SELECT id, status, output_schema_json FROM csv_agent_jobs`)
      .all();
    const compiledLegacySchemas = new Map<
      string,
      { readonly digest: string; readonly canonicalJson: string }
    >();
    for (const legacy of legacySchemas) {
      if (legacy.output_schema_json === null) continue;
      try {
        const schema = JSON.parse(legacy.output_schema_json) as Record<
          string,
          unknown
        >;
        const compiled = compileCsvOutputSchema(schema);
        if (compiled !== undefined) {
          assertCsvOutputSchemaMigrationCompatible(compiled);
          compiledLegacySchemas.set(legacy.id, {
            digest: compiled.digest,
            canonicalJson: compiled.canonicalJson,
          });
        }
      } catch {
        // Nonterminal jobs receive an execution gate after the additive copy.
        // Completed historical jobs remain inspectable with their original JSON.
      }
    }
    db.function(
      "agenc_csv_legacy_identity_json",
      { deterministic: true },
      legacyCsvIdentityJson,
    );
    db.function(
      "agenc_csv_sha256_text",
      { deterministic: true },
      (value: unknown) => {
        if (typeof value !== "string") {
          throw new Error("legacy CSV digest input is not text");
        }
        return createHash("sha256").update(value).digest("hex");
      },
    );
    db.exec(`
DROP INDEX IF EXISTS idx_csv_agent_jobs_status;
DROP INDEX IF EXISTS idx_csv_agent_job_items_status;

ALTER TABLE csv_agent_job_items RENAME TO csv_agent_job_items_v17;
ALTER TABLE csv_agent_jobs RENAME TO csv_agent_jobs_v17;

CREATE TABLE csv_agent_jobs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'pending', 'running', 'completed', 'failed', 'cancelled',
    'needs_review', 'finished_with_unknown_outcomes'
  )),
  instruction TEXT NOT NULL,
  output_schema_json TEXT CHECK (
    output_schema_json IS NULL OR json_valid(output_schema_json)
  ),
  output_schema_digest TEXT CHECK (
    output_schema_digest IS NULL OR (
      length(output_schema_digest) = 64
      AND output_schema_digest NOT GLOB '*[^0-9a-f]*'
    )
  ),
  output_schema_contract_version INTEGER CHECK (
    output_schema_contract_version IS NULL
    OR output_schema_contract_version = ${CSV_OUTPUT_SCHEMA_CONTRACT_VERSION}
  ),
  execution_gate TEXT NOT NULL CHECK (execution_gate IN (
    'ready', 'legacy_schema_review_required'
  )),
  input_headers_json TEXT NOT NULL CHECK (json_valid(input_headers_json)),
  input_csv_path TEXT NOT NULL,
  output_csv_path TEXT NOT NULL,
  output_mode TEXT NOT NULL DEFAULT 'replace_existing_regular' CHECK (output_mode IN (
    'replace_existing_regular', 'create_new'
  )),
  auto_export INTEGER NOT NULL DEFAULT 1 CHECK (auto_export IN (0, 1)),
  max_runtime_seconds INTEGER CHECK (
    max_runtime_seconds IS NULL OR max_runtime_seconds > 0
  ),
  requested_max_concurrency INTEGER NOT NULL CHECK (
    requested_max_concurrency BETWEEN 1 AND ${CSV_MAX_JOB_CONCURRENCY}
  ),
  last_effective_max_concurrency INTEGER CHECK (
    last_effective_max_concurrency IS NULL
    OR last_effective_max_concurrency BETWEEN 1 AND ${CSV_MAX_JOB_CONCURRENCY}
  ),
  id_column TEXT,
  import_id TEXT NOT NULL UNIQUE,
  import_state TEXT NOT NULL CHECK (import_state IN (
    'staging', 'recovering', 'visible', 'aborted'
  )),
  import_digest TEXT CHECK (
    import_digest IS NULL OR (
      length(import_digest) = 64 AND import_digest NOT GLOB '*[^0-9a-f]*'
    )
  ),
  import_lease_owner TEXT,
  import_lease_expires_at INTEGER,
  import_owner_pid INTEGER CHECK (import_owner_pid IS NULL OR import_owner_pid > 0),
  import_owner_boot_id TEXT,
  import_owner_process_start TEXT,
  import_lease_generation TEXT,
  import_last_batch_row INTEGER NOT NULL DEFAULT -1 CHECK (import_last_batch_row >= -1),
  import_last_batch_digest TEXT CHECK (
    import_last_batch_digest IS NULL OR (
      length(import_last_batch_digest) = 64
      AND import_last_batch_digest NOT GLOB '*[^0-9a-f]*'
    )
  ),
  identity_format_version INTEGER NOT NULL CHECK (
    identity_format_version IN (0, 1)
  ),
  input_bytes INTEGER NOT NULL DEFAULT 0 CHECK (input_bytes >= 0),
  max_items INTEGER NOT NULL CHECK (max_items > 0),
  max_result_bytes INTEGER NOT NULL CHECK (
    max_result_bytes BETWEEN 1 AND ${CSV_MAX_RESULT_BYTES}
  ),
  max_result_bytes_per_job INTEGER NOT NULL CHECK (
    max_result_bytes_per_job BETWEEN 1 AND ${CSV_MAX_RESULT_BYTES_PER_JOB}
  ),
  total_items INTEGER NOT NULL DEFAULT 0 CHECK (total_items >= 0),
  pending_items INTEGER NOT NULL DEFAULT 0 CHECK (pending_items >= 0),
  running_items INTEGER NOT NULL DEFAULT 0 CHECK (running_items >= 0),
  completed_items INTEGER NOT NULL DEFAULT 0 CHECK (completed_items >= 0),
  failed_items INTEGER NOT NULL DEFAULT 0 CHECK (failed_items >= 0),
  cancelled_items INTEGER NOT NULL DEFAULT 0 CHECK (cancelled_items >= 0),
  unknown_outcome_items INTEGER NOT NULL DEFAULT 0 CHECK (
    unknown_outcome_items >= 0
  ),
  result_bytes INTEGER NOT NULL DEFAULT 0 CHECK (result_bytes >= 0),
  result_reserved_bytes INTEGER NOT NULL DEFAULT 0 CHECK (result_reserved_bytes >= 0),
  staging_bytes INTEGER NOT NULL DEFAULT 0 CHECK (staging_bytes >= 0),
  durable_bytes INTEGER NOT NULL DEFAULT 0 CHECK (durable_bytes >= 0),
  output_contract_version INTEGER CHECK (
    output_contract_version IS NULL
    OR output_contract_version = ${CSV_OUTPUT_CONTRACT_VERSION}
  ),
  output_digest TEXT CHECK (
    output_digest IS NULL OR (
      length(output_digest) = 64 AND output_digest NOT GLOB '*[^0-9a-f]*'
    )
  ),
  output_bytes INTEGER NOT NULL DEFAULT 0 CHECK (
    output_bytes BETWEEN 0 AND ${CSV_MAX_OUTPUT_BYTES}
  ),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  retired_at INTEGER,
  last_error TEXT,
  CHECK (
    (import_lease_owner IS NULL AND import_lease_expires_at IS NULL)
    OR
    (import_lease_owner IS NOT NULL AND length(import_lease_owner) > 0
      AND import_lease_expires_at IS NOT NULL)
  ),
  CHECK (
    (import_lease_owner IS NULL
      AND import_owner_pid IS NULL
      AND import_owner_boot_id IS NULL
      AND import_owner_process_start IS NULL
      AND import_lease_generation IS NULL)
    OR
    (import_lease_owner IS NOT NULL
      AND import_owner_pid IS NOT NULL
      AND import_lease_generation IS NOT NULL
      AND length(import_lease_generation) > 0)
  ),
  CHECK (id_column IS NULL OR length(id_column) > 0),
  CHECK (retired_at IS NULL OR completed_at IS NOT NULL)
);

CREATE TABLE csv_agent_job_items (
  job_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  row_index INTEGER NOT NULL CHECK (row_index >= 0),
  source_id TEXT,
  content_sha256 TEXT CHECK (
    content_sha256 IS NULL OR (
      length(content_sha256) = 64
      AND content_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  worker_name TEXT NOT NULL CHECK (
    length(worker_name) BETWEEN 1 AND 96
    AND worker_name NOT GLOB '*[^a-z0-9_]*'
  ),
  identity_format_version INTEGER NOT NULL CHECK (
    identity_format_version IN (0, 1)
  ),
  row_json TEXT NOT NULL CHECK (json_valid(row_json)),
  status TEXT NOT NULL CHECK (status IN (
    'pending', 'running', 'completed', 'failed', 'cancelled',
    'unknown_outcome'
  )),
  dispatch_state TEXT NOT NULL CHECK (dispatch_state IN (
    'not_dispatched', 'dispatching', 'acknowledged', 'settled', 'ambiguous'
  )),
  assigned_thread_id TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  result_digest TEXT CHECK (
    result_digest IS NULL OR (
      length(result_digest) = 64 AND result_digest NOT GLOB '*[^0-9a-f]*'
    )
  ),
  result_availability TEXT NOT NULL CHECK (result_availability IN (
    'not_produced', 'available', 'unavailable_after_review'
  )),
  result_size_bytes INTEGER NOT NULL DEFAULT 0 CHECK (result_size_bytes >= 0),
  result_reserved_bytes INTEGER NOT NULL DEFAULT 0 CHECK (result_reserved_bytes >= 0),
  row_size_bytes INTEGER NOT NULL DEFAULT 0 CHECK (row_size_bytes >= 0),
  last_error TEXT,
  review_status TEXT CHECK (
    review_status IS NULL OR review_status IN ('pending', 'resolved', 'abandoned')
  ),
  review_reason TEXT,
  review_disposition TEXT CHECK (
    review_disposition IS NULL OR review_disposition IN (
      'confirmed_committed', 'confirmed_no_effect', 'remains_unknown'
    )
  ),
  review_domain_action TEXT CHECK (
    review_domain_action IS NULL OR review_domain_action IN (
      'mark_completed', 'retry_new_attempt', 'abandon_item'
    )
  ),
  review_evidence_json TEXT CHECK (
    review_evidence_json IS NULL OR json_valid(review_evidence_json)
  ),
  effect_run_id TEXT,
  effect_step_id TEXT,
  effect_epoch INTEGER CHECK (effect_epoch IS NULL OR effect_epoch > 0),
  execution_semantics TEXT NOT NULL CHECK (execution_semantics IN (
    'at_most_once', 'idempotent_with_key'
  )),
  idempotency_profile TEXT,
  idempotency_profile_version INTEGER CHECK (
    idempotency_profile_version IS NULL OR idempotency_profile_version > 0
  ),
  operation_key TEXT,
  provider_acknowledged_key TEXT,
  lookup_evidence_json TEXT CHECK (
    lookup_evidence_json IS NULL OR json_valid(lookup_evidence_json)
  ),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  reported_at INTEGER,
  PRIMARY KEY (job_id, item_id),
  UNIQUE (job_id, row_index),
  FOREIGN KEY(job_id) REFERENCES csv_agent_jobs(id) ON DELETE CASCADE,
  CHECK (
    (result_availability = 'not_produced'
      AND result_json IS NULL AND result_digest IS NULL
      AND result_size_bytes = 0)
    OR
    (result_availability = 'available'
      AND result_json IS NOT NULL AND result_digest IS NOT NULL
      AND result_size_bytes > 0)
    OR
    (result_availability = 'unavailable_after_review'
      AND result_json IS NULL AND result_digest IS NULL
      AND result_size_bytes = 0
      AND review_status = 'resolved'
      AND review_disposition = 'confirmed_committed'
      AND review_domain_action = 'mark_completed'
      AND review_evidence_json IS NOT NULL)
  ),
  CHECK (
    (status = 'completed' AND result_availability IN (
      'available', 'unavailable_after_review'
    ))
    OR
    (status <> 'completed' AND result_availability = 'not_produced')
  ),
  CHECK (
    (review_status IS NULL
      AND review_reason IS NULL AND review_disposition IS NULL
      AND review_domain_action IS NULL AND review_evidence_json IS NULL)
    OR
    (review_status = 'pending'
      AND review_reason IS NOT NULL AND length(review_reason) > 0
      AND review_disposition IS NULL AND review_domain_action IS NULL)
    OR
    (review_status = 'resolved'
      AND review_disposition IN ('confirmed_committed', 'confirmed_no_effect')
      AND review_domain_action IN ('mark_completed', 'retry_new_attempt')
      AND review_evidence_json IS NOT NULL)
    OR
    (review_status = 'abandoned'
      AND review_disposition = 'remains_unknown'
      AND review_domain_action = 'abandon_item'
      AND review_evidence_json IS NOT NULL)
  ),
  CHECK (
    review_domain_action IS NULL
    OR (review_disposition = 'confirmed_committed'
      AND review_domain_action = 'mark_completed')
    OR (review_disposition = 'confirmed_no_effect'
      AND review_domain_action = 'retry_new_attempt')
    OR (review_disposition = 'remains_unknown'
      AND review_domain_action = 'abandon_item')
  ),
  CHECK (
    status <> 'unknown_outcome' OR review_status IN ('pending', 'abandoned')
  ),
  CHECK (
    provider_acknowledged_key IS NULL
    OR (operation_key = provider_acknowledged_key
      AND idempotency_profile IS NOT NULL
      AND idempotency_profile_version IS NOT NULL)
  ),
  CHECK (
    (execution_semantics = 'at_most_once'
      AND idempotency_profile IS NULL
      AND idempotency_profile_version IS NULL
      AND operation_key IS NULL
      AND provider_acknowledged_key IS NULL)
    OR
    (execution_semantics = 'idempotent_with_key'
      AND idempotency_profile IS NOT NULL
      AND idempotency_profile_version IS NOT NULL
      AND operation_key IS NOT NULL)
  ),
  CHECK (
    (effect_run_id IS NULL AND effect_step_id IS NULL AND effect_epoch IS NULL)
    OR
    (effect_run_id IS NOT NULL AND length(effect_run_id) > 0
      AND effect_step_id IS NOT NULL AND length(effect_step_id) > 0
      AND effect_epoch IS NOT NULL)
  )
);

INSERT INTO csv_agent_jobs (
  id, name, status, instruction, output_schema_json, output_schema_digest,
  output_schema_contract_version, execution_gate, input_headers_json,
  input_csv_path, output_csv_path, output_mode, auto_export, max_runtime_seconds,
  requested_max_concurrency, last_effective_max_concurrency,
  id_column, import_id, import_state, import_digest, import_lease_owner,
  import_lease_expires_at, identity_format_version, input_bytes, max_items,
  max_result_bytes, max_result_bytes_per_job, total_items, pending_items, running_items,
  completed_items, failed_items, cancelled_items, unknown_outcome_items,
  result_bytes, created_at, updated_at, started_at, completed_at, retired_at,
  last_error
)
SELECT
  job.id,
  job.name,
  CASE
    WHEN EXISTS (
      SELECT 1 FROM csv_agent_job_items_v17 AS item
      WHERE item.job_id = job.id AND item.status = 'pending'
    ) THEN CASE WHEN job.started_at IS NULL THEN 'pending' ELSE 'running' END
    WHEN EXISTS (
      SELECT 1 FROM csv_agent_job_items_v17 AS item
      WHERE item.job_id = job.id AND item.status = 'running'
    ) THEN 'needs_review'
    WHEN EXISTS (
      SELECT 1 FROM csv_agent_job_items_v17 AS item
      WHERE item.job_id = job.id
        AND (
          (item.status = 'completed' AND item.result_json IS NULL)
          OR item.status NOT IN ('pending', 'running', 'completed', 'failed', 'cancelled')
        )
    ) THEN 'failed'
    WHEN job.status IN ('pending', 'running', 'completed', 'failed', 'cancelled')
      THEN job.status
    ELSE 'failed'
  END,
  job.instruction,
  job.output_schema_json,
  NULL,
  NULL,
  CASE
    WHEN job.output_schema_json IS NOT NULL
      AND job.status IN ('pending', 'running')
      THEN 'legacy_schema_review_required'
    ELSE 'ready'
  END,
  job.input_headers_json,
  job.input_csv_path,
  job.output_csv_path,
  'replace_existing_regular',
  job.auto_export,
  job.max_runtime_seconds,
  ${CSV_DEFAULT_MAX_CONCURRENCY},
  NULL,
  NULL,
  'legacy-' || lower(hex(randomblob(16))),
  'visible',
  NULL,
  NULL,
  NULL,
  0,
  0,
  ${CSV_MAX_ROWS},
  ${CSV_MAX_RESULT_BYTES},
  ${CSV_MAX_RESULT_BYTES_PER_JOB},
  0, 0, 0, 0, 0, 0, 0, 0,
  job.created_at,
  job.updated_at,
  job.started_at,
  CASE
    WHEN EXISTS (
      SELECT 1 FROM csv_agent_job_items_v17 AS item
      WHERE item.job_id = job.id AND item.status IN ('pending', 'running')
    ) THEN NULL
    ELSE job.completed_at
  END,
  NULL,
  CASE
    WHEN EXISTS (
      SELECT 1 FROM csv_agent_job_items_v17 AS item
      WHERE item.job_id = job.id AND item.status = 'running'
    ) THEN 'legacy_csv_ambiguous'
    ELSE job.last_error
  END
FROM csv_agent_jobs_v17 AS job;

INSERT INTO csv_agent_job_items (
  job_id, item_id, row_index, source_id, content_sha256, worker_name,
  identity_format_version, row_json, status, dispatch_state,
  assigned_thread_id, attempt_count, result_json, result_digest, result_availability,
  result_size_bytes, last_error, review_status, review_reason,
  review_disposition, review_domain_action, review_evidence_json,
  effect_run_id, effect_step_id, effect_epoch, execution_semantics,
  idempotency_profile,
  idempotency_profile_version, operation_key, provider_acknowledged_key,
  lookup_evidence_json, created_at, updated_at, completed_at, reported_at
)
SELECT
  item.job_id,
  json_extract(agenc_csv_legacy_identity_json(
    item.job_id, item.row_index, legacy_job.input_headers_json, item.row_json
  ), '$.itemId'),
  item.row_index,
  item.source_id,
  json_extract(agenc_csv_legacy_identity_json(
    item.job_id, item.row_index, legacy_job.input_headers_json, item.row_json
  ), '$.contentSha256'),
  json_extract(agenc_csv_legacy_identity_json(
    item.job_id, item.row_index, legacy_job.input_headers_json, item.row_json
  ), '$.workerName'),
  0,
  item.row_json,
  CASE
    WHEN item.status = 'running' THEN 'unknown_outcome'
    WHEN item.status = 'completed' AND item.result_json IS NULL THEN 'failed'
    WHEN item.status IN ('pending', 'completed', 'failed', 'cancelled')
      THEN item.status
    ELSE 'failed'
  END,
  CASE
    WHEN item.status = 'pending' THEN 'not_dispatched'
    WHEN item.status = 'running' THEN 'ambiguous'
    ELSE 'settled'
  END,
  item.assigned_thread_id,
  item.attempt_count,
  CASE WHEN item.status = 'completed' THEN item.result_json ELSE NULL END,
  CASE
    WHEN item.status = 'completed' AND item.result_json IS NOT NULL
      THEN agenc_csv_sha256_text(item.result_json)
    ELSE NULL
  END,
  CASE
    WHEN item.status = 'completed' AND item.result_json IS NOT NULL
      THEN 'available'
    ELSE 'not_produced'
  END,
  CASE
    WHEN item.status = 'completed' AND item.result_json IS NOT NULL
      THEN length(CAST(item.result_json AS BLOB))
    ELSE 0
  END,
  CASE
    WHEN item.status = 'running' THEN 'legacy_csv_ambiguous'
    WHEN item.status = 'completed' AND item.result_json IS NULL
      THEN 'legacy_csv_completed_without_result'
    WHEN item.status NOT IN ('pending', 'running', 'completed', 'failed', 'cancelled')
      THEN 'legacy_csv_invalid_status'
    ELSE item.last_error
  END,
  CASE WHEN item.status = 'running' THEN 'pending' ELSE NULL END,
  CASE WHEN item.status = 'running' THEN 'legacy_csv_ambiguous' ELSE NULL END,
  NULL,
  NULL,
  NULL,
  NULL, NULL, NULL, 'at_most_once', NULL, NULL, NULL, NULL, NULL,
  item.created_at,
  item.updated_at,
  CASE
    WHEN item.status = 'running' THEN NULL
    WHEN (item.status = 'completed' AND item.result_json IS NULL)
      OR item.status NOT IN ('pending', 'running', 'completed', 'failed', 'cancelled')
      THEN COALESCE(item.completed_at, item.updated_at)
    ELSE item.completed_at
  END,
  item.reported_at
FROM csv_agent_job_items_v17 AS item
JOIN csv_agent_jobs_v17 AS legacy_job ON legacy_job.id = item.job_id;

UPDATE csv_agent_jobs
SET
  total_items = (
    SELECT COUNT(*) FROM csv_agent_job_items AS item WHERE item.job_id = id
  ),
  pending_items = (
    SELECT COUNT(*) FROM csv_agent_job_items AS item
    WHERE item.job_id = id AND item.status = 'pending'
  ),
  running_items = (
    SELECT COUNT(*) FROM csv_agent_job_items AS item
    WHERE item.job_id = id AND item.status = 'running'
  ),
  completed_items = (
    SELECT COUNT(*) FROM csv_agent_job_items AS item
    WHERE item.job_id = id AND item.status = 'completed'
  ),
  failed_items = (
    SELECT COUNT(*) FROM csv_agent_job_items AS item
    WHERE item.job_id = id AND item.status = 'failed'
  ),
  cancelled_items = (
    SELECT COUNT(*) FROM csv_agent_job_items AS item
    WHERE item.job_id = id AND item.status = 'cancelled'
  ),
  unknown_outcome_items = (
    SELECT COUNT(*) FROM csv_agent_job_items AS item
    WHERE item.job_id = id AND item.status = 'unknown_outcome'
  ),
  result_bytes = (
    SELECT COALESCE(SUM(result_size_bytes), 0)
    FROM csv_agent_job_items AS item WHERE item.job_id = id
  );

DROP TABLE csv_agent_job_items_v17;
DROP TABLE csv_agent_jobs_v17;

CREATE INDEX idx_csv_agent_jobs_status
  ON csv_agent_jobs(import_state, retired_at, status, updated_at DESC, id);
CREATE INDEX idx_csv_agent_jobs_import_lease
  ON csv_agent_jobs(import_state, import_lease_expires_at, import_id)
  WHERE import_state = 'staging';
CREATE INDEX idx_csv_agent_job_items_status
  ON csv_agent_job_items(job_id, status, row_index ASC, item_id ASC);
CREATE UNIQUE INDEX idx_csv_agent_job_items_operation_key
  ON csv_agent_job_items(idempotency_profile, operation_key)
  WHERE idempotency_profile IS NOT NULL AND operation_key IS NOT NULL;
CREATE UNIQUE INDEX idx_csv_agent_job_items_source_id
  ON csv_agent_job_items(job_id, source_id)
  WHERE source_id IS NOT NULL AND identity_format_version = 1;
CREATE INDEX idx_csv_agent_job_items_review
  ON csv_agent_job_items(job_id, review_status, row_index ASC)
  WHERE review_status IS NOT NULL;

CREATE TABLE csv_agent_job_review_history (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  review_status TEXT NOT NULL CHECK (review_status IN (
    'pending', 'resolved', 'abandoned'
  )),
  disposition TEXT CHECK (disposition IS NULL OR disposition IN (
    'confirmed_committed', 'confirmed_no_effect', 'remains_unknown'
  )),
  domain_action TEXT CHECK (domain_action IS NULL OR domain_action IN (
    'mark_completed', 'retry_new_attempt', 'abandon_item'
  )),
  actor TEXT NOT NULL,
  reason TEXT NOT NULL,
  evidence_json TEXT CHECK (evidence_json IS NULL OR json_valid(evidence_json)),
  effect_run_id TEXT,
  effect_step_id TEXT,
  effect_epoch INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(job_id, item_id)
    REFERENCES csv_agent_job_items(job_id, item_id) ON DELETE CASCADE
);
CREATE INDEX idx_csv_agent_job_review_history_item
  ON csv_agent_job_review_history(job_id, item_id, sequence ASC);

CREATE TABLE csv_job_tombstones (
  job_id TEXT PRIMARY KEY,
  final_status TEXT NOT NULL,
  final_counters_json TEXT NOT NULL CHECK (json_valid(final_counters_json)),
  input_digest TEXT,
  output_digest TEXT,
  output_schema_digest TEXT,
  result_set_digest TEXT,
  evidence_references_json TEXT NOT NULL CHECK (
    json_valid(evidence_references_json)
  ),
  payload_bytes INTEGER NOT NULL CHECK (payload_bytes >= 0),
  created_at INTEGER NOT NULL
);

CREATE TABLE csv_job_gc_intents (
  job_id TEXT PRIMARY KEY,
  cursor_row_index INTEGER NOT NULL DEFAULT -1,
  state TEXT NOT NULL CHECK (state IN ('tombstoned', 'deleting')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(job_id) REFERENCES csv_agent_jobs(id) ON DELETE CASCADE
);

CREATE TABLE csv_output_intents (
  intent_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  root_path TEXT NOT NULL,
  target_path TEXT NOT NULL,
  temporary_path TEXT NOT NULL,
  temporary_dev TEXT,
  temporary_ino TEXT,
  reserved_bytes INTEGER NOT NULL CHECK (
    reserved_bytes BETWEEN 0 AND ${CSV_MAX_OUTPUT_STAGING_BYTES_GLOBAL}
  ),
  state TEXT NOT NULL CHECK (state IN (
    'writing', 'flushed', 'published', 'abandoned', 'recovering'
  )),
  recovery_prior_state TEXT CHECK (recovery_prior_state IS NULL OR recovery_prior_state IN (
    'writing', 'flushed', 'published', 'abandoned'
  )),
  owner_generation TEXT NOT NULL,
  owner_pid INTEGER NOT NULL CHECK (owner_pid > 0),
  owner_boot_id TEXT,
  owner_process_start TEXT,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(job_id) REFERENCES csv_agent_jobs(id) ON DELETE CASCADE
);

CREATE TABLE csv_storage_quota (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  active_imports INTEGER NOT NULL CHECK (active_imports >= 0),
  staging_rows INTEGER NOT NULL CHECK (staging_rows >= 0),
  staging_bytes INTEGER NOT NULL CHECK (staging_bytes >= 0),
  durable_jobs INTEGER NOT NULL CHECK (durable_jobs >= 0),
  durable_items INTEGER NOT NULL CHECK (durable_items >= 0),
  durable_bytes INTEGER NOT NULL CHECK (durable_bytes >= 0),
  durable_reserved_items INTEGER NOT NULL CHECK (durable_reserved_items >= 0),
  durable_reserved_bytes INTEGER NOT NULL CHECK (durable_reserved_bytes >= 0),
  result_blob_bytes INTEGER NOT NULL CHECK (result_blob_bytes >= 0),
  result_reserved_bytes INTEGER NOT NULL CHECK (result_reserved_bytes >= 0),
  tombstones INTEGER NOT NULL CHECK (tombstones >= 0),
  tombstone_bytes INTEGER NOT NULL CHECK (tombstone_bytes >= 0),
  output_staging_files INTEGER NOT NULL CHECK (output_staging_files >= 0),
  output_staging_bytes INTEGER NOT NULL CHECK (output_staging_bytes >= 0),
  updated_at INTEGER NOT NULL
);

UPDATE csv_agent_job_items SET
  row_size_bytes = length(CAST(row_json AS BLOB))
    + length(CAST(item_id AS BLOB))
    + length(CAST(worker_name AS BLOB))
    + COALESCE(length(CAST(source_id AS BLOB)), 0)
    + COALESCE(length(CAST(content_sha256 AS BLOB)), 0)
    + 256;

UPDATE csv_agent_jobs SET durable_bytes = (
  SELECT COALESCE(SUM(item.row_size_bytes + item.result_size_bytes), 0)
  FROM csv_agent_job_items AS item WHERE item.job_id = csv_agent_jobs.id
);

UPDATE csv_agent_job_items SET result_reserved_bytes = (
  SELECT job.max_result_bytes FROM csv_agent_jobs AS job
  WHERE job.id = csv_agent_job_items.job_id
)
WHERE status = 'unknown_outcome';

UPDATE csv_agent_jobs SET result_reserved_bytes = (
  SELECT COALESCE(SUM(item.result_reserved_bytes), 0)
  FROM csv_agent_job_items AS item WHERE item.job_id = csv_agent_jobs.id
);

INSERT INTO csv_storage_quota (
  singleton, active_imports, staging_rows, staging_bytes, durable_jobs,
  durable_items, durable_bytes, durable_reserved_items,
  durable_reserved_bytes, result_blob_bytes, result_reserved_bytes,
  tombstones, tombstone_bytes, output_staging_files, output_staging_bytes,
  updated_at
)
SELECT
  1,
  COALESCE(SUM(import_state IN ('staging', 'recovering')), 0),
  COALESCE(SUM(CASE WHEN import_state IN ('staging', 'recovering')
    THEN total_items ELSE 0 END), 0),
  COALESCE(SUM(CASE WHEN import_state IN ('staging', 'recovering')
    THEN staging_bytes ELSE 0 END), 0),
  COALESCE(SUM(import_state = 'visible'), 0),
  COALESCE(SUM(CASE WHEN import_state = 'visible'
    THEN total_items ELSE 0 END), 0),
  COALESCE(SUM(CASE WHEN import_state = 'visible'
    THEN durable_bytes ELSE 0 END), 0),
  0, 0,
  COALESCE(SUM(CASE WHEN import_state = 'visible'
    THEN result_bytes ELSE 0 END), 0),
  COALESCE(SUM(result_reserved_bytes), 0),
  0, 0, 0, 0,
  CAST(strftime('%s', 'now') AS INTEGER)
FROM csv_agent_jobs;

CREATE VIEW csv_import_intents AS
SELECT id AS job_id, import_id, import_state, import_digest,
       import_lease_owner, import_lease_generation, import_owner_pid,
       import_owner_boot_id, import_owner_process_start,
       import_last_batch_row, import_last_batch_digest, total_items,
       staging_bytes, created_at, updated_at
FROM csv_agent_jobs WHERE import_state <> 'visible';

CREATE VIEW csv_import_staging AS
SELECT item.* FROM csv_agent_job_items AS item
JOIN csv_agent_jobs AS job ON job.id = item.job_id
WHERE job.import_state IN ('staging', 'recovering', 'aborted');

CREATE TRIGGER csv_agent_job_item_insert_counters
AFTER INSERT ON csv_agent_job_items
BEGIN
  UPDATE csv_agent_jobs SET
    total_items = total_items + 1,
    pending_items = pending_items + (NEW.status = 'pending'),
    running_items = running_items + (NEW.status = 'running'),
    completed_items = completed_items + (NEW.status = 'completed'),
    failed_items = failed_items + (NEW.status = 'failed'),
    cancelled_items = cancelled_items + (NEW.status = 'cancelled'),
    unknown_outcome_items = unknown_outcome_items
      + (NEW.status = 'unknown_outcome'),
    result_bytes = result_bytes + NEW.result_size_bytes
  WHERE id = NEW.job_id;
END;

CREATE TRIGGER csv_agent_job_item_update_counters
AFTER UPDATE OF status, result_size_bytes ON csv_agent_job_items
BEGIN
  UPDATE csv_agent_jobs SET
    pending_items = pending_items - (OLD.status = 'pending')
      + (NEW.status = 'pending'),
    running_items = running_items - (OLD.status = 'running')
      + (NEW.status = 'running'),
    completed_items = completed_items - (OLD.status = 'completed')
      + (NEW.status = 'completed'),
    failed_items = failed_items - (OLD.status = 'failed')
      + (NEW.status = 'failed'),
    cancelled_items = cancelled_items - (OLD.status = 'cancelled')
      + (NEW.status = 'cancelled'),
    unknown_outcome_items = unknown_outcome_items
      - (OLD.status = 'unknown_outcome') + (NEW.status = 'unknown_outcome'),
    result_bytes = result_bytes - OLD.result_size_bytes + NEW.result_size_bytes
  WHERE id = NEW.job_id;
END;

CREATE TRIGGER csv_agent_job_item_delete_counters
AFTER DELETE ON csv_agent_job_items
BEGIN
  UPDATE csv_agent_jobs SET
    total_items = total_items - 1,
    pending_items = pending_items - (OLD.status = 'pending'),
    running_items = running_items - (OLD.status = 'running'),
    completed_items = completed_items - (OLD.status = 'completed'),
    failed_items = failed_items - (OLD.status = 'failed'),
    cancelled_items = cancelled_items - (OLD.status = 'cancelled'),
    unknown_outcome_items = unknown_outcome_items
      - (OLD.status = 'unknown_outcome'),
    result_bytes = result_bytes - OLD.result_size_bytes
  WHERE id = OLD.job_id;
END;
`);
    const updateCompiledSchema = db.prepare<
      [string, number, string, string],
      unknown
    >(
      `UPDATE csv_agent_jobs
       SET output_schema_json = ?, output_schema_contract_version = ?,
           output_schema_digest = ?, execution_gate = 'ready'
       WHERE id = ?`,
    );
    for (const [jobId, compiled] of compiledLegacySchemas) {
      updateCompiledSchema.run(
        compiled.canonicalJson,
        CSV_OUTPUT_SCHEMA_CONTRACT_VERSION,
        compiled.digest,
        jobId,
      );
    }
  },
};
