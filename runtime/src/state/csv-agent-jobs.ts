/**
 * Durable CSV job state. Operator source IDs are data only; item and worker
 * identities are runtime-owned. Every public selector joins the import
 * visibility fence, and ambiguous dispatches are held for review.
 */

import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  CSV_AGENT_JOB_ITEM_STATUSES,
  CSV_AGENT_JOB_STATUSES,
  CSV_JOB_GC_PAGE_ITEMS,
  CSV_MAX_ACTIVE_IMPORTS,
  CSV_MAX_DURABLE_BYTES,
  CSV_MAX_DURABLE_ITEMS,
  CSV_MAX_DURABLE_JOBS,
  CSV_MAX_FIELD_BYTES,
  CSV_DEFAULT_ITEM_PAGE_SIZE,
  CSV_DEFAULT_MAX_CONCURRENCY,
  CSV_IMPORT_LEASE_SECONDS,
  CSV_JOB_CONTRACT_VERSION,
  CSV_JOB_IDENTITY_FORMAT_VERSION,
  CSV_MAX_COLUMNS,
  CSV_MAX_HEADER_BYTES,
  CSV_MAX_ITEM_PAGE_BYTES,
  CSV_MAX_ITEM_PROJECTION_BYTES,
  CSV_MAX_ITEM_PAGE_SIZE,
  CSV_MAX_JOB_GC_MS_PER_SLICE,
  CSV_MAX_JOB_TOMBSTONE_BYTES,
  CSV_MAX_JOB_TOMBSTONES,
  CSV_MAX_JOB_CONCURRENCY,
  CSV_MAX_OUTPUT_BYTES,
  CSV_MAX_OUTPUT_STAGING_BYTES_GLOBAL,
  CSV_MAX_OUTPUT_STAGING_FILES_GLOBAL,
  CSV_MAX_RESULT_BLOB_BYTES_GLOBAL,
  CSV_MAX_RESULT_PREVIEW_BYTES,
  CSV_MAX_RESULT_BYTES,
  CSV_MAX_RESULT_BYTES_PER_JOB,
  CSV_MAX_ROWS,
  CSV_MAX_STAGING_BYTES_GLOBAL,
  CSV_MAX_STAGING_GC_MS_PER_START,
  CSV_MAX_STAGING_ROWS_GLOBAL,
  CSV_OUTPUT_CONTRACT_VERSION,
  CSV_RESULT_BLOB_CHUNK_BYTES,
  CSV_RESULT_AVAILABILITIES,
  CSV_RESERVED_OUTPUT_HEADERS,
  CSV_TERMINAL_JOB_RETENTION_MS,
  type CsvAgentJobItemStatus,
  type CsvAgentJobStatus,
  type CsvJobEffectReference,
  type CsvJobItemCursor,
  type CsvResultAvailability,
  type CsvReviewDisposition,
  type CsvReviewDomainAction,
  type CsvReviewStatus,
} from "../contracts/csv-job-contract.js";
import {
  canonicalizeCsvResult,
  compileCsvOutputSchema,
  validateCsvResultForPersistence,
  type CanonicalCsvResult,
  type ValidatedCsvResult,
} from "../agents/jobs/csv-schema.js";
import type {
  CsvOutputArtifact,
  CsvOutputMode,
  CsvOutputRecoveryIntent,
} from "../agents/jobs/csv-output.js";
import type { StateSqliteDriver } from "./sqlite-driver.js";
import { resolveDurableEffectReview } from "./effect-review.js";
import { StateRunDurabilityRepository } from "./run-durability.js";
import type { EffectReviewResolution } from "../contracts/run-contracts.js";

export type {
  CsvAgentJobItemStatus,
  CsvAgentJobStatus,
  CsvResultAvailability,
  CsvReviewDisposition,
  CsvReviewDomainAction,
  CsvReviewStatus,
} from "../contracts/csv-job-contract.js";

const JOB_STATUSES: ReadonlySet<CsvAgentJobStatus> = new Set(
  CSV_AGENT_JOB_STATUSES,
);

const ITEM_STATUSES: ReadonlySet<CsvAgentJobItemStatus> = new Set(
  CSV_AGENT_JOB_ITEM_STATUSES,
);

const RESULT_AVAILABILITIES: ReadonlySet<CsvResultAvailability> = new Set(
  CSV_RESULT_AVAILABILITIES,
);

function parseEnum<T extends string>(
  raw: string,
  values: ReadonlySet<T>,
  label: string,
): T {
  if (!values.has(raw as T)) throw new Error(`invalid ${label}: ${raw}`);
  return raw as T;
}

function parseJobStatus(raw: string): CsvAgentJobStatus {
  return parseEnum(raw, JOB_STATUSES, "CSV job status");
}

function parseItemStatus(raw: string): CsvAgentJobItemStatus {
  return parseEnum(raw, ITEM_STATUSES, "CSV job item status");
}

function parseResultAvailability(raw: string): CsvResultAvailability {
  return parseEnum(raw, RESULT_AVAILABILITIES, "CSV result availability");
}

export interface CsvAgentJob {
  readonly id: string;
  readonly name: string;
  readonly status: CsvAgentJobStatus;
  readonly instruction: string;
  readonly autoExport: boolean;
  readonly maxRuntimeSeconds?: number;
  readonly requestedMaxConcurrency: number;
  readonly lastEffectiveMaxConcurrency?: number;
  readonly outputSchema?: Record<string, unknown>;
  readonly outputSchemaDigest?: string;
  readonly outputSchemaContractVersion?: number;
  readonly executionGate: "ready" | "legacy_schema_review_required";
  readonly inputHeaders: ReadonlyArray<string>;
  readonly inputCsvPath: string;
  readonly outputCsvPath: string;
  readonly outputMode: CsvOutputMode;
  readonly idColumn?: string;
  readonly importId: string;
  readonly importState: "staging" | "visible" | "aborted";
  readonly importDigest?: string;
  readonly identityFormatVersion: 0 | 1;
  readonly inputBytes: number;
  readonly maxItems: number;
  readonly maxResultBytes: number;
  readonly maxResultBytesPerJob: number;
  readonly totalItems: number;
  readonly pendingItems: number;
  readonly runningItems: number;
  readonly completedItems: number;
  readonly failedItems: number;
  readonly cancelledItems: number;
  readonly unknownOutcomeItems: number;
  readonly resultBytes: number;
  readonly resultReservedBytes: number;
  readonly stagingBytes: number;
  readonly durableBytes: number;
  readonly outputContractVersion?: number;
  readonly outputDigest?: string;
  readonly outputBytes: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly startedAt?: number;
  readonly completedAt?: number;
  readonly retiredAt?: number;
  readonly lastError?: string;
}

export interface CsvAgentJobItem {
  readonly jobId: string;
  readonly itemId: string;
  readonly rowIndex: number;
  readonly sourceId?: string;
  readonly contentSha256?: string;
  readonly workerName: string;
  readonly identityFormatVersion: 0 | 1;
  readonly row: Readonly<Record<string, unknown>>;
  readonly status: CsvAgentJobItemStatus;
  readonly dispatchState:
    "not_dispatched" | "dispatching" | "acknowledged" | "settled" | "ambiguous";
  readonly assignedThreadId?: string;
  readonly attemptCount: number;
  readonly result?: Record<string, unknown>;
  readonly resultDigest?: string;
  readonly resultAvailability: CsvResultAvailability;
  readonly resultSizeBytes: number;
  readonly lastError?: string;
  readonly reviewStatus?: CsvReviewStatus;
  readonly reviewReason?: string;
  readonly reviewDisposition?: CsvReviewDisposition;
  readonly reviewDomainAction?: CsvReviewDomainAction;
  readonly reviewEvidence?: Record<string, unknown>;
  readonly effect?: CsvJobEffectReference;
  readonly executionSemantics: "at_most_once" | "idempotent_with_key";
  readonly idempotencyProfile?: string;
  readonly idempotencyProfileVersion?: number;
  readonly operationKey?: string;
  readonly providerAcknowledgedKey?: string;
  readonly lookupEvidence?: Record<string, unknown>;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly completedAt?: number;
  readonly reportedAt?: number;
}

export interface CsvAgentJobProgress {
  readonly totalItems: number;
  readonly pendingItems: number;
  readonly runningItems: number;
  readonly completedItems: number;
  readonly failedItems: number;
  readonly cancelledItems: number;
  readonly unknownOutcomeItems: number;
  readonly reviewPendingItems: number;
}

export interface CsvAgentJobSummary extends CsvAgentJobProgress {
  readonly contractVersion: typeof CSV_JOB_CONTRACT_VERSION;
  readonly jobId: string;
  readonly status: CsvAgentJobStatus;
  readonly resultBytes: number;
  readonly availableResults: number;
  readonly unavailableAfterReviewResults: number;
  readonly notProducedResults: number;
}

export interface CsvAgentJobItemSummary {
  readonly itemId: string;
  readonly rowIndex: number;
  readonly sourceId?: string;
  readonly sourceIdTruncated?: boolean;
  readonly sourceIdDigest?: string;
  readonly status: CsvAgentJobItemStatus;
  readonly attemptCount: number;
  readonly resultAvailability: CsvResultAvailability;
  readonly resultSizeBytes: number;
  readonly resultDigest?: string;
  readonly resultPreviewJson?: string;
  readonly resultPreviewTruncated?: boolean;
  readonly lastError?: string;
  readonly lastErrorTruncated?: boolean;
  readonly reviewStatus?: CsvReviewStatus;
  readonly reviewReason?: string;
  readonly reviewReasonTruncated?: boolean;
}

export interface CsvAgentJobItemPage {
  readonly contractVersion: typeof CSV_JOB_CONTRACT_VERSION;
  readonly items: ReadonlyArray<CsvAgentJobItemSummary>;
  readonly nextCursor?: CsvJobItemCursor;
}

export interface CsvResultBlobChunk {
  readonly contractVersion: typeof CSV_JOB_CONTRACT_VERSION;
  readonly itemId: string;
  readonly availability: CsvResultAvailability;
  readonly totalBytes: number;
  readonly digest?: string;
  readonly byteOffset: number;
  readonly dataBase64: string;
  readonly nextByteOffset?: number;
}

export interface CsvAgentJobCreateParams {
  readonly id: string;
  readonly name: string;
  readonly instruction: string;
  readonly autoExport: boolean;
  readonly maxRuntimeSeconds?: number;
  readonly requestedMaxConcurrency?: number;
  readonly outputSchema?: Record<string, unknown>;
  readonly inputHeaders: ReadonlyArray<string>;
  readonly inputCsvPath: string;
  readonly outputCsvPath: string;
  readonly outputMode?: CsvOutputMode;
  readonly idColumn?: string;
  readonly importId?: string;
  readonly importDigest?: string;
  readonly inputBytes?: number;
  readonly maxItems?: number;
  readonly maxResultBytes?: number;
  readonly maxResultBytesPerJob?: number;
}

export interface CsvAgentJobItemCreateParams {
  readonly itemId: string;
  readonly rowIndex: number;
  readonly sourceId?: string;
  readonly contentSha256: string;
  readonly workerName: string;
  readonly row: Readonly<Record<string, unknown>>;
}

export interface CsvAgentJobImportHandle {
  readonly jobId: string;
  readonly importId: string;
  readonly leaseOwner: string;
  readonly leaseGeneration: string;
}

export interface CsvAgentJobImportCompletion {
  readonly importDigest: string;
  readonly inputBytes: number;
  readonly totalItems: number;
}

export interface CsvDispatchEvidence {
  readonly effect?: CsvJobEffectReference;
  readonly idempotencyProfile?: string;
  readonly idempotencyProfileVersion?: number;
  readonly operationKey?: string;
}

export interface CsvDispatchAcknowledgement {
  readonly threadId?: string;
  readonly providerAcknowledgedKey?: string;
  readonly effect?: CsvJobEffectReference;
}

export interface CsvUnknownOutcomeResolution {
  readonly jobId: string;
  readonly itemId: string;
  readonly disposition: CsvReviewDisposition;
  readonly domainAction: CsvReviewDomainAction;
  readonly evidence: Record<string, unknown>;
  readonly actor: string;
  readonly reason: string;
  readonly effectReview?: EffectReviewResolution;
  readonly result?: Record<string, unknown>;
}

export interface CsvResolveUnknownOutcomeOptions {
  /** Request-local cancellation only; this value is never persisted. */
  readonly signal?: AbortSignal;
}

export const CSV_REVIEW_SOURCE_ID_PROJECTION_BYTES = 1_024;
export const CSV_REVIEW_REASON_PROJECTION_BYTES = 4_096;
export const CSV_REVIEW_EVIDENCE_PROJECTION_BYTES = 4_096;
export const CSV_REVIEW_IDENTIFIER_PROJECTION_BYTES = 1_024;
export const CSV_REVIEW_SOURCE_DIGEST_PAGE_BYTES = CSV_MAX_FIELD_BYTES;

export interface CsvReviewJsonProjection {
  /** Exact UTF-8 byte length of the stored JSON. */
  readonly bytes: number;
  /** SHA-256 of the complete stored JSON, never a truncated prefix. */
  readonly sha256: string;
  readonly truncated: boolean;
  /** Present only when the complete stored JSON fit within the projection. */
  readonly value?: Readonly<Record<string, unknown>>;
}

/**
 * Review-only projection for operator list/show/replay paths. It deliberately
 * excludes both the imported row and the result blob.
 */
export interface CsvAgentJobReviewProjection {
  readonly jobId: string;
  readonly itemId: string;
  readonly rowIndex: number;
  readonly sourceId?: string;
  readonly sourceIdBytes?: number;
  readonly sourceIdTruncated?: boolean;
  readonly sourceIdDigest?: string;
  readonly status: CsvAgentJobItemStatus;
  readonly attemptCount: number;
  readonly resultAvailability: CsvResultAvailability;
  readonly resultSizeBytes: number;
  readonly resultDigest?: string;
  readonly reviewStatus?: CsvReviewStatus;
  readonly reviewReason?: string;
  readonly reviewReasonBytes?: number;
  readonly reviewReasonTruncated?: boolean;
  readonly reviewDisposition?: CsvReviewDisposition;
  readonly reviewDomainAction?: CsvReviewDomainAction;
  readonly reviewEvidence?: CsvReviewJsonProjection;
  readonly effect?: CsvJobEffectReference;
  readonly lookupEvidence?: CsvReviewJsonProjection;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly completedAt?: number;
}

export interface CsvAgentJobReviewProjectionPage {
  readonly contractVersion: typeof CSV_JOB_CONTRACT_VERSION;
  readonly reviews: ReadonlyArray<CsvAgentJobReviewProjection>;
  readonly nextCursor?: CsvJobItemCursor;
}

interface JobRow {
  id: string;
  name: string;
  status: string;
  instruction: string;
  auto_export: number;
  max_runtime_seconds: number | null;
  requested_max_concurrency: number;
  last_effective_max_concurrency: number | null;
  output_schema_json: string | null;
  output_schema_digest: string | null;
  output_schema_contract_version: number | null;
  execution_gate: "ready" | "legacy_schema_review_required";
  input_headers_json: string;
  input_csv_path: string;
  output_csv_path: string;
  output_mode: CsvOutputMode;
  id_column: string | null;
  import_id: string;
  import_state: "staging" | "visible" | "aborted";
  import_digest: string | null;
  import_lease_generation: string | null;
  import_last_batch_row: number;
  import_last_batch_digest: string | null;
  identity_format_version: 0 | 1;
  input_bytes: number;
  max_items: number;
  max_result_bytes: number;
  max_result_bytes_per_job: number;
  total_items: number;
  pending_items: number;
  running_items: number;
  completed_items: number;
  failed_items: number;
  cancelled_items: number;
  unknown_outcome_items: number;
  result_bytes: number;
  result_reserved_bytes: number;
  staging_bytes: number;
  durable_bytes: number;
  output_contract_version: number | null;
  output_digest: string | null;
  output_bytes: number;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  completed_at: number | null;
  retired_at: number | null;
  last_error: string | null;
}

interface ItemRow {
  job_id: string;
  item_id: string;
  row_index: number;
  source_id: string | null;
  content_sha256: string | null;
  worker_name: string;
  identity_format_version: 0 | 1;
  row_json: string;
  status: string;
  dispatch_state: CsvAgentJobItem["dispatchState"];
  assigned_thread_id: string | null;
  attempt_count: number;
  result_json: string | null;
  result_digest: string | null;
  result_availability: string;
  result_size_bytes: number;
  result_reserved_bytes: number;
  row_size_bytes: number;
  last_error: string | null;
  review_status: CsvReviewStatus | null;
  review_reason: string | null;
  review_disposition: CsvReviewDisposition | null;
  review_domain_action: CsvReviewDomainAction | null;
  review_evidence_json: string | null;
  effect_run_id: string | null;
  effect_step_id: string | null;
  effect_epoch: number | null;
  execution_semantics: "at_most_once" | "idempotent_with_key";
  idempotency_profile: string | null;
  idempotency_profile_version: number | null;
  operation_key: string | null;
  provider_acknowledged_key: string | null;
  lookup_evidence_json: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  reported_at: number | null;
}

interface ReviewProjectionRow {
  job_id_prefix: Uint8Array;
  job_id_bytes: number;
  item_id_prefix: Uint8Array;
  item_id_bytes: number;
  row_index: number;
  source_id_prefix: Uint8Array | null;
  source_id_bytes: number | null;
  status: string;
  attempt_count: number;
  result_availability: string;
  result_size_bytes: number;
  result_digest: string | null;
  review_status: CsvReviewStatus | null;
  review_reason_prefix: Uint8Array | null;
  review_reason_bytes: number | null;
  review_disposition: CsvReviewDisposition | null;
  review_domain_action: CsvReviewDomainAction | null;
  review_evidence_json: Uint8Array | null;
  review_evidence_bytes: number | null;
  effect_run_id_prefix: Uint8Array | null;
  effect_run_id_bytes: number | null;
  effect_step_id_prefix: Uint8Array | null;
  effect_step_id_bytes: number | null;
  effect_epoch: number | null;
  lookup_evidence_json: Uint8Array | null;
  lookup_evidence_bytes: number | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

type ReviewListProjectionRow = Omit<
  ReviewProjectionRow,
  | "review_evidence_json"
  | "review_evidence_bytes"
  | "lookup_evidence_json"
  | "lookup_evidence_bytes"
>;

interface ResultBlobRow {
  item_id: string;
  result_json: string | null;
  result_availability: string;
  result_size_bytes: number;
  result_digest: string | null;
}

interface CsvResultPersistenceAccounting {
  readonly result_size_bytes: number;
  readonly result_reserved_bytes: number;
}

interface ValidatedCsvResultPersistencePlan {
  readonly canonical: CanonicalCsvResult;
  readonly schemaDigest: string | undefined;
  readonly previous: CsvResultPersistenceAccounting;
}

interface CsvJobItemStatusAccounting {
  readonly pending_items: number;
  readonly running_items: number;
  readonly completed_items: number;
  readonly failed_items: number;
  readonly cancelled_items: number;
  readonly unknown_outcome_items: number;
}

function decodeJob(row: JobRow): CsvAgentJob {
  return {
    id: row.id,
    name: row.name,
    status: parseJobStatus(row.status),
    instruction: row.instruction,
    autoExport: row.auto_export !== 0,
    ...(row.max_runtime_seconds !== null
      ? { maxRuntimeSeconds: row.max_runtime_seconds }
      : {}),
    requestedMaxConcurrency: row.requested_max_concurrency,
    ...(row.last_effective_max_concurrency !== null
      ? { lastEffectiveMaxConcurrency: row.last_effective_max_concurrency }
      : {}),
    ...(row.output_schema_json !== null
      ? {
          outputSchema: JSON.parse(row.output_schema_json) as Record<
            string,
            unknown
          >,
        }
      : {}),
    ...(row.output_schema_digest !== null
      ? { outputSchemaDigest: row.output_schema_digest }
      : {}),
    ...(row.output_schema_contract_version !== null
      ? { outputSchemaContractVersion: row.output_schema_contract_version }
      : {}),
    executionGate: row.execution_gate,
    inputHeaders: JSON.parse(row.input_headers_json) as string[],
    inputCsvPath: row.input_csv_path,
    outputCsvPath: row.output_csv_path,
    outputMode: row.output_mode,
    ...(row.id_column !== null ? { idColumn: row.id_column } : {}),
    importId: row.import_id,
    importState: row.import_state,
    ...(row.import_digest !== null ? { importDigest: row.import_digest } : {}),
    identityFormatVersion: row.identity_format_version,
    inputBytes: row.input_bytes,
    maxItems: row.max_items,
    maxResultBytes: row.max_result_bytes,
    maxResultBytesPerJob: row.max_result_bytes_per_job,
    totalItems: row.total_items,
    pendingItems: row.pending_items,
    runningItems: row.running_items,
    completedItems: row.completed_items,
    failedItems: row.failed_items,
    cancelledItems: row.cancelled_items,
    unknownOutcomeItems: row.unknown_outcome_items,
    resultBytes: row.result_bytes,
    resultReservedBytes: row.result_reserved_bytes,
    stagingBytes: row.staging_bytes,
    durableBytes: row.durable_bytes,
    ...(row.output_contract_version !== null
      ? { outputContractVersion: row.output_contract_version }
      : {}),
    ...(row.output_digest !== null ? { outputDigest: row.output_digest } : {}),
    outputBytes: row.output_bytes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.started_at !== null ? { startedAt: row.started_at } : {}),
    ...(row.completed_at !== null ? { completedAt: row.completed_at } : {}),
    ...(row.retired_at !== null ? { retiredAt: row.retired_at } : {}),
    ...(row.last_error !== null ? { lastError: row.last_error } : {}),
  };
}

function decodeInertRow(json: string): Readonly<Record<string, unknown>> {
  const parsed = JSON.parse(json) as Record<string, unknown>;
  const inert = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of Object.entries(parsed)) {
    Object.defineProperty(inert, key, {
      configurable: false,
      enumerable: true,
      writable: false,
      value,
    });
  }
  return Object.freeze(inert);
}

function decodeJsonObject(
  json: string | null,
): Record<string, unknown> | undefined {
  return json === null
    ? undefined
    : (JSON.parse(json) as Record<string, unknown>);
}

function decodeItem(row: ItemRow): CsvAgentJobItem {
  const result = decodeJsonObject(row.result_json);
  const reviewEvidence = decodeJsonObject(row.review_evidence_json);
  const lookupEvidence = decodeJsonObject(row.lookup_evidence_json);
  const effect =
    row.effect_run_id !== null &&
    row.effect_step_id !== null &&
    row.effect_epoch !== null
      ? {
          runId: row.effect_run_id,
          stepId: row.effect_step_id,
          epoch: row.effect_epoch,
        }
      : undefined;
  return {
    jobId: row.job_id,
    itemId: row.item_id,
    rowIndex: row.row_index,
    ...(row.source_id !== null ? { sourceId: row.source_id } : {}),
    ...(row.content_sha256 !== null
      ? { contentSha256: row.content_sha256 }
      : {}),
    workerName: row.worker_name,
    identityFormatVersion: row.identity_format_version,
    row: decodeInertRow(row.row_json),
    status: parseItemStatus(row.status),
    dispatchState: row.dispatch_state,
    ...(row.assigned_thread_id !== null
      ? { assignedThreadId: row.assigned_thread_id }
      : {}),
    attemptCount: row.attempt_count,
    ...(result !== undefined ? { result } : {}),
    ...(row.result_digest !== null ? { resultDigest: row.result_digest } : {}),
    resultAvailability: parseResultAvailability(row.result_availability),
    resultSizeBytes: row.result_size_bytes,
    ...(row.last_error !== null ? { lastError: row.last_error } : {}),
    ...(row.review_status !== null ? { reviewStatus: row.review_status } : {}),
    ...(row.review_reason !== null ? { reviewReason: row.review_reason } : {}),
    ...(row.review_disposition !== null
      ? { reviewDisposition: row.review_disposition }
      : {}),
    ...(row.review_domain_action !== null
      ? { reviewDomainAction: row.review_domain_action }
      : {}),
    ...(reviewEvidence !== undefined ? { reviewEvidence } : {}),
    ...(effect !== undefined ? { effect } : {}),
    executionSemantics: row.execution_semantics,
    ...(row.idempotency_profile !== null
      ? { idempotencyProfile: row.idempotency_profile }
      : {}),
    ...(row.idempotency_profile_version !== null
      ? { idempotencyProfileVersion: row.idempotency_profile_version }
      : {}),
    ...(row.operation_key !== null ? { operationKey: row.operation_key } : {}),
    ...(row.provider_acknowledged_key !== null
      ? { providerAcknowledgedKey: row.provider_acknowledged_key }
      : {}),
    ...(lookupEvidence !== undefined ? { lookupEvidence } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.completed_at !== null ? { completedAt: row.completed_at } : {}),
    ...(row.reported_at !== null ? { reportedAt: row.reported_at } : {}),
  };
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1_000);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const CSV_ITEM_CURSOR_PREFIX = "agenc-csv-items-v1:";
const CSV_ITEM_CURSOR_DOMAIN = "agenc.csv.item-cursor.v1\0";
const CSV_ITEM_CURSOR_MAX_BYTES = 2_048;

interface DecodedCsvItemCursor {
  readonly rowIndex: number;
  readonly itemId: string;
}

function csvItemCursorScope(
  jobId: string,
  status: CsvAgentJobItemStatus | undefined,
): string {
  return sha256(
    JSON.stringify({
      jobId,
      status: status ?? null,
    }),
  );
}

export function encodeCsvJobItemCursor(opts: {
  readonly jobId: string;
  readonly status?: CsvAgentJobItemStatus;
  readonly rowIndex: number;
  readonly itemId: string;
}): CsvJobItemCursor {
  if (
    !Number.isSafeInteger(opts.rowIndex) ||
    opts.rowIndex < 0 ||
    opts.itemId.length === 0
  ) {
    throw new Error("invalid CSV item page boundary");
  }
  const encoded = Buffer.from(
    JSON.stringify({
      v: 1,
      scope: csvItemCursorScope(opts.jobId, opts.status),
      rowIndex: opts.rowIndex,
      itemId: opts.itemId,
    }),
    "utf8",
  ).toString("base64url");
  const digest = sha256(`${CSV_ITEM_CURSOR_DOMAIN}${encoded}`);
  return `${CSV_ITEM_CURSOR_PREFIX}${encoded}.${digest}`;
}

function decodeCsvJobItemCursor(
  cursor: CsvJobItemCursor,
  jobId: string,
  status: CsvAgentJobItemStatus | undefined,
): DecodedCsvItemCursor {
  try {
    if (
      Buffer.byteLength(cursor, "utf8") > CSV_ITEM_CURSOR_MAX_BYTES ||
      !cursor.startsWith(CSV_ITEM_CURSOR_PREFIX)
    ) {
      throw new Error("invalid cursor envelope");
    }
    const body = cursor.slice(CSV_ITEM_CURSOR_PREFIX.length);
    const separator = body.lastIndexOf(".");
    if (separator <= 0 || separator === body.length - 1) {
      throw new Error("invalid cursor envelope");
    }
    const encoded = body.slice(0, separator);
    const digest = body.slice(separator + 1);
    if (
      !/^[A-Za-z0-9_-]+$/.test(encoded) ||
      !/^[a-f0-9]{64}$/.test(digest) ||
      digest !== sha256(`${CSV_ITEM_CURSOR_DOMAIN}${encoded}`)
    ) {
      throw new Error("invalid cursor integrity");
    }
    const decoded = Buffer.from(encoded, "base64url");
    if (decoded.toString("base64url") !== encoded) {
      throw new Error("non-canonical cursor encoding");
    }
    const parsed = JSON.parse(decoded.toString("utf8")) as {
      readonly v?: unknown;
      readonly scope?: unknown;
      readonly rowIndex?: unknown;
      readonly itemId?: unknown;
    };
    if (
      parsed.v !== 1 ||
      parsed.scope !== csvItemCursorScope(jobId, status) ||
      !Number.isSafeInteger(parsed.rowIndex) ||
      (parsed.rowIndex as number) < 0 ||
      typeof parsed.itemId !== "string" ||
      parsed.itemId.length === 0
    ) {
      throw new Error("invalid cursor scope or keyset");
    }
    return {
      rowIndex: parsed.rowIndex as number,
      itemId: parsed.itemId,
    };
  } catch {
    throw new Error("invalid or stale CSV item page cursor");
  }
}

function requireNonempty(value: string, label: string): void {
  if (value.length === 0) throw new Error(`${label} must be non-empty`);
}

function normalizePageLimit(limit: number | undefined): number {
  if (limit === undefined) return CSV_DEFAULT_ITEM_PAGE_SIZE;
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error("CSV item page limit must be a positive integer");
  }
  return Math.min(limit, CSV_MAX_ITEM_PAGE_SIZE);
}

interface Utf8Projection {
  readonly value: string;
  readonly truncated: boolean;
  readonly digest?: string;
}

function truncateUtf8(value: string, maxBytes: number): Utf8Projection {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength <= maxBytes) {
    return { value, truncated: false };
  }
  let end = maxBytes;
  while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end -= 1;
  return {
    value: encoded.subarray(0, end).toString("utf8"),
    truncated: true,
    digest: createHash("sha256").update(encoded).digest("hex"),
  };
}

const CSV_ITEM_TEXT_PROJECTION_BYTES = 1_024;

interface BoundedTextProjection {
  readonly value: string;
  readonly bytes: number;
  readonly truncated: boolean;
}

function assertProjectionBytes(
  value: number | null,
  label: string,
): number | undefined {
  if (value === null) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} has an invalid stored byte length`);
  }
  return value;
}

function decodeCompleteUtf8(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} contains invalid UTF-8`);
  }
}

function decodeTruncatedUtf8(
  bytes: Uint8Array,
  maxBytes: number,
  label: string,
): string {
  let end = Math.min(bytes.byteLength, maxBytes);
  while (end > 0) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(0, end),
      );
    } catch {
      end -= 1;
    }
  }
  if (bytes.byteLength > 0) {
    throw new Error(`${label} has no valid UTF-8 projection prefix`);
  }
  return "";
}

function projectBoundedText(
  prefix: Uint8Array | null,
  storedBytes: number | null,
  maxBytes: number,
  label: string,
): BoundedTextProjection | undefined {
  const bytes = assertProjectionBytes(storedBytes, label);
  if (prefix === null || bytes === undefined) {
    if (prefix !== null || bytes !== undefined) {
      throw new Error(`${label} projection metadata is inconsistent`);
    }
    return undefined;
  }
  const expectedPrefixBytes = Math.min(bytes, maxBytes + 1);
  if (prefix.byteLength !== expectedPrefixBytes) {
    throw new Error(`${label} projection prefix has an invalid byte length`);
  }
  const truncated = bytes > maxBytes;
  return {
    value: truncated
      ? decodeTruncatedUtf8(prefix, maxBytes, label)
      : decodeCompleteUtf8(prefix, label),
    bytes,
    truncated,
  };
}

function projectIdentifier(
  prefix: Uint8Array | null,
  storedBytes: number | null,
  label: string,
  required: boolean,
): string | undefined {
  const projected = projectBoundedText(
    prefix,
    storedBytes,
    CSV_REVIEW_IDENTIFIER_PROJECTION_BYTES,
    label,
  );
  if (projected === undefined) {
    if (required) throw new Error(`${label} is missing`);
    return undefined;
  }
  if (projected.truncated) {
    throw new Error(
      `${label} exceeds ${CSV_REVIEW_IDENTIFIER_PROJECTION_BYTES} UTF-8 bytes`,
    );
  }
  if (projected.value.trim().length === 0) {
    throw new Error(`${label} must be non-empty`);
  }
  return projected.value;
}

function projectBoundedJson(
  storedJson: Uint8Array | null,
  storedBytes: number | null,
  label: string,
): CsvReviewJsonProjection | undefined {
  const bytes = assertProjectionBytes(storedBytes, label);
  if (bytes !== undefined && bytes > CSV_MAX_RESULT_BYTES) {
    throw new Error(
      `${label} exceeds the ${CSV_MAX_RESULT_BYTES} byte storage bound`,
    );
  }
  if (storedJson === null || bytes === undefined) {
    if (storedJson !== null || bytes !== undefined) {
      throw new Error(`${label} projection metadata is inconsistent`);
    }
    return undefined;
  }
  if (storedJson.byteLength !== bytes) {
    throw new Error(`${label} projection has an invalid byte length`);
  }
  const sha256 = createHash("sha256").update(storedJson).digest("hex");
  if (bytes > CSV_REVIEW_EVIDENCE_PROJECTION_BYTES) {
    return { bytes, sha256, truncated: true };
  }
  const json = decodeCompleteUtf8(storedJson, label);
  const value = JSON.parse(json) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must contain a JSON object`);
  }
  return {
    bytes,
    sha256,
    truncated: false,
    value: value as Readonly<Record<string, unknown>>,
  };
}

function projectReviewRow(
  row: ReviewProjectionRow,
  digestSourceId: (jobId: string, itemId: string, bytes: number) => string,
): CsvAgentJobReviewProjection {
  const jobId = projectIdentifier(
    row.job_id_prefix,
    row.job_id_bytes,
    "CSV review job id",
    true,
  )!;
  const itemId = projectIdentifier(
    row.item_id_prefix,
    row.item_id_bytes,
    "CSV review item id",
    true,
  )!;
  const source = projectBoundedText(
    row.source_id_prefix,
    row.source_id_bytes,
    CSV_REVIEW_SOURCE_ID_PROJECTION_BYTES,
    "CSV review source id",
  );
  const reason = projectBoundedText(
    row.review_reason_prefix,
    row.review_reason_bytes,
    CSV_REVIEW_REASON_PROJECTION_BYTES,
    "CSV review reason",
  );
  const reviewEvidence = projectBoundedJson(
    row.review_evidence_json,
    row.review_evidence_bytes,
    "CSV review evidence",
  );
  const lookupEvidence = projectBoundedJson(
    row.lookup_evidence_json,
    row.lookup_evidence_bytes,
    "CSV review lookup evidence",
  );
  if (source !== undefined && source.bytes > CSV_MAX_FIELD_BYTES) {
    throw new Error(
      `CSV review source id exceeds the ${CSV_MAX_FIELD_BYTES} byte storage bound`,
    );
  }
  const sourceIdDigest =
    source?.truncated === true
      ? digestSourceId(jobId, itemId, source.bytes)
      : undefined;
  if (sourceIdDigest !== undefined) {
    assertSha256(sourceIdDigest, "CSV review source id digest");
  }
  const effectRunId = projectIdentifier(
    row.effect_run_id_prefix,
    row.effect_run_id_bytes,
    "CSV review effect run id",
    false,
  );
  const effectStepId = projectIdentifier(
    row.effect_step_id_prefix,
    row.effect_step_id_bytes,
    "CSV review effect step id",
    false,
  );
  const effectPresent =
    effectRunId !== undefined ||
    effectStepId !== undefined ||
    row.effect_epoch !== null;
  if (
    effectPresent &&
    (effectRunId === undefined ||
      effectStepId === undefined ||
      row.effect_epoch === null ||
      !Number.isSafeInteger(row.effect_epoch) ||
      row.effect_epoch <= 0)
  ) {
    throw new Error("CSV review effect identity is incomplete");
  }
  const effect =
    effectRunId !== undefined &&
    effectStepId !== undefined &&
    row.effect_epoch !== null
      ? {
          runId: effectRunId,
          stepId: effectStepId,
          epoch: row.effect_epoch,
        }
      : undefined;
  return {
    jobId,
    itemId,
    rowIndex: row.row_index,
    ...(source !== undefined
      ? {
          sourceId: source.value,
          sourceIdBytes: source.bytes,
          ...(source.truncated
            ? { sourceIdTruncated: true, sourceIdDigest }
            : {}),
        }
      : {}),
    status: parseItemStatus(row.status),
    attemptCount: row.attempt_count,
    resultAvailability: parseResultAvailability(row.result_availability),
    resultSizeBytes: row.result_size_bytes,
    ...(row.result_digest !== null ? { resultDigest: row.result_digest } : {}),
    ...(row.review_status !== null ? { reviewStatus: row.review_status } : {}),
    ...(reason !== undefined
      ? {
          reviewReason: reason.value,
          reviewReasonBytes: reason.bytes,
          ...(reason.truncated ? { reviewReasonTruncated: true } : {}),
        }
      : {}),
    ...(row.review_disposition !== null
      ? { reviewDisposition: row.review_disposition }
      : {}),
    ...(row.review_domain_action !== null
      ? { reviewDomainAction: row.review_domain_action }
      : {}),
    ...(reviewEvidence !== undefined ? { reviewEvidence } : {}),
    ...(effect !== undefined ? { effect } : {}),
    ...(lookupEvidence !== undefined ? { lookupEvidence } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.completed_at !== null ? { completedAt: row.completed_at } : {}),
  };
}

function projectReviewListRow(
  row: ReviewListProjectionRow,
  digestSourceId: (jobId: string, itemId: string, bytes: number) => string,
): CsvAgentJobReviewProjection {
  return projectReviewRow(
    {
      ...row,
      review_evidence_json: null,
      review_evidence_bytes: null,
      lookup_evidence_json: null,
      lookup_evidence_bytes: null,
    },
    digestSourceId,
  );
}

const CSV_REVIEW_BASE_PROJECTION_COLUMNS = `
  substr(CAST(item.job_id AS BLOB), 1,
         ${CSV_REVIEW_IDENTIFIER_PROJECTION_BYTES + 1}) AS job_id_prefix,
  length(CAST(item.job_id AS BLOB)) AS job_id_bytes,
  substr(CAST(item.item_id AS BLOB), 1,
         ${CSV_REVIEW_IDENTIFIER_PROJECTION_BYTES + 1}) AS item_id_prefix,
  length(CAST(item.item_id AS BLOB)) AS item_id_bytes,
  item.row_index,
  CASE WHEN item.source_id IS NULL THEN NULL
       ELSE substr(CAST(item.source_id AS BLOB), 1,
                   ${CSV_REVIEW_SOURCE_ID_PROJECTION_BYTES + 1})
  END AS source_id_prefix,
  length(CAST(item.source_id AS BLOB)) AS source_id_bytes,
  item.status, item.attempt_count, item.result_availability,
  item.result_size_bytes, item.result_digest, item.review_status,
  CASE WHEN item.review_reason IS NULL THEN NULL
       ELSE substr(CAST(item.review_reason AS BLOB), 1,
                   ${CSV_REVIEW_REASON_PROJECTION_BYTES + 1})
  END AS review_reason_prefix,
  length(CAST(item.review_reason AS BLOB)) AS review_reason_bytes,
  item.review_disposition, item.review_domain_action,
  CASE WHEN item.effect_run_id IS NULL THEN NULL
       ELSE substr(CAST(item.effect_run_id AS BLOB), 1,
                   ${CSV_REVIEW_IDENTIFIER_PROJECTION_BYTES + 1})
  END AS effect_run_id_prefix,
  length(CAST(item.effect_run_id AS BLOB)) AS effect_run_id_bytes,
  CASE WHEN item.effect_step_id IS NULL THEN NULL
       ELSE substr(CAST(item.effect_step_id AS BLOB), 1,
                   ${CSV_REVIEW_IDENTIFIER_PROJECTION_BYTES + 1})
  END AS effect_step_id_prefix,
  length(CAST(item.effect_step_id AS BLOB)) AS effect_step_id_bytes,
  item.effect_epoch,
  item.created_at, item.updated_at, item.completed_at`;

const CSV_REVIEW_DETAIL_EVIDENCE_COLUMNS = `
  CASE WHEN item.review_evidence_json IS NULL THEN NULL
       WHEN length(CAST(item.review_evidence_json AS BLOB)) <=
            ${CSV_MAX_RESULT_BYTES}
       THEN CAST(item.review_evidence_json AS BLOB)
       ELSE NULL
  END AS review_evidence_json,
  length(CAST(item.review_evidence_json AS BLOB)) AS review_evidence_bytes,
  CASE WHEN item.lookup_evidence_json IS NULL THEN NULL
       WHEN length(CAST(item.lookup_evidence_json AS BLOB)) <=
            ${CSV_MAX_RESULT_BYTES}
       THEN CAST(item.lookup_evidence_json AS BLOB)
       ELSE NULL
  END AS lookup_evidence_json,
  length(CAST(item.lookup_evidence_json AS BLOB)) AS lookup_evidence_bytes`;

function projectItemSummary(
  row: Pick<
    ItemRow,
    | "item_id"
    | "row_index"
    | "source_id"
    | "status"
    | "attempt_count"
    | "result_availability"
    | "result_size_bytes"
    | "result_digest"
    | "result_json"
    | "last_error"
    | "review_status"
    | "review_reason"
  >,
): CsvAgentJobItemSummary {
  const source =
    row.source_id === null
      ? undefined
      : truncateUtf8(row.source_id, CSV_ITEM_TEXT_PROJECTION_BYTES);
  const preview =
    row.result_json === null
      ? undefined
      : truncateUtf8(row.result_json, CSV_MAX_RESULT_PREVIEW_BYTES);
  const error =
    row.last_error === null
      ? undefined
      : truncateUtf8(row.last_error, CSV_ITEM_TEXT_PROJECTION_BYTES);
  const reviewReason =
    row.review_reason === null
      ? undefined
      : truncateUtf8(row.review_reason, CSV_ITEM_TEXT_PROJECTION_BYTES);
  const projected: CsvAgentJobItemSummary = {
    itemId: row.item_id,
    rowIndex: row.row_index,
    ...(source !== undefined
      ? {
          sourceId: source.value,
          ...(source.truncated
            ? {
                sourceIdTruncated: true,
                sourceIdDigest: source.digest,
              }
            : {}),
        }
      : {}),
    status: parseItemStatus(row.status),
    attemptCount: row.attempt_count,
    resultAvailability: parseResultAvailability(row.result_availability),
    resultSizeBytes: row.result_size_bytes,
    ...(row.result_digest !== null ? { resultDigest: row.result_digest } : {}),
    ...(preview !== undefined
      ? {
          resultPreviewJson: preview.value,
          ...(preview.truncated ? { resultPreviewTruncated: true } : {}),
        }
      : {}),
    ...(error !== undefined
      ? {
          lastError: error.value,
          ...(error.truncated ? { lastErrorTruncated: true } : {}),
        }
      : {}),
    ...(row.review_status !== null ? { reviewStatus: row.review_status } : {}),
    ...(reviewReason !== undefined
      ? {
          reviewReason: reviewReason.value,
          ...(reviewReason.truncated ? { reviewReasonTruncated: true } : {}),
        }
      : {}),
  };
  const encodedBytes = Buffer.byteLength(JSON.stringify(projected), "utf8");
  if (encodedBytes > CSV_MAX_ITEM_PROJECTION_BYTES) {
    throw new Error(
      `CSV item projection is ${encodedBytes} bytes; limit is ${CSV_MAX_ITEM_PROJECTION_BYTES}`,
    );
  }
  return projected;
}

function assertSha256(value: string, label: string): void {
  if (!/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
}

function validateCreateParams(
  params: CsvAgentJobCreateParams,
  items: ReadonlyArray<CsvAgentJobItemCreateParams>,
): void {
  requireNonempty(params.id, "CSV job id");
  requireNonempty(params.name, "CSV job name");
  requireNonempty(params.instruction, "CSV job instruction");
  if (
    params.inputHeaders.length === 0 ||
    params.inputHeaders.length > CSV_MAX_COLUMNS
  ) {
    throw new Error(
      `CSV inputHeaders must contain between 1 and ${CSV_MAX_COLUMNS} headers`,
    );
  }
  if (
    Buffer.byteLength(params.inputHeaders.join(","), "utf8") >
    CSV_MAX_HEADER_BYTES
  ) {
    throw new Error(`CSV inputHeaders exceed ${CSV_MAX_HEADER_BYTES} bytes`);
  }
  const headerSet = new Set<string>();
  for (const header of params.inputHeaders) {
    if (header.trim().length === 0) {
      throw new Error("CSV inputHeaders contain a blank header");
    }
    if (headerSet.has(header)) {
      throw new Error(`duplicate CSV input header: ${header}`);
    }
    headerSet.add(header);
    if (
      CSV_RESERVED_OUTPUT_HEADERS.has(header) &&
      !(header === "source_id" && params.idColumn === "source_id")
    ) {
      throw new Error(`CSV input header is reserved for output: ${header}`);
    }
  }
  if (params.idColumn !== undefined && !headerSet.has(params.idColumn)) {
    throw new Error(
      `CSV idColumn is not present in inputHeaders: ${params.idColumn}`,
    );
  }
  const requestedMaxConcurrency =
    params.requestedMaxConcurrency ?? CSV_DEFAULT_MAX_CONCURRENCY;
  if (
    !Number.isSafeInteger(requestedMaxConcurrency) ||
    requestedMaxConcurrency < 1 ||
    requestedMaxConcurrency > CSV_MAX_JOB_CONCURRENCY
  ) {
    throw new Error(
      `CSV requestedMaxConcurrency must be between 1 and ${CSV_MAX_JOB_CONCURRENCY}`,
    );
  }
  const maxItems = params.maxItems ?? CSV_MAX_ROWS;
  if (
    !Number.isSafeInteger(maxItems) ||
    maxItems <= 0 ||
    maxItems > CSV_MAX_ROWS
  ) {
    throw new Error(`CSV maxItems must be between 1 and ${CSV_MAX_ROWS}`);
  }
  if (items.length > maxItems) {
    throw new Error(`CSV job has ${items.length} rows; limit is ${maxItems}`);
  }
  const seenItems = new Set<string>();
  const seenRows = new Set<number>();
  const seenSourceIds = new Map<string, number>();
  for (const item of items) {
    requireNonempty(item.itemId, "CSV item id");
    requireNonempty(item.workerName, "CSV worker name");
    assertSha256(item.contentSha256, "CSV item contentSha256");
    const descriptors = Object.getOwnPropertyDescriptors(item.row);
    for (const symbol of Object.getOwnPropertySymbols(item.row)) {
      if (Object.getOwnPropertyDescriptor(item.row, symbol)?.enumerable) {
        throw new Error("CSV row contains an enumerable symbol field");
      }
    }
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!descriptor.enumerable) continue;
      if (!("value" in descriptor)) {
        throw new Error(`CSV row contains an accessor field: ${key}`);
      }
      if (!headerSet.has(key)) {
        throw new Error(`CSV row contains an unknown field: ${key}`);
      }
      if (typeof descriptor.value !== "string") {
        throw new Error(`CSV row field ${key} must be a string`);
      }
    }
    if (!/^[a-z0-9_]{1,96}$/u.test(item.workerName)) {
      throw new Error(`unsafe CSV worker name: ${item.workerName}`);
    }
    if (seenItems.has(item.itemId)) {
      throw new Error(`duplicate CSV item id: ${item.itemId}`);
    }
    seenItems.add(item.itemId);
    if (seenRows.has(item.rowIndex)) {
      throw new Error(`duplicate CSV row index: ${item.rowIndex}`);
    }
    seenRows.add(item.rowIndex);
    if (params.idColumn !== undefined) {
      if (item.sourceId === undefined || item.sourceId.trim().length === 0) {
        throw new Error(`blank source_id at CSV data row ${item.rowIndex + 1}`);
      }
      const first = seenSourceIds.get(item.sourceId);
      if (first !== undefined) {
        throw new Error(
          `duplicate source_id at CSV data rows ${first + 1} and ${item.rowIndex + 1}`,
        );
      }
      seenSourceIds.set(item.sourceId, item.rowIndex);
    } else if (item.sourceId !== undefined) {
      throw new Error(
        "source_id must be absent when idColumn is not configured",
      );
    }
  }
}

interface CsvStorageQuotaRow {
  readonly active_imports: number;
  readonly staging_rows: number;
  readonly staging_bytes: number;
  readonly durable_jobs: number;
  readonly durable_items: number;
  readonly durable_bytes: number;
  readonly durable_reserved_items: number;
  readonly durable_reserved_bytes: number;
  readonly result_blob_bytes: number;
  readonly result_reserved_bytes: number;
  readonly tombstones: number;
  readonly tombstone_bytes: number;
  readonly output_staging_files: number;
  readonly output_staging_bytes: number;
}

interface StagedImportRecoveryRow {
  readonly id: string;
  readonly import_id: string;
  readonly import_lease_owner: string;
  readonly import_lease_generation: string;
  readonly import_owner_pid: number;
  readonly import_owner_boot_id: string | null;
  readonly import_owner_process_start: string | null;
  readonly import_lease_expires_at: number;
  readonly total_items: number;
  readonly staging_bytes: number;
  readonly created_at: number;
  readonly recovery_rank: number;
}

interface CsvImportRecoveryClaim {
  readonly leaseOwner: string;
  readonly leaseGeneration: string;
}

interface CsvOutputIntentRecoveryRow {
  readonly intent_id: string;
  readonly target_path: string;
  readonly temporary_path: string;
  readonly temporary_dev: string;
  readonly temporary_ino: string;
  readonly state:
    "writing" | "flushed" | "published" | "abandoned" | "recovering";
  readonly recovery_prior_state:
    "writing" | "flushed" | "published" | "abandoned" | null;
  readonly owner_generation: string;
  readonly owner_pid: number;
  readonly owner_boot_id: string | null;
  readonly owner_process_start: string | null;
  readonly created_at: number;
  readonly recovery_rank: number;
}

export class CsvStorageQuotaError extends Error {
  readonly code = "CSV_STORAGE_QUOTA_EXCEEDED" as const;
  readonly category = "retryable_capacity" as const;

  constructor(
    readonly quota: string,
    readonly limit: number,
  ) {
    super(`CSV ${quota} quota is full (limit ${limit})`);
    this.name = "CsvStorageQuotaError";
  }
}

const LIVE_CSV_IMPORT_GENERATIONS = new Set<string>();
const LIVE_CSV_OUTPUT_GENERATIONS = new Set<string>();
const CSV_ROW_STORAGE_OVERHEAD_BYTES = 256;

export interface CsvProcessIdentity {
  readonly pid: number;
  readonly bootId?: string;
  readonly processStart?: string;
}

export type CsvProcessObservation =
  | { readonly kind: "alive"; readonly processStart?: string }
  | { readonly kind: "dead" }
  | { readonly kind: "unknown" };

export interface CsvProcessIdentityProbe {
  readonly current: CsvProcessIdentity;
  inspect(
    pid: number,
    signal?: AbortSignal,
  ): CsvProcessObservation | Promise<CsvProcessObservation>;
}

const CSV_PROCESS_START_QUERY_TIMEOUT_MS = 2_000;
const CSV_PROCESS_START_QUERY_MAX_BUFFER_BYTES = 64 * 1_024;
export const CSV_RECOVERY_MAX_PROCESS_PROBES_PER_PASS = 8;
export const CSV_RECOVERY_PROCESS_PROBE_BUDGET_MS = 2_500;
export const CSV_RECOVERY_CANDIDATE_PAGE_SIZE = 16;
const MACOS_PROCESS_QUERY_EXECUTABLE = "/bin/ps";
const WINDOWS_PROCESS_QUERY_EXECUTABLE = "powershell.exe";
const MACOS_PROCESS_START_PREFIX = "darwin-lstart-seconds:";
const WINDOWS_PROCESS_START_PREFIX = "win32-creation-time:";

type CsvProcessStartInspector = (
  platform: NodeJS.Platform,
  pid: number,
  signal?: AbortSignal,
) => string | null | undefined | Promise<string | null | undefined>;

export interface CsvProcessIdentityProbeOptions {
  readonly platform?: NodeJS.Platform;
  readonly pid?: number;
  readonly readTextFile?: (path: string) => string;
  readonly signalProcess?: (pid: number) => void;
  readonly signal?: AbortSignal;
  /**
   * Returns a stable OS process-start token, null when the PID disappeared,
   * or undefined when the platform query cannot establish identity.
   */
  readonly inspectProcessStart?: CsvProcessStartInspector;
}

function signalObservation(
  pid: number,
  signalProcess: (pid: number) => void,
): CsvProcessObservation {
  try {
    signalProcess(pid);
    return { kind: "alive" };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return { kind: "dead" };
    if (code === "EPERM" || code === "EACCES") return { kind: "alive" };
    return { kind: "unknown" };
  }
}

function linuxProcessObservation(
  pid: number,
  readTextFile: (path: string) => string,
  signalProcess: (pid: number) => void,
): CsvProcessObservation {
  try {
    const stat = readTextFile(`/proc/${pid}/stat`);
    const commandEnd = stat.lastIndexOf(")");
    if (commandEnd < 0) return { kind: "unknown" };
    const fieldsFromState = stat
      .slice(commandEnd + 2)
      .trim()
      .split(/\s+/u);
    const processStart = fieldsFromState[19];
    return processStart === undefined
      ? { kind: "unknown" }
      : { kind: "alive", processStart };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "dead" };
    }
    return signalObservation(pid, signalProcess);
  }
}

async function execProcessIdentityQuery(
  executable: string,
  args: readonly string[],
  options: {
    readonly signal?: AbortSignal;
    readonly windowsHide?: boolean;
  },
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    execFile(
      executable,
      [...args],
      {
        encoding: "utf8",
        timeout: CSV_PROCESS_START_QUERY_TIMEOUT_MS,
        maxBuffer: CSV_PROCESS_START_QUERY_MAX_BUFFER_BYTES,
        windowsHide: options.windowsHide,
        signal: options.signal,
      },
      (error, stdout) => {
        if (error !== null) {
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

async function defaultProcessStartInspector(
  platform: NodeJS.Platform,
  pid: number,
  signal?: AbortSignal,
): Promise<string | null | undefined> {
  const pidText = String(pid);
  try {
    if (platform === "darwin") {
      const output = (
        await execProcessIdentityQuery(
          MACOS_PROCESS_QUERY_EXECUTABLE,
          ["-o", "lstart=", "-p", pidText],
          { signal },
        )
      ).trim();
      return output.length > 0 ? output : null;
    }
    if (platform === "win32") {
      const script = [
        `$process = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pidText}' -ErrorAction Stop`,
        "if ($null -eq $process) { exit 3 }",
        "[Console]::Out.Write($process.CreationDate.ToUniversalTime().ToString('O'))",
      ].join("; ");
      const output = (
        await execProcessIdentityQuery(
          WINDOWS_PROCESS_QUERY_EXECUTABLE,
          ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
          { signal, windowsHide: true },
        )
      ).trim();
      return output.length > 0 ? output : null;
    }
  } catch {
    if (signal?.aborted === true) throw signal.reason;
    return undefined;
  }
  return undefined;
}

async function portableProcessObservation(
  platform: NodeJS.Platform,
  pid: number,
  signalProcess: (pid: number) => void,
  inspectProcessStart: CsvProcessStartInspector,
  signal?: AbortSignal,
): Promise<CsvProcessObservation> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { kind: "unknown" };
  const liveness = signalObservation(pid, signalProcess);
  if (liveness.kind !== "alive") return liveness;
  signal?.throwIfAborted();
  const processStart = await inspectProcessStart(platform, pid, signal);
  if (typeof processStart === "string" && processStart.length > 0) {
    return {
      kind: "alive",
      processStart:
        platform === "darwin"
          ? `${MACOS_PROCESS_START_PREFIX}${processStart}`
          : platform === "win32"
            ? `${WINDOWS_PROCESS_START_PREFIX}${processStart}`
            : processStart,
    };
  }
  if (processStart === null) {
    const secondObservation = signalObservation(pid, signalProcess);
    return secondObservation.kind === "dead"
      ? secondObservation
      : { kind: "unknown" };
  }
  return { kind: "unknown" };
}

export async function createCsvProcessIdentityProbe(
  options: CsvProcessIdentityProbeOptions = {},
): Promise<CsvProcessIdentityProbe> {
  const platform = options.platform ?? process.platform;
  const pid = options.pid ?? process.pid;
  const readTextFile =
    options.readTextFile ?? ((path: string) => readFileSync(path, "utf8"));
  const signalProcess =
    options.signalProcess ??
    ((targetPid: number) => process.kill(targetPid, 0));
  const inspectProcessStart =
    options.inspectProcessStart ?? defaultProcessStartInspector;
  let bootId: string | undefined;
  if (platform === "linux") {
    try {
      bootId = readTextFile("/proc/sys/kernel/random/boot_id").trim();
    } catch {
      bootId = undefined;
    }
  }
  const currentObservation =
    platform === "linux"
      ? linuxProcessObservation(pid, readTextFile, signalProcess)
      : await portableProcessObservation(
          platform,
          pid,
          signalProcess,
          inspectProcessStart,
          options.signal,
        );
  const current: CsvProcessIdentity = {
    pid,
    ...(bootId !== undefined && bootId.length > 0 ? { bootId } : {}),
    ...(currentObservation.kind === "alive" &&
    currentObservation.processStart !== undefined
      ? { processStart: currentObservation.processStart }
      : {}),
  };
  return {
    current,
    inspect(targetPid, signal) {
      return platform === "linux"
        ? linuxProcessObservation(targetPid, readTextFile, signalProcess)
        : portableProcessObservation(
            platform,
            targetPid,
            signalProcess,
            inspectProcessStart,
            signal,
          );
    },
  };
}

export interface CsvAgentJobsRepositoryOptions {
  readonly processIdentityProbe?: CsvProcessIdentityProbe;
  /** Pause-only seam after real canonical validation; cannot replace a token. */
  readonly pauseAfterResultValidation?: () => Promise<void>;
}

export interface CsvAgentJobsRepositoryOpenOptions extends CsvAgentJobsRepositoryOptions {
  readonly signal?: AbortSignal;
}

export const CSV_RECOVERY_DEFERRED_OWNER_ALIVE =
  "CSV_RECOVERY_DEFERRED_OWNER_ALIVE" as const;
export const CSV_RECOVERY_DEFERRED_PROCESS_IDENTITY_UNPROVEN =
  "CSV_RECOVERY_DEFERRED_PROCESS_IDENTITY_UNPROVEN" as const;
export const CSV_RECOVERY_DEFERRED_PROCESS_PROBE_UNAVAILABLE =
  "CSV_RECOVERY_DEFERRED_PROCESS_PROBE_UNAVAILABLE" as const;
export const CSV_RECOVERY_DEFERRED_PROCESS_IDENTITY_COARSE =
  "CSV_RECOVERY_DEFERRED_PROCESS_IDENTITY_COARSE" as const;

type CsvRecoveryDeferralCode =
  | typeof CSV_RECOVERY_DEFERRED_OWNER_ALIVE
  | typeof CSV_RECOVERY_DEFERRED_PROCESS_IDENTITY_UNPROVEN
  | typeof CSV_RECOVERY_DEFERRED_PROCESS_PROBE_UNAVAILABLE
  | typeof CSV_RECOVERY_DEFERRED_PROCESS_IDENTITY_COARSE;

type CsvOwnerDeathProof =
  | { readonly kind: "proven_dead" }
  | { readonly kind: "deferred"; readonly code: CsvRecoveryDeferralCode };

interface CsvRecoveryProbeBudget {
  readonly startedAt: number;
  probes: number;
}

function createRecoveryProbeBudget(): CsvRecoveryProbeBudget {
  return { startedAt: Date.now(), probes: 0 };
}

function reserveRecoveryProcessProbe(budget: CsvRecoveryProbeBudget): boolean {
  if (budget.probes >= CSV_RECOVERY_MAX_PROCESS_PROBES_PER_PASS) return false;
  const elapsed = Date.now() - budget.startedAt;
  // A fresh synchronous OS query may consume its entire per-query timeout.
  // Do not start one unless the aggregate pass still has that much headroom.
  if (
    elapsed + CSV_PROCESS_START_QUERY_TIMEOUT_MS >
    CSV_RECOVERY_PROCESS_PROBE_BUDGET_MS
  ) {
    return false;
  }
  budget.probes += 1;
  return true;
}

function processStartTokensMatch(recorded: string, observed: string): boolean {
  if (recorded === observed) return true;
  if (observed.startsWith(MACOS_PROCESS_START_PREFIX)) {
    return recorded === observed.slice(MACOS_PROCESS_START_PREFIX.length);
  }
  if (recorded.startsWith(MACOS_PROCESS_START_PREFIX)) {
    return observed === recorded.slice(MACOS_PROCESS_START_PREFIX.length);
  }
  if (observed.startsWith(WINDOWS_PROCESS_START_PREFIX)) {
    return recorded === observed.slice(WINDOWS_PROCESS_START_PREFIX.length);
  }
  if (recorded.startsWith(WINDOWS_PROCESS_START_PREFIX)) {
    return observed === recorded.slice(WINDOWS_PROCESS_START_PREFIX.length);
  }
  return false;
}

function isCoarseProcessStartToken(token: string): boolean {
  return token.startsWith(MACOS_PROCESS_START_PREFIX);
}

async function yieldRecoverySlice(signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearImmediate(handle);
      reject(signal?.reason ?? new Error("CSV recovery aborted"));
    };
    const handle = setImmediate(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    });
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function serializeCsvRow(
  row: Readonly<Record<string, unknown>>,
  headers: ReadonlyArray<string>,
): string {
  const descriptors = Object.getOwnPropertyDescriptors(row);
  const inert = Object.create(null) as Record<string, string>;
  for (const header of headers) {
    const descriptor = descriptors[header];
    Object.defineProperty(inert, header, {
      configurable: false,
      enumerable: true,
      writable: false,
      value:
        descriptor !== undefined && "value" in descriptor
          ? (descriptor.value as string)
          : "",
    });
  }
  return JSON.stringify(inert);
}

function stagedRowBytes(
  item: CsvAgentJobItemCreateParams,
  rowJson: string,
): number {
  return (
    Buffer.byteLength(rowJson, "utf8") +
    Buffer.byteLength(item.itemId, "utf8") +
    Buffer.byteLength(item.workerName, "utf8") +
    Buffer.byteLength(item.sourceId ?? "", "utf8") +
    Buffer.byteLength(item.contentSha256, "utf8") +
    CSV_ROW_STORAGE_OVERHEAD_BYTES
  );
}

function assertQuota(
  current: number,
  requested: number,
  limit: number,
  label: string,
): void {
  if (current + requested > limit) {
    throw new CsvStorageQuotaError(label, limit);
  }
}

export class CsvAgentJobsRepository {
  private readonly processIdentityProbe: CsvProcessIdentityProbe;
  private readonly ownerIdentity: CsvProcessIdentity;
  private readonly pauseAfterResultValidation:
    CsvAgentJobsRepositoryOptions["pauseAfterResultValidation"] | undefined;
  private importRecoveryCursor:
    | {
        readonly recoveryRank: number;
        readonly createdAt: number;
        readonly importId: string;
      }
    | undefined;
  private readonly outputRecoveryCursors = new Map<
    string,
    {
      readonly recoveryRank: number;
      readonly createdAt: number;
      readonly intentId: string;
    }
  >();

  constructor(
    private readonly driver: StateSqliteDriver,
    options: CsvAgentJobsRepositoryOptions = {},
  ) {
    this.processIdentityProbe = options.processIdentityProbe ?? {
      current: { pid: process.pid },
      inspect: async () => ({ kind: "unknown" }),
    };
    this.pauseAfterResultValidation = options.pauseAfterResultValidation;
    this.ownerIdentity = this.processIdentityProbe.current;
    this.resumeInterruptedJobGarbageCollection();
  }

  static async open(
    driver: StateSqliteDriver,
    options: CsvAgentJobsRepositoryOpenOptions = {},
  ): Promise<CsvAgentJobsRepository> {
    options.signal?.throwIfAborted();
    const processIdentityProbe =
      options.processIdentityProbe ??
      (await createCsvProcessIdentityProbe({ signal: options.signal }));
    const repository = new CsvAgentJobsRepository(driver, {
      processIdentityProbe,
      ...(options.pauseAfterResultValidation !== undefined
        ? {
            pauseAfterResultValidation: options.pauseAfterResultValidation,
          }
        : {}),
    });
    await repository.recoverAbandonedImports({ signal: options.signal });
    return repository;
  }

  private getQuota(): CsvStorageQuotaRow {
    const quota = this.driver
      .prepareState<[], CsvStorageQuotaRow>(
        `SELECT * FROM csv_storage_quota WHERE singleton = 1`,
      )
      .get();
    if (quota === undefined)
      throw new Error("CSV storage quota row is missing");
    return quota;
  }

  createJob(
    params: CsvAgentJobCreateParams,
    items: ReadonlyArray<CsvAgentJobItemCreateParams>,
  ): CsvAgentJob {
    validateCreateParams(params, items);
    const importDigest =
      params.importDigest ??
      sha256(
        JSON.stringify({
          headers: params.inputHeaders,
          idColumn: params.idColumn ?? null,
          rows: items.map((item) => [
            item.rowIndex,
            item.itemId,
            item.sourceId ?? null,
            item.contentSha256,
          ]),
        }),
      );
    const handle = this.beginJobImport(params);
    try {
      this.appendJobImportItems(handle, items);
      return this.promoteJobImport(handle, {
        importDigest,
        inputBytes: params.inputBytes ?? 0,
        totalItems: items.length,
      });
    } catch (error) {
      this.abortJobImport(handle, "CSV import failed");
      this.deleteAbortedImport(handle);
      throw error;
    }
  }

  beginJobImport(params: CsvAgentJobCreateParams): CsvAgentJobImportHandle {
    validateCreateParams(params, []);
    const now = nowSeconds();
    const importId = params.importId ?? randomUUID();
    const leaseOwner = randomUUID();
    const leaseGeneration = randomUUID();
    const maxItems = params.maxItems ?? CSV_MAX_ROWS;
    const maxResultBytes = params.maxResultBytes ?? CSV_MAX_RESULT_BYTES;
    const maxResultBytesPerJob =
      params.maxResultBytesPerJob ?? CSV_MAX_RESULT_BYTES_PER_JOB;
    const requestedMaxConcurrency =
      params.requestedMaxConcurrency ?? CSV_DEFAULT_MAX_CONCURRENCY;
    const compiledOutputSchema = compileCsvOutputSchema(params.outputSchema);
    const inputBytes = params.inputBytes ?? 0;
    if (!Number.isSafeInteger(inputBytes) || inputBytes < 0) {
      throw new Error("CSV inputBytes must be a non-negative integer");
    }
    if (
      !Number.isSafeInteger(maxResultBytes) ||
      maxResultBytes <= 0 ||
      maxResultBytes > CSV_MAX_RESULT_BYTES
    ) {
      throw new Error(
        `CSV maxResultBytes must be between 1 and ${CSV_MAX_RESULT_BYTES}`,
      );
    }
    if (
      !Number.isSafeInteger(maxResultBytesPerJob) ||
      maxResultBytesPerJob <= 0 ||
      maxResultBytesPerJob > CSV_MAX_RESULT_BYTES_PER_JOB
    ) {
      throw new Error(
        `CSV maxResultBytesPerJob must be between 1 and ${CSV_MAX_RESULT_BYTES_PER_JOB}`,
      );
    }
    this.driver.transactionImmediate(() => {
      const quota = this.getQuota();
      assertQuota(
        quota.active_imports,
        1,
        CSV_MAX_ACTIVE_IMPORTS,
        "active import",
      );
      assertQuota(
        quota.durable_jobs + quota.active_imports,
        1,
        CSV_MAX_DURABLE_JOBS,
        "durable job",
      );
      this.driver
        .prepareState(
          `INSERT INTO csv_agent_jobs (
          id, name, status, instruction, auto_export, max_runtime_seconds,
          requested_max_concurrency, output_schema_json,
          output_schema_digest, output_schema_contract_version, execution_gate,
          input_headers_json, input_csv_path,
          output_csv_path, output_mode, id_column, import_id, import_state,
          import_digest,
          import_lease_owner, import_lease_expires_at,
          import_owner_pid, import_owner_boot_id, import_owner_process_start,
          import_lease_generation,
          identity_format_version, input_bytes, max_items, max_result_bytes,
          max_result_bytes_per_job,
          created_at, updated_at
        ) VALUES (
          ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?, ?, ?, ?,
          'staging', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )`,
        )
        .run(
          params.id,
          params.name,
          params.instruction,
          params.autoExport ? 1 : 0,
          params.maxRuntimeSeconds ?? null,
          requestedMaxConcurrency,
          compiledOutputSchema?.canonicalJson ?? null,
          compiledOutputSchema?.digest ?? null,
          compiledOutputSchema?.contractVersion ?? null,
          JSON.stringify(params.inputHeaders),
          params.inputCsvPath,
          params.outputCsvPath,
          params.outputMode ?? "replace_existing_regular",
          params.idColumn ?? null,
          importId,
          leaseOwner,
          now + CSV_IMPORT_LEASE_SECONDS,
          this.ownerIdentity.pid,
          this.ownerIdentity.bootId ?? null,
          this.ownerIdentity.processStart ?? null,
          leaseGeneration,
          CSV_JOB_IDENTITY_FORMAT_VERSION,
          inputBytes,
          maxItems,
          maxResultBytes,
          maxResultBytesPerJob,
          now,
          now,
        );
      this.driver
        .prepareState(
          `UPDATE csv_storage_quota SET active_imports = active_imports + 1,
             updated_at = ? WHERE singleton = 1`,
        )
        .run(now);
    });
    LIVE_CSV_IMPORT_GENERATIONS.add(leaseGeneration);
    return Object.freeze({
      jobId: params.id,
      importId,
      leaseOwner,
      leaseGeneration,
    });
  }

  appendJobImportItems(
    handle: CsvAgentJobImportHandle,
    items: ReadonlyArray<CsvAgentJobItemCreateParams>,
  ): void {
    if (items.length === 0) return;
    const staged = this.getStagedImport(handle);
    validateCreateParams(
      {
        id: staged.id,
        name: staged.name,
        instruction: staged.instruction,
        autoExport: staged.auto_export === 1,
        inputHeaders: JSON.parse(staged.input_headers_json) as string[],
        inputCsvPath: staged.input_csv_path,
        outputCsvPath: staged.output_csv_path,
        ...(staged.id_column !== null ? { idColumn: staged.id_column } : {}),
        maxItems: staged.max_items,
        maxResultBytes: staged.max_result_bytes,
      },
      items,
    );
    const inputHeaders = JSON.parse(staged.input_headers_json) as string[];
    const sizedItems = items.map((item) => {
      const rowJson = serializeCsvRow(item.row, inputHeaders);
      return { item, rowJson, bytes: stagedRowBytes(item, rowJson) };
    });
    const batchBytes = sizedItems.reduce((sum, entry) => sum + entry.bytes, 0);
    const now = nowSeconds();
    this.driver.transactionImmediate(() => {
      const current = this.getStagedImport(handle);
      if (current.total_items + items.length > current.max_items) {
        throw new Error(
          `CSV job has more than ${current.max_items} staged rows`,
        );
      }
      const quota = this.getQuota();
      assertQuota(
        quota.staging_rows,
        items.length,
        CSV_MAX_STAGING_ROWS_GLOBAL,
        "staging row",
      );
      assertQuota(
        quota.staging_bytes,
        batchBytes,
        CSV_MAX_STAGING_BYTES_GLOBAL,
        "staging byte",
      );
      assertQuota(
        quota.durable_items + quota.durable_reserved_items,
        items.length,
        CSV_MAX_DURABLE_ITEMS,
        "durable item",
      );
      assertQuota(
        quota.durable_bytes + quota.durable_reserved_bytes,
        batchBytes,
        CSV_MAX_DURABLE_BYTES,
        "durable byte",
      );
      if (current.id_column !== null) {
        const existingSourceId = this.driver.prepareState<
          [string, string],
          { readonly row_index: number }
        >(
          `SELECT row_index FROM csv_agent_job_items
           WHERE job_id = ? AND source_id = ?`,
        );
        for (const { item } of sizedItems) {
          const first = existingSourceId.get(current.id, item.sourceId!);
          if (first !== undefined) {
            throw new Error(
              `duplicate source_id at CSV data rows ${first.row_index + 1} and ${item.rowIndex + 1}`,
            );
          }
        }
      }
      const insertItem = this.driver.prepareState(
        `INSERT INTO csv_agent_job_items (
          job_id, item_id, row_index, source_id, content_sha256, worker_name,
          identity_format_version, row_json, status, dispatch_state,
          assigned_thread_id, attempt_count, result_json, result_availability,
          result_size_bytes, result_reserved_bytes, row_size_bytes,
          execution_semantics, created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'not_dispatched', NULL, 0, NULL,
          'not_produced', 0, 0, ?, 'at_most_once', ?, ?
        )`,
      );
      for (const { item, rowJson, bytes } of sizedItems) {
        insertItem.run(
          handle.jobId,
          item.itemId,
          item.rowIndex,
          item.sourceId ?? null,
          item.contentSha256,
          item.workerName,
          CSV_JOB_IDENTITY_FORMAT_VERSION,
          rowJson,
          bytes,
          now,
          now,
        );
      }
      const batchDigest = sha256(
        `${current.import_last_batch_digest ?? "agenc.csv.import.v1"}\0${JSON.stringify(
          items.map((item) => [
            item.rowIndex,
            item.itemId,
            item.sourceId ?? null,
            item.contentSha256,
          ]),
        )}`,
      );
      const updated = this.driver
        .prepareState(
          `UPDATE csv_agent_jobs SET import_lease_expires_at = ?, updated_at = ?,
             staging_bytes = staging_bytes + ?,
             import_last_batch_row = ?, import_last_batch_digest = ?
           WHERE id = ? AND import_id = ? AND import_lease_owner = ?
             AND import_lease_generation = ? AND import_state = 'staging'`,
        )
        .run(
          now + CSV_IMPORT_LEASE_SECONDS,
          now,
          batchBytes,
          Math.max(...items.map((item) => item.rowIndex)),
          batchDigest,
          handle.jobId,
          handle.importId,
          handle.leaseOwner,
          handle.leaseGeneration,
        );
      if (updated.changes !== 1) {
        throw new Error(`CSV import lease changed for job ${handle.jobId}`);
      }
      this.driver
        .prepareState(
          `UPDATE csv_storage_quota SET
             staging_rows = staging_rows + ?,
             staging_bytes = staging_bytes + ?,
             durable_reserved_items = durable_reserved_items + ?,
             durable_reserved_bytes = durable_reserved_bytes + ?,
             updated_at = ?
           WHERE singleton = 1`,
        )
        .run(items.length, batchBytes, items.length, batchBytes, now);
    });
  }

  promoteJobImport(
    handle: CsvAgentJobImportHandle,
    completion: CsvAgentJobImportCompletion,
  ): CsvAgentJob {
    assertSha256(completion.importDigest, "CSV import digest");
    if (
      !Number.isSafeInteger(completion.inputBytes) ||
      completion.inputBytes < 0
    ) {
      throw new Error("CSV inputBytes must be a non-negative integer");
    }
    if (
      !Number.isSafeInteger(completion.totalItems) ||
      completion.totalItems < 0
    ) {
      throw new Error("CSV totalItems must be a non-negative integer");
    }
    const now = nowSeconds();
    this.driver.transactionImmediate(() => {
      const current = this.getStagedImport(handle);
      if (current.total_items !== completion.totalItems) {
        throw new Error(
          `CSV import promotion expected ${completion.totalItems} rows but staged ${current.total_items}`,
        );
      }
      const promoted = this.driver
        .prepareState(
          `UPDATE csv_agent_jobs
           SET import_state = 'visible', import_digest = ?, input_bytes = ?,
               import_lease_owner = NULL, import_lease_expires_at = NULL,
               import_owner_pid = NULL, import_owner_boot_id = NULL,
               import_owner_process_start = NULL,
               import_lease_generation = NULL,
               durable_bytes = staging_bytes, updated_at = ?
           WHERE id = ? AND import_id = ? AND import_lease_owner = ?
             AND import_lease_generation = ?
             AND import_state = 'staging' AND total_items = ?`,
        )
        .run(
          completion.importDigest,
          completion.inputBytes,
          now,
          handle.jobId,
          handle.importId,
          handle.leaseOwner,
          handle.leaseGeneration,
          completion.totalItems,
        );
      if (promoted.changes !== 1) {
        throw new Error(`CSV import promotion failed for job ${handle.jobId}`);
      }
      this.driver
        .prepareState(
          `UPDATE csv_storage_quota SET
             active_imports = active_imports - 1,
             staging_rows = staging_rows - ?,
             staging_bytes = staging_bytes - ?,
             durable_jobs = durable_jobs + 1,
             durable_items = durable_items + ?,
             durable_bytes = durable_bytes + ?,
             durable_reserved_items = durable_reserved_items - ?,
             durable_reserved_bytes = durable_reserved_bytes - ?,
             updated_at = ?
           WHERE singleton = 1`,
        )
        .run(
          current.total_items,
          current.staging_bytes,
          current.total_items,
          current.staging_bytes,
          current.total_items,
          current.staging_bytes,
          now,
        );
    });
    LIVE_CSV_IMPORT_GENERATIONS.delete(handle.leaseGeneration);
    const created = this.getJob(handle.jobId);
    if (created === null) {
      throw new Error(`failed to load CSV job ${handle.jobId}`);
    }
    return created;
  }

  abortJobImport(handle: CsvAgentJobImportHandle, reason: string): void {
    const now = nowSeconds();
    this.driver.transactionImmediate(() => {
      const current = this.getStagedImport(handle);
      const aborted = this.driver
        .prepareState(
          `UPDATE csv_agent_jobs SET import_state = 'aborted', last_error = ?,
             import_lease_owner = NULL, import_lease_expires_at = NULL,
             import_owner_pid = NULL, import_owner_boot_id = NULL,
             import_owner_process_start = NULL,
             import_lease_generation = NULL, updated_at = ?
           WHERE id = ? AND import_id = ? AND import_lease_owner = ?
             AND import_lease_generation = ? AND import_state = 'staging'`,
        )
        .run(
          truncateUtf8(reason, CSV_ITEM_TEXT_PROJECTION_BYTES * 4).value,
          now,
          handle.jobId,
          handle.importId,
          handle.leaseOwner,
          handle.leaseGeneration,
        );
      if (aborted.changes !== 1) {
        throw new Error(`CSV import abort failed for job ${handle.jobId}`);
      }
      this.driver
        .prepareState(
          `UPDATE csv_storage_quota SET
             active_imports = active_imports - 1,
             durable_reserved_items = durable_reserved_items - ?,
             durable_reserved_bytes = durable_reserved_bytes - ?,
             updated_at = ? WHERE singleton = 1`,
        )
        .run(current.total_items, current.staging_bytes, now);
    });
    LIVE_CSV_IMPORT_GENERATIONS.delete(handle.leaseGeneration);
  }

  deleteAbortedImport(handle: CsvAgentJobImportHandle): void {
    this.cleanupAbortedImport(handle.jobId, handle.importId);
  }

  private getStagedImport(handle: CsvAgentJobImportHandle): JobRow {
    const row = this.driver
      .prepareState<[string, string, string, string], JobRow>(
        `SELECT * FROM csv_agent_jobs
         WHERE id = ? AND import_id = ? AND import_lease_owner = ?
           AND import_lease_generation = ? AND import_state = 'staging'`,
      )
      .get(
        handle.jobId,
        handle.importId,
        handle.leaseOwner,
        handle.leaseGeneration,
      );
    if (row === undefined) {
      throw new Error(`CSV import lease is not active for job ${handle.jobId}`);
    }
    return row;
  }

  async recoverAbandonedImports(
    options: {
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<number> {
    let recovered = 0;
    do {
      options.signal?.throwIfAborted();
      recovered += await this.recoverAbandonedImportSlice(options.signal);
      if (this.importRecoveryCursor !== undefined) {
        await yieldRecoverySlice(options.signal);
      }
    } while (this.importRecoveryCursor !== undefined);
    return recovered;
  }

  private async recoverAbandonedImportSlice(
    signal?: AbortSignal,
  ): Promise<number> {
    const cursor = this.importRecoveryCursor;
    const candidates = this.driver
      .prepareState<
        [number, number | null, number, number, number, number, string, number],
        StagedImportRecoveryRow
      >(
        `SELECT id, import_id, import_lease_owner, import_lease_generation,
                import_owner_pid, import_owner_boot_id,
                import_owner_process_start, import_lease_expires_at,
                total_items, staging_bytes, created_at,
                CASE WHEN last_error IS NULL THEN 0 ELSE 1 END AS recovery_rank
         FROM csv_agent_jobs
         WHERE import_state IN ('staging', 'recovering')
           AND import_lease_owner IS NOT NULL
           AND import_lease_generation IS NOT NULL
           AND import_owner_pid IS NOT NULL
           AND import_lease_expires_at <= ?
           AND (
             ? IS NULL OR
             CASE WHEN last_error IS NULL THEN 0 ELSE 1 END > ? OR
             (
               CASE WHEN last_error IS NULL THEN 0 ELSE 1 END = ? AND
               (created_at > ? OR (created_at = ? AND import_id > ?))
             )
           )
         ORDER BY recovery_rank ASC, created_at ASC, import_id ASC LIMIT ?`,
      )
      .all(
        nowSeconds(),
        cursor?.recoveryRank ?? null,
        cursor?.recoveryRank ?? 0,
        cursor?.recoveryRank ?? 0,
        cursor?.createdAt ?? 0,
        cursor?.createdAt ?? 0,
        cursor?.importId ?? "",
        CSV_RECOVERY_CANDIDATE_PAGE_SIZE,
      );
    const probeBudget = createRecoveryProbeBudget();
    let recovered = 0;
    let consumedPage = true;
    for (const candidate of candidates) {
      if (LIVE_CSV_IMPORT_GENERATIONS.has(candidate.import_lease_generation)) {
        this.importRecoveryCursor = {
          recoveryRank: candidate.recovery_rank,
          createdAt: candidate.created_at,
          importId: candidate.import_id,
        };
        continue;
      }
      if (!reserveRecoveryProcessProbe(probeBudget)) {
        consumedPage = false;
        break;
      }
      const ownerProof = await this.recordedOwnerDeathProof(
        {
          pid: candidate.import_owner_pid,
          bootId: candidate.import_owner_boot_id,
          processStart: candidate.import_owner_process_start,
        },
        signal,
      );
      signal?.throwIfAborted();
      this.importRecoveryCursor = {
        recoveryRank: candidate.recovery_rank,
        createdAt: candidate.created_at,
        importId: candidate.import_id,
      };
      if (ownerProof.kind === "deferred") {
        this.recordImportRecoveryDeferral(candidate, ownerProof.code);
        continue;
      }
      const claim = this.claimAbandonedImportRecovery(candidate);
      if (claim === null) continue;
      try {
        this.finishAbandonedImportRecovery(candidate, claim);
      } finally {
        this.releaseImportRecoveryClaim(claim);
      }
      LIVE_CSV_IMPORT_GENERATIONS.delete(candidate.import_lease_generation);
      this.cleanupAbortedImport(candidate.id, candidate.import_id);
      recovered += 1;
    }
    if (consumedPage && candidates.length < CSV_RECOVERY_CANDIDATE_PAGE_SIZE) {
      this.importRecoveryCursor = undefined;
    }
    return recovered;
  }

  private claimAbandonedImportRecovery(
    candidate: StagedImportRecoveryRow,
  ): CsvImportRecoveryClaim | null {
    const claim = {
      leaseOwner: randomUUID(),
      leaseGeneration: randomUUID(),
    };
    const now = nowSeconds();
    const changes = this.driver.transactionImmediate(
      () =>
        this.driver
          .prepareState(
            `UPDATE csv_agent_jobs SET import_state = 'recovering',
               import_lease_owner = ?, import_lease_expires_at = ?,
               import_owner_pid = ?, import_owner_boot_id = ?,
               import_owner_process_start = ?, import_lease_generation = ?,
               updated_at = ?
             WHERE id = ? AND import_id = ?
               AND import_lease_owner = ? AND import_lease_generation = ?
               AND import_state IN ('staging', 'recovering')`,
          )
          .run(
            claim.leaseOwner,
            now + CSV_IMPORT_LEASE_SECONDS,
            this.ownerIdentity.pid,
            this.ownerIdentity.bootId ?? null,
            this.ownerIdentity.processStart ?? null,
            claim.leaseGeneration,
            now,
            candidate.id,
            candidate.import_id,
            candidate.import_lease_owner,
            candidate.import_lease_generation,
          ).changes,
    );
    if (changes !== 1) return null;
    LIVE_CSV_IMPORT_GENERATIONS.add(claim.leaseGeneration);
    return claim;
  }

  private finishAbandonedImportRecovery(
    candidate: StagedImportRecoveryRow,
    claim: CsvImportRecoveryClaim,
  ): void {
    this.driver.transactionImmediate(() => {
      const abandoned = this.driver
        .prepareState(
          `UPDATE csv_agent_jobs SET import_state = 'aborted',
               import_lease_owner = NULL, import_lease_expires_at = NULL,
               import_owner_pid = NULL, import_owner_boot_id = NULL,
               import_owner_process_start = NULL,
               import_lease_generation = NULL,
               last_error = 'CSV importer owner is proven dead', updated_at = ?
             WHERE id = ? AND import_id = ? AND import_lease_owner = ?
               AND import_lease_generation = ? AND import_state = 'recovering'`,
        )
        .run(
          nowSeconds(),
          candidate.id,
          candidate.import_id,
          claim.leaseOwner,
          claim.leaseGeneration,
        );
      if (abandoned.changes !== 1) {
        throw new Error(
          `CSV import recovery fence changed for ${candidate.import_id}`,
        );
      }
      this.driver
        .prepareState(
          `UPDATE csv_storage_quota SET
               active_imports = active_imports - 1,
               durable_reserved_items = durable_reserved_items - ?,
               durable_reserved_bytes = durable_reserved_bytes - ?,
               updated_at = ? WHERE singleton = 1`,
        )
        .run(candidate.total_items, candidate.staging_bytes, nowSeconds());
    });
  }

  private releaseImportRecoveryClaim(claim: CsvImportRecoveryClaim): void {
    LIVE_CSV_IMPORT_GENERATIONS.delete(claim.leaseGeneration);
  }

  private recordImportRecoveryDeferral(
    candidate: StagedImportRecoveryRow,
    code: CsvRecoveryDeferralCode,
  ): void {
    this.driver
      .prepareState(
        `UPDATE csv_agent_jobs SET last_error = ?, updated_at = ?
         WHERE id = ? AND import_id = ? AND import_lease_owner = ?
           AND import_lease_generation = ?
           AND import_state IN ('staging', 'recovering')`,
      )
      .run(
        code,
        nowSeconds(),
        candidate.id,
        candidate.import_id,
        candidate.import_lease_owner,
        candidate.import_lease_generation,
      );
  }

  private cleanupAbortedImport(jobId: string, importId: string): void {
    const deadline = Date.now() + CSV_MAX_STAGING_GC_MS_PER_START;
    while (Date.now() <= deadline) {
      const finished = this.driver.transactionImmediate(() => {
        const batch = this.driver
          .prepareState<
            [string, string, number],
            { readonly count: number; readonly bytes: number }
          >(
            `SELECT COUNT(*) AS count, COALESCE(SUM(row_size_bytes), 0) AS bytes
             FROM (
               SELECT item.row_size_bytes
               FROM csv_agent_job_items AS item
               JOIN csv_agent_jobs AS job ON job.id = item.job_id
               WHERE item.job_id = ? AND job.import_id = ?
                 AND job.import_state = 'aborted'
               ORDER BY item.row_index ASC, item.item_id ASC
               LIMIT ?
             )`,
          )
          .get(jobId, importId, CSV_JOB_GC_PAGE_ITEMS);
        if (batch === undefined || batch.count === 0) {
          this.driver
            .prepareState(
              `DELETE FROM csv_agent_jobs
               WHERE id = ? AND import_id = ? AND import_state = 'aborted'`,
            )
            .run(jobId, importId);
          return true;
        }
        this.driver
          .prepareState(
            `DELETE FROM csv_agent_job_items WHERE rowid IN (
               SELECT item.rowid FROM csv_agent_job_items AS item
               JOIN csv_agent_jobs AS job ON job.id = item.job_id
               WHERE item.job_id = ? AND job.import_id = ?
                 AND job.import_state = 'aborted'
               ORDER BY item.row_index ASC, item.item_id ASC
               LIMIT ?
             )`,
          )
          .run(jobId, importId, CSV_JOB_GC_PAGE_ITEMS);
        this.driver
          .prepareState(
            `UPDATE csv_storage_quota SET
               staging_rows = staging_rows - ?,
               staging_bytes = staging_bytes - ?, updated_at = ?
             WHERE singleton = 1`,
          )
          .run(batch.count, batch.bytes, nowSeconds());
        return false;
      });
      if (finished) return;
    }
  }

  cleanupExpiredStagedImport(_importId: string, _now = nowSeconds()): boolean {
    // Kept as a fail-closed compatibility shim. Wall-clock expiry is not proof
    // that an importer died; recovery uses exact boot/process/generation proof.
    return false;
  }

  getJob(jobId: string): CsvAgentJob | null {
    const row = this.driver
      .prepareState<[string], JobRow>(
        `SELECT * FROM csv_agent_jobs
         WHERE id = ? AND import_state = 'visible' AND retired_at IS NULL`,
      )
      .get(jobId);
    return row === undefined ? null : decodeJob(row);
  }

  listJobs(
    opts: {
      readonly status?: CsvAgentJobStatus;
      readonly limit?: number;
      readonly beforeUpdatedAt?: number;
    } = {},
  ): ReadonlyArray<CsvAgentJob> {
    const limit = Math.min(opts.limit ?? CSV_MAX_ITEM_PAGE_SIZE, CSV_MAX_ROWS);
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new Error("CSV job list limit must be a positive integer");
    }
    const where = ["import_state = 'visible'", "retired_at IS NULL"];
    const binds: unknown[] = [];
    if (opts.status !== undefined) {
      where.push("status = ?");
      binds.push(opts.status);
    }
    if (opts.beforeUpdatedAt !== undefined) {
      where.push("updated_at < ?");
      binds.push(opts.beforeUpdatedAt);
    }
    binds.push(limit);
    return this.driver
      .prepareState<unknown[], JobRow>(
        `SELECT * FROM csv_agent_jobs
         WHERE ${where.join(" AND ")}
         ORDER BY updated_at DESC, id ASC LIMIT ?`,
      )
      .all(...binds)
      .map(decodeJob);
  }

  retireJob(jobId: string): void {
    const now = nowSeconds();
    const result = this.driver
      .prepareState(
        `UPDATE csv_agent_jobs SET retired_at = ?, updated_at = ?
         WHERE id = ? AND import_state = 'visible' AND retired_at IS NULL
           AND status IN (
             'completed', 'failed', 'cancelled',
             'finished_with_unknown_outcomes'
           )
           AND NOT EXISTS (
             SELECT 1 FROM csv_agent_job_items AS item
             WHERE item.job_id = csv_agent_jobs.id
               AND item.review_status = 'pending'
           )`,
      )
      .run(now, now, jobId);
    if (result.changes !== 1) {
      throw new Error(`CSV job ${jobId} is not safely retireable`);
    }
  }

  deleteJob(jobId: string): void {
    this.beginJobTombstone(jobId);
    this.continueJobGarbageCollection(jobId);
  }

  collectRetainedTerminalJobs(now = nowSeconds()): number {
    const cutoff = now - Math.floor(CSV_TERMINAL_JOB_RETENTION_MS / 1_000);
    const candidates = this.driver
      .prepareState<[number, number], { readonly id: string }>(
        `SELECT id FROM csv_agent_jobs
         WHERE import_state = 'visible' AND retired_at IS NULL
           AND completed_at IS NOT NULL AND completed_at <= ?
           AND status IN ('completed', 'failed', 'cancelled')
           AND output_digest IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM csv_agent_job_items AS item
             WHERE item.job_id = csv_agent_jobs.id
               AND (item.review_status = 'pending'
                 OR item.status IN ('running', 'unknown_outcome'))
           )
         ORDER BY completed_at ASC, id ASC LIMIT ?`,
      )
      .all(cutoff, CSV_JOB_GC_PAGE_ITEMS);
    for (const candidate of candidates) {
      this.retireJob(candidate.id);
      this.deleteJob(candidate.id);
    }
    return candidates.length;
  }

  private beginJobTombstone(jobId: string): void {
    const job = this.driver
      .prepareState<[string], JobRow>(
        `SELECT * FROM csv_agent_jobs WHERE id = ? AND import_state = 'visible'
           AND retired_at IS NOT NULL`,
      )
      .get(jobId);
    if (job === undefined) {
      throw new Error(`CSV job ${jobId} must be retired before deletion`);
    }
    if (job.status === "finished_with_unknown_outcomes") {
      throw new Error(
        "CSV jobs with abandoned unknown outcomes cannot be deleted",
      );
    }
    const resultSet = createHash("sha256");
    const resultRows = this.driver
      .prepareState<
        [string],
        {
          readonly item_id: string;
          readonly status: string;
          readonly result_digest: string | null;
          readonly result_availability: string;
        }
      >(
        `SELECT item_id, status, result_digest, result_availability
         FROM csv_agent_job_items WHERE job_id = ?
         ORDER BY row_index ASC, item_id ASC`,
      )
      .iterate(jobId);
    for (const row of resultRows) {
      resultSet.update(
        JSON.stringify([
          row.item_id,
          row.status,
          row.result_availability,
          row.result_digest,
        ]),
      );
    }
    const evidence = createHash("sha256");
    let evidenceCount = 0;
    for (const row of this.driver
      .prepareState<
        [string],
        { readonly sequence: number; readonly evidence_json: string | null }
      >(
        `SELECT sequence, evidence_json FROM csv_agent_job_review_history
         WHERE job_id = ? ORDER BY sequence ASC`,
      )
      .iterate(jobId)) {
      evidence.update(JSON.stringify([row.sequence, row.evidence_json]));
      evidenceCount += 1;
    }
    const counters = JSON.stringify({
      totalItems: job.total_items,
      pendingItems: job.pending_items,
      runningItems: job.running_items,
      completedItems: job.completed_items,
      failedItems: job.failed_items,
      cancelledItems: job.cancelled_items,
      unknownOutcomeItems: job.unknown_outcome_items,
      resultBytes: job.result_bytes,
    });
    const evidenceReferences = JSON.stringify({
      historyCount: evidenceCount,
      historyDigest: evidence.digest("hex"),
    });
    const resultSetDigest = resultSet.digest("hex");
    const payloadBytes = Buffer.byteLength(
      JSON.stringify({
        jobId,
        status: job.status,
        counters,
        inputDigest: job.import_digest,
        outputDigest: job.output_digest,
        outputSchemaDigest: job.output_schema_digest,
        resultSetDigest,
        evidenceReferences,
      }),
      "utf8",
    );
    this.driver.transactionImmediate(() => {
      const existing = this.driver
        .prepareState<[string], { readonly job_id: string }>(
          `SELECT job_id FROM csv_job_tombstones WHERE job_id = ?`,
        )
        .get(jobId);
      if (existing !== undefined) return;
      const quota = this.getQuota();
      assertQuota(quota.tombstones, 1, CSV_MAX_JOB_TOMBSTONES, "job tombstone");
      assertQuota(
        quota.tombstone_bytes,
        payloadBytes,
        CSV_MAX_JOB_TOMBSTONE_BYTES,
        "job tombstone byte",
      );
      this.driver
        .prepareState(
          `INSERT INTO csv_job_tombstones (
             job_id, final_status, final_counters_json, input_digest,
             output_digest, output_schema_digest, result_set_digest,
             evidence_references_json, payload_bytes, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          jobId,
          job.status,
          counters,
          job.import_digest,
          job.output_digest,
          job.output_schema_digest,
          resultSetDigest,
          evidenceReferences,
          payloadBytes,
          nowSeconds(),
        );
      this.driver
        .prepareState(
          `INSERT INTO csv_job_gc_intents (
             job_id, cursor_row_index, state, created_at, updated_at
           ) VALUES (?, -1, 'tombstoned', ?, ?)`,
        )
        .run(jobId, nowSeconds(), nowSeconds());
      this.driver
        .prepareState(
          `UPDATE csv_storage_quota SET tombstones = tombstones + 1,
             tombstone_bytes = tombstone_bytes + ?, updated_at = ?
           WHERE singleton = 1`,
        )
        .run(payloadBytes, nowSeconds());
    });
  }

  private continueJobGarbageCollection(jobId: string): void {
    const deadline = Date.now() + CSV_MAX_JOB_GC_MS_PER_SLICE;
    while (Date.now() <= deadline) {
      const finished = this.driver.transactionImmediate(() => {
        const batch = this.driver
          .prepareState<
            [string, number],
            {
              readonly count: number;
              readonly durable_bytes: number;
              readonly result_bytes: number;
              readonly reserved_bytes: number;
            }
          >(
            `SELECT COUNT(*) AS count,
                    COALESCE(SUM(row_size_bytes + result_size_bytes), 0)
                      AS durable_bytes,
                    COALESCE(SUM(result_size_bytes), 0) AS result_bytes,
                    COALESCE(SUM(result_reserved_bytes), 0) AS reserved_bytes
             FROM (
               SELECT row_size_bytes, result_size_bytes, result_reserved_bytes
               FROM csv_agent_job_items WHERE job_id = ?
               ORDER BY row_index ASC, item_id ASC LIMIT ?
             )`,
          )
          .get(jobId, CSV_JOB_GC_PAGE_ITEMS);
        if (batch === undefined || batch.count === 0) {
          const removed = this.driver
            .prepareState(
              `DELETE FROM csv_agent_jobs WHERE id = ? AND retired_at IS NOT NULL
                 AND EXISTS (
                   SELECT 1 FROM csv_job_tombstones WHERE job_id = ?
                 )`,
            )
            .run(jobId, jobId);
          if (removed.changes !== 1) {
            throw new Error(
              `CSV job ${jobId} garbage collection lost its fence`,
            );
          }
          this.driver
            .prepareState(
              `UPDATE csv_storage_quota SET durable_jobs = durable_jobs - 1,
                 updated_at = ? WHERE singleton = 1`,
            )
            .run(nowSeconds());
          return true;
        }
        this.driver
          .prepareState(
            `DELETE FROM csv_agent_job_items WHERE rowid IN (
               SELECT rowid FROM csv_agent_job_items WHERE job_id = ?
               ORDER BY row_index ASC, item_id ASC LIMIT ?
             )`,
          )
          .run(jobId, CSV_JOB_GC_PAGE_ITEMS);
        this.driver
          .prepareState(
            `UPDATE csv_storage_quota SET
               durable_items = durable_items - ?,
               durable_bytes = durable_bytes - ?,
               result_blob_bytes = result_blob_bytes - ?,
               result_reserved_bytes = result_reserved_bytes - ?,
               updated_at = ? WHERE singleton = 1`,
          )
          .run(
            batch.count,
            batch.durable_bytes,
            batch.result_bytes,
            batch.reserved_bytes,
            nowSeconds(),
          );
        this.driver
          .prepareState(
            `UPDATE csv_job_gc_intents SET state = 'deleting', updated_at = ?
             WHERE job_id = ?`,
          )
          .run(nowSeconds(), jobId);
        return false;
      });
      if (finished) return;
    }
  }

  private resumeInterruptedJobGarbageCollection(): void {
    const pending = this.driver
      .prepareState<[], { readonly job_id: string }>(
        `SELECT job_id FROM csv_job_gc_intents
         ORDER BY created_at ASC, job_id ASC LIMIT 1`,
      )
      .get();
    if (pending !== undefined) {
      this.continueJobGarbageCollection(pending.job_id);
    }
  }

  markJobRunning(jobId: string, effectiveMaxConcurrency?: number): void {
    if (
      effectiveMaxConcurrency !== undefined &&
      (!Number.isSafeInteger(effectiveMaxConcurrency) ||
        effectiveMaxConcurrency < 1 ||
        effectiveMaxConcurrency > CSV_MAX_JOB_CONCURRENCY)
    ) {
      throw new Error(
        `CSV effective concurrency must be between 1 and ${CSV_MAX_JOB_CONCURRENCY}`,
      );
    }
    const now = nowSeconds();
    this.driver
      .prepareState(
        `UPDATE csv_agent_jobs
         SET status = 'running', started_at = COALESCE(started_at, ?),
             completed_at = NULL, updated_at = ?, last_error = NULL,
             last_effective_max_concurrency = COALESCE(
               ?, requested_max_concurrency
             )
         WHERE id = ? AND import_state = 'visible' AND retired_at IS NULL
           AND status IN ('pending', 'running')`,
      )
      .run(now, now, effectiveMaxConcurrency ?? null, jobId);
  }

  markJobCompleted(jobId: string): CsvAgentJobStatus {
    return this.refreshJobOutcome(jobId);
  }

  markJobFailed(jobId: string, error: string): void {
    const now = nowSeconds();
    this.driver
      .prepareState(
        `UPDATE csv_agent_jobs
         SET status = 'failed', completed_at = ?, updated_at = ?, last_error = ?
         WHERE id = ? AND import_state = 'visible' AND retired_at IS NULL
           AND status IN ('pending', 'running')`,
      )
      .run(now, now, error, jobId);
  }

  markJobCancelled(jobId: string, reason: string): void {
    const now = nowSeconds();
    this.driver
      .prepareState(
        `UPDATE csv_agent_jobs
         SET status = 'cancelled', completed_at = ?, updated_at = ?, last_error = ?
         WHERE id = ? AND import_state = 'visible' AND retired_at IS NULL
           AND status IN ('pending', 'running')`,
      )
      .run(now, now, reason, jobId);
  }

  recordOutputArtifact(
    jobId: string,
    artifact: {
      readonly contractVersion: number;
      readonly bytes: number;
      readonly sha256: string;
    },
  ): void {
    if (artifact.contractVersion !== CSV_OUTPUT_CONTRACT_VERSION) {
      throw new Error("unsupported CSV output contract version");
    }
    if (
      !Number.isSafeInteger(artifact.bytes) ||
      artifact.bytes < 0 ||
      artifact.bytes > CSV_MAX_OUTPUT_BYTES
    ) {
      throw new Error("invalid CSV output byte count");
    }
    assertSha256(artifact.sha256, "CSV output digest");
    const updated = this.driver
      .prepareState(
        `UPDATE csv_agent_jobs SET output_contract_version = ?,
           output_digest = ?, output_bytes = ?, updated_at = ?
         WHERE id = ? AND import_state = 'visible' AND retired_at IS NULL`,
      )
      .run(
        artifact.contractVersion,
        artifact.sha256,
        artifact.bytes,
        nowSeconds(),
        jobId,
      );
    if (updated.changes !== 1) {
      throw new Error(`cannot record CSV output artifact for job ${jobId}`);
    }
  }

  beginCsvOutputIntent(input: {
    readonly jobId: string;
    readonly rootPath: string;
    readonly targetPath: string;
    readonly temporaryPath: string;
    readonly temporaryDev: string;
    readonly temporaryIno: string;
    readonly reservedBytes: number;
  }): string {
    const intentId = randomUUID();
    const ownerGeneration = randomUUID();
    const now = nowSeconds();
    this.driver.transactionImmediate(() => {
      const quota = this.getQuota();
      assertQuota(
        quota.output_staging_files,
        1,
        CSV_MAX_OUTPUT_STAGING_FILES_GLOBAL,
        "output staging file",
      );
      assertQuota(
        quota.output_staging_bytes,
        input.reservedBytes,
        CSV_MAX_OUTPUT_STAGING_BYTES_GLOBAL,
        "output staging byte",
      );
      const inserted = this.driver
        .prepareState(
          `INSERT INTO csv_output_intents (
             intent_id, job_id, root_path, target_path, temporary_path, temporary_dev,
             temporary_ino, reserved_bytes, state, owner_generation,
             owner_pid, owner_boot_id, owner_process_start, created_at, updated_at
           )
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'writing', ?, ?, ?, ?, ?, ?
           WHERE EXISTS (
             SELECT 1 FROM csv_agent_jobs WHERE id = ?
               AND import_state = 'visible' AND retired_at IS NULL
           )`,
        )
        .run(
          intentId,
          input.jobId,
          input.rootPath,
          input.targetPath,
          input.temporaryPath,
          input.temporaryDev,
          input.temporaryIno,
          input.reservedBytes,
          ownerGeneration,
          this.ownerIdentity.pid,
          this.ownerIdentity.bootId ?? null,
          this.ownerIdentity.processStart ?? null,
          now,
          now,
          input.jobId,
        );
      if (inserted.changes !== 1) {
        throw new Error(
          `cannot create CSV output intent for job ${input.jobId}`,
        );
      }
      this.driver
        .prepareState(
          `UPDATE csv_storage_quota SET
             output_staging_files = output_staging_files + 1,
             output_staging_bytes = output_staging_bytes + ?, updated_at = ?
           WHERE singleton = 1`,
        )
        .run(input.reservedBytes, now);
    });
    LIVE_CSV_OUTPUT_GENERATIONS.add(ownerGeneration);
    return intentId;
  }

  markCsvOutputIntentFlushed(intentId: string): void {
    const updated = this.driver
      .prepareState(
        `UPDATE csv_output_intents SET state = 'flushed', updated_at = ?
         WHERE intent_id = ? AND state = 'writing'`,
      )
      .run(nowSeconds(), intentId);
    if (updated.changes !== 1) {
      throw new Error(`CSV output intent ${intentId} is not writable`);
    }
  }

  markCsvOutputIntentPublished(intentId: string): void {
    const updated = this.driver
      .prepareState(
        `UPDATE csv_output_intents SET state = 'published', updated_at = ?
         WHERE intent_id = ? AND state = 'flushed'`,
      )
      .run(nowSeconds(), intentId);
    if (updated.changes !== 1) {
      throw new Error(`CSV output intent ${intentId} is not publishable`);
    }
  }

  completeCsvOutputIntent(
    intentId: string,
    artifact: {
      readonly contractVersion: number;
      readonly path: string;
      readonly bytes: number;
      readonly sha256: string;
    },
  ): void {
    const ownerGeneration = this.outputIntentGeneration(intentId);
    assertSha256(artifact.sha256, "CSV output digest");
    if (
      artifact.contractVersion !== CSV_OUTPUT_CONTRACT_VERSION ||
      !Number.isSafeInteger(artifact.bytes) ||
      artifact.bytes < 0 ||
      artifact.bytes > CSV_MAX_OUTPUT_BYTES
    ) {
      throw new Error("invalid CSV output artifact");
    }
    const now = nowSeconds();
    this.driver.transactionImmediate(() => {
      const intent = this.driver
        .prepareState<
          [string],
          {
            readonly job_id: string;
            readonly target_path: string;
            readonly reserved_bytes: number;
          }
        >(
          `SELECT job_id, target_path, reserved_bytes FROM csv_output_intents
           WHERE intent_id = ? AND state IN ('flushed', 'published')`,
        )
        .get(intentId);
      if (intent === undefined || intent.target_path !== artifact.path) {
        throw new Error(`CSV output intent ${intentId} changed before commit`);
      }
      const recorded = this.driver
        .prepareState(
          `UPDATE csv_agent_jobs SET output_contract_version = ?,
             output_digest = ?, output_bytes = ?, updated_at = ?
           WHERE id = ? AND import_state = 'visible' AND retired_at IS NULL`,
        )
        .run(
          artifact.contractVersion,
          artifact.sha256,
          artifact.bytes,
          now,
          intent.job_id,
        );
      if (recorded.changes !== 1) {
        throw new Error(`cannot record CSV output for job ${intent.job_id}`);
      }
      this.driver
        .prepareState(`DELETE FROM csv_output_intents WHERE intent_id = ?`)
        .run(intentId);
      this.driver
        .prepareState(
          `UPDATE csv_storage_quota SET
             output_staging_files = output_staging_files - 1,
             output_staging_bytes = output_staging_bytes - ?, updated_at = ?
           WHERE singleton = 1`,
        )
        .run(intent.reserved_bytes, now);
    });
    if (ownerGeneration !== undefined) {
      LIVE_CSV_OUTPUT_GENERATIONS.delete(ownerGeneration);
    }
  }

  abandonCsvOutputIntent(intentId: string, retainForRecovery: boolean): void {
    const ownerGeneration = this.outputIntentGeneration(intentId);
    const now = nowSeconds();
    this.driver.transactionImmediate(() => {
      const intent = this.driver
        .prepareState<[string], { readonly reserved_bytes: number }>(
          `SELECT reserved_bytes FROM csv_output_intents WHERE intent_id = ?`,
        )
        .get(intentId);
      if (intent === undefined) return;
      if (retainForRecovery) {
        this.driver
          .prepareState(
            `UPDATE csv_output_intents SET
               recovery_prior_state = COALESCE(recovery_prior_state, state),
               state = 'abandoned', updated_at = ?
             WHERE intent_id = ?`,
          )
          .run(now, intentId);
        return;
      }
      this.driver
        .prepareState(`DELETE FROM csv_output_intents WHERE intent_id = ?`)
        .run(intentId);
      this.driver
        .prepareState(
          `UPDATE csv_storage_quota SET
             output_staging_files = output_staging_files - 1,
             output_staging_bytes = output_staging_bytes - ?, updated_at = ?
           WHERE singleton = 1`,
        )
        .run(intent.reserved_bytes, now);
    });
    if (ownerGeneration !== undefined) {
      LIVE_CSV_OUTPUT_GENERATIONS.delete(ownerGeneration);
    }
  }

  async claimCsvOutputRecoveryIntents(input: {
    readonly rootPath: string;
    readonly limit: number;
    readonly signal?: AbortSignal;
  }): Promise<{
    readonly intents: ReadonlyArray<CsvOutputRecoveryIntent>;
    readonly hasMore: boolean;
  }> {
    if (!Number.isSafeInteger(input.limit) || input.limit <= 0) {
      throw new Error("CSV output recovery limit must be a positive integer");
    }
    const cursor = this.outputRecoveryCursors.get(input.rootPath);
    const candidates = this.driver
      .prepareState<
        [string, number | null, number, number, number, number, string, number],
        CsvOutputIntentRecoveryRow
      >(
        `SELECT intent_id, target_path, temporary_path, temporary_dev,
                temporary_ino, state, recovery_prior_state,
                owner_generation, owner_pid,
                owner_boot_id, owner_process_start, created_at,
                CASE WHEN last_error IS NULL THEN 0 ELSE 1 END AS recovery_rank
         FROM csv_output_intents
         WHERE root_path = ?
           AND state IN ('writing', 'flushed', 'published', 'abandoned', 'recovering')
           AND (
             ? IS NULL OR
             CASE WHEN last_error IS NULL THEN 0 ELSE 1 END > ? OR
             (
               CASE WHEN last_error IS NULL THEN 0 ELSE 1 END = ? AND
               (created_at > ? OR (created_at = ? AND intent_id > ?))
             )
           )
         ORDER BY recovery_rank ASC, created_at ASC, intent_id ASC LIMIT ?`,
      )
      .all(
        input.rootPath,
        cursor?.recoveryRank ?? null,
        cursor?.recoveryRank ?? 0,
        cursor?.recoveryRank ?? 0,
        cursor?.createdAt ?? 0,
        cursor?.createdAt ?? 0,
        cursor?.intentId ?? "",
        CSV_RECOVERY_CANDIDATE_PAGE_SIZE,
      );
    const probeBudget = createRecoveryProbeBudget();
    const claimed: CsvOutputRecoveryIntent[] = [];
    let consumedPage = true;
    for (const candidate of candidates) {
      if (claimed.length >= input.limit) {
        consumedPage = false;
        break;
      }
      if (LIVE_CSV_OUTPUT_GENERATIONS.has(candidate.owner_generation)) {
        this.outputRecoveryCursors.set(input.rootPath, {
          recoveryRank: candidate.recovery_rank,
          createdAt: candidate.created_at,
          intentId: candidate.intent_id,
        });
        continue;
      }
      if (
        candidate.state !== "abandoned" &&
        !reserveRecoveryProcessProbe(probeBudget)
      ) {
        consumedPage = false;
        break;
      }
      const ownerProof =
        candidate.state === "abandoned"
          ? ({ kind: "proven_dead" } as const)
          : await this.recordedOwnerDeathProof(
              {
                pid: candidate.owner_pid,
                bootId: candidate.owner_boot_id,
                processStart: candidate.owner_process_start,
              },
              input.signal,
            );
      input.signal?.throwIfAborted();
      this.outputRecoveryCursors.set(input.rootPath, {
        recoveryRank: candidate.recovery_rank,
        createdAt: candidate.created_at,
        intentId: candidate.intent_id,
      });
      if (ownerProof.kind === "deferred") {
        this.recordOutputRecoveryDeferral(candidate, ownerProof.code);
        continue;
      }
      const ownerGeneration = randomUUID();
      const now = nowSeconds();
      const changes = this.driver.transactionImmediate(
        () =>
          this.driver
            .prepareState(
              `UPDATE csv_output_intents SET state = 'recovering',
               recovery_prior_state = COALESCE(
                 recovery_prior_state,
                 CASE WHEN state = 'recovering' THEN 'abandoned' ELSE state END
               ),
               owner_generation = ?, owner_pid = ?, owner_boot_id = ?,
               owner_process_start = ?, last_error = NULL, updated_at = ?
             WHERE intent_id = ? AND owner_generation = ? AND state = ?`,
            )
            .run(
              ownerGeneration,
              this.ownerIdentity.pid,
              this.ownerIdentity.bootId ?? null,
              this.ownerIdentity.processStart ?? null,
              now,
              candidate.intent_id,
              candidate.owner_generation,
              candidate.state,
            ).changes,
      );
      if (changes !== 1) continue;
      LIVE_CSV_OUTPUT_GENERATIONS.add(ownerGeneration);
      claimed.push({
        intentId: candidate.intent_id,
        ownerGeneration,
        priorState:
          candidate.recovery_prior_state ??
          (candidate.state === "recovering" ? "abandoned" : candidate.state),
        targetPath: candidate.target_path,
        temporaryPath: candidate.temporary_path,
        temporaryDev: candidate.temporary_dev,
        temporaryIno: candidate.temporary_ino,
      });
    }
    if (consumedPage && candidates.length < CSV_RECOVERY_CANDIDATE_PAGE_SIZE) {
      this.outputRecoveryCursors.delete(input.rootPath);
    }
    return {
      intents: claimed,
      hasMore: this.outputRecoveryCursors.has(input.rootPath),
    };
  }

  finishCsvOutputIntentRecovery(input: {
    readonly intentId: string;
    readonly ownerGeneration: string;
    readonly artifact?: CsvOutputArtifact;
  }): void {
    if (input.artifact !== undefined) {
      assertSha256(input.artifact.sha256, "CSV output digest");
      if (
        input.artifact.contractVersion !== CSV_OUTPUT_CONTRACT_VERSION ||
        !Number.isSafeInteger(input.artifact.bytes) ||
        input.artifact.bytes < 0 ||
        input.artifact.bytes > CSV_MAX_OUTPUT_BYTES
      ) {
        throw new Error("invalid recovered CSV output artifact");
      }
    }
    const now = nowSeconds();
    this.driver.transactionImmediate(() => {
      const intent = this.driver
        .prepareState<
          [string, string],
          {
            readonly job_id: string;
            readonly target_path: string;
            readonly reserved_bytes: number;
          }
        >(
          `SELECT job_id, target_path, reserved_bytes
           FROM csv_output_intents
           WHERE intent_id = ? AND owner_generation = ?
             AND state = 'recovering'`,
        )
        .get(input.intentId, input.ownerGeneration);
      if (
        intent === undefined ||
        (input.artifact !== undefined &&
          input.artifact.path !== intent.target_path)
      ) {
        throw new Error(
          `CSV output recovery fence changed for ${input.intentId}`,
        );
      }
      if (input.artifact !== undefined) {
        const recorded = this.driver
          .prepareState(
            `UPDATE csv_agent_jobs SET output_contract_version = ?,
               output_digest = ?, output_bytes = ?, updated_at = ?
             WHERE id = ? AND import_state = 'visible' AND retired_at IS NULL`,
          )
          .run(
            input.artifact.contractVersion,
            input.artifact.sha256,
            input.artifact.bytes,
            now,
            intent.job_id,
          );
        if (recorded.changes !== 1) {
          throw new Error(
            `cannot record recovered CSV output for job ${intent.job_id}`,
          );
        }
      }
      const removed = this.driver
        .prepareState(
          `DELETE FROM csv_output_intents
           WHERE intent_id = ? AND owner_generation = ? AND state = 'recovering'`,
        )
        .run(input.intentId, input.ownerGeneration);
      if (removed.changes !== 1) {
        throw new Error(
          `CSV output recovery fence changed for ${input.intentId}`,
        );
      }
      this.driver
        .prepareState(
          `UPDATE csv_storage_quota SET
             output_staging_files = output_staging_files - 1,
             output_staging_bytes = output_staging_bytes - ?, updated_at = ?
           WHERE singleton = 1`,
        )
        .run(intent.reserved_bytes, now);
    });
    LIVE_CSV_OUTPUT_GENERATIONS.delete(input.ownerGeneration);
  }

  deferCsvOutputIntentRecovery(input: {
    readonly intentId: string;
    readonly ownerGeneration: string;
    readonly reason: string;
  }): void {
    if (
      input.reason.length === 0 ||
      Buffer.byteLength(input.reason, "utf8") > 1_024
    ) {
      throw new Error("invalid CSV output recovery diagnostic");
    }
    const updated = this.driver
      .prepareState(
        `UPDATE csv_output_intents SET state = 'abandoned', last_error = ?,
           updated_at = ?
         WHERE intent_id = ? AND owner_generation = ? AND state = 'recovering'`,
      )
      .run(input.reason, nowSeconds(), input.intentId, input.ownerGeneration);
    if (updated.changes !== 1) {
      throw new Error(
        `CSV output recovery fence changed for ${input.intentId}`,
      );
    }
    LIVE_CSV_OUTPUT_GENERATIONS.delete(input.ownerGeneration);
  }

  private outputIntentGeneration(intentId: string): string | undefined {
    return this.driver
      .prepareState<[string], { readonly owner_generation: string }>(
        `SELECT owner_generation FROM csv_output_intents WHERE intent_id = ?`,
      )
      .get(intentId)?.owner_generation;
  }

  private recordOutputRecoveryDeferral(
    candidate: CsvOutputIntentRecoveryRow,
    code: CsvRecoveryDeferralCode,
  ): void {
    this.driver
      .prepareState(
        `UPDATE csv_output_intents SET last_error = ?, updated_at = ?
         WHERE intent_id = ? AND owner_generation = ? AND state = ?`,
      )
      .run(
        code,
        nowSeconds(),
        candidate.intent_id,
        candidate.owner_generation,
        candidate.state,
      );
  }

  private async recordedOwnerDeathProof(
    owner: {
      readonly pid: number;
      readonly bootId: string | null;
      readonly processStart: string | null;
    },
    signal?: AbortSignal,
  ): Promise<CsvOwnerDeathProof> {
    if (owner.pid === this.ownerIdentity.pid) return { kind: "proven_dead" };
    if (
      owner.bootId !== null &&
      this.ownerIdentity.bootId !== undefined &&
      owner.bootId !== this.ownerIdentity.bootId
    ) {
      return { kind: "proven_dead" };
    }
    signal?.throwIfAborted();
    const observed = await this.processIdentityProbe.inspect(owner.pid, signal);
    signal?.throwIfAborted();
    if (observed.kind === "dead") return { kind: "proven_dead" };
    if (observed.kind === "unknown") {
      return {
        kind: "deferred",
        code: CSV_RECOVERY_DEFERRED_PROCESS_PROBE_UNAVAILABLE,
      };
    }
    if (owner.processStart === null || observed.processStart === undefined) {
      return {
        kind: "deferred",
        code: CSV_RECOVERY_DEFERRED_PROCESS_IDENTITY_UNPROVEN,
      };
    }
    if (!processStartTokensMatch(owner.processStart, observed.processStart)) {
      return { kind: "proven_dead" };
    }
    if (
      isCoarseProcessStartToken(owner.processStart) ||
      isCoarseProcessStartToken(observed.processStart)
    ) {
      // `ps lstart` is only second-resolution on macOS. Equal tokens cannot
      // distinguish the original owner from a PID reused within that second,
      // so recovery remains fenced instead of treating the identity as exact.
      return {
        kind: "deferred",
        code: CSV_RECOVERY_DEFERRED_PROCESS_IDENTITY_COARSE,
      };
    }
    return { kind: "deferred", code: CSV_RECOVERY_DEFERRED_OWNER_ALIVE };
  }

  getItem(jobId: string, itemId: string): CsvAgentJobItem | null {
    const row = this.driver
      .prepareState<[string, string], ItemRow>(
        `SELECT item.* FROM csv_agent_job_items AS item
         JOIN csv_agent_jobs AS job ON job.id = item.job_id
         WHERE item.job_id = ? AND item.item_id = ?
           AND job.import_state = 'visible' AND job.retired_at IS NULL`,
      )
      .get(jobId, itemId);
    return row === undefined ? null : decodeItem(row);
  }

  /**
   * Read one bounded operator-review projection without touching imported-row
   * or result-blob columns. A visible non-review item is returned with no
   * reviewStatus so the public boundary can distinguish it from a missing row.
   */
  getReviewProjection(
    jobId: string,
    itemId: string,
  ): CsvAgentJobReviewProjection | null {
    return this.driver.transaction(() => {
      const row = this.driver
        .prepareState<[string, string], ReviewProjectionRow>(
          `SELECT ${CSV_REVIEW_BASE_PROJECTION_COLUMNS},
                  ${CSV_REVIEW_DETAIL_EVIDENCE_COLUMNS}
           FROM csv_agent_job_items AS item
           JOIN csv_agent_jobs AS job ON job.id = item.job_id
           WHERE item.job_id = ? AND item.item_id = ?
             AND job.import_state = 'visible' AND job.retired_at IS NULL`,
        )
        .get(jobId, itemId);
      return row === undefined
        ? null
        : projectReviewRow(row, (projectedJobId, projectedItemId, bytes) =>
            this.digestReviewSourceId(projectedJobId, projectedItemId, bytes),
          );
    });
  }

  /**
   * Keyset-page the rows that remain unknown outcomes. Every selected payload
   * column is capped in SQLite before it crosses into JavaScript.
   */
  listReviewProjectionsPage(opts: {
    readonly jobId: string;
    readonly cursor?: CsvJobItemCursor;
    readonly limit?: number;
  }): CsvAgentJobReviewProjectionPage {
    return this.driver.transaction(() =>
      this.listReviewProjectionsPageInSnapshot(opts),
    );
  }

  private listReviewProjectionsPageInSnapshot(opts: {
    readonly jobId: string;
    readonly cursor?: CsvJobItemCursor;
    readonly limit?: number;
  }): CsvAgentJobReviewProjectionPage {
    const limit = normalizePageLimit(opts.limit);
    const status = "unknown_outcome" as const;
    const cursor =
      opts.cursor === undefined
        ? undefined
        : decodeCsvJobItemCursor(opts.cursor, opts.jobId, status);
    if (cursor !== undefined) {
      const boundary = this.driver
        .prepareState<[string, number, string], { readonly present: number }>(
          `SELECT 1 AS present
           FROM csv_agent_job_items AS item
           JOIN csv_agent_jobs AS job ON job.id = item.job_id
           WHERE item.job_id = ? AND item.row_index = ? AND item.item_id = ?
             AND item.status = 'unknown_outcome'
             AND item.review_status IS NOT NULL
             AND job.import_state = 'visible' AND job.retired_at IS NULL`,
        )
        .get(opts.jobId, cursor.rowIndex, cursor.itemId);
      if (boundary === undefined) {
        throw new Error("invalid or stale CSV item page cursor");
      }
    }
    const cursorPredicate =
      cursor === undefined
        ? ""
        : `AND (item.row_index > ? OR
                    (item.row_index = ? AND item.item_id > ?))`;
    const binds: unknown[] = [opts.jobId];
    if (cursor !== undefined) {
      binds.push(cursor.rowIndex, cursor.rowIndex, cursor.itemId);
    }
    binds.push(limit + 1);
    const rows = this.driver
      .prepareState<unknown[], ReviewListProjectionRow>(
        `SELECT ${CSV_REVIEW_BASE_PROJECTION_COLUMNS}
         FROM csv_agent_job_items AS item
         JOIN csv_agent_jobs AS job ON job.id = item.job_id
         WHERE item.job_id = ? AND item.status = 'unknown_outcome'
           AND item.review_status IS NOT NULL
           AND job.import_state = 'visible' AND job.retired_at IS NULL
           ${cursorPredicate}
         ORDER BY item.row_index ASC, item.item_id ASC LIMIT ?`,
      )
      .all(...binds);
    const reviews: CsvAgentJobReviewProjection[] = [];
    let pageBytes = Buffer.byteLength(
      JSON.stringify({
        contractVersion: CSV_JOB_CONTRACT_VERSION,
        reviews: [],
      }),
      "utf8",
    );
    let sourceDigestBytes = 0;
    for (const row of rows.slice(0, limit)) {
      const rowSourceBytes = row.source_id_bytes ?? 0;
      if (
        rowSourceBytes > CSV_REVIEW_SOURCE_ID_PROJECTION_BYTES &&
        reviews.length > 0 &&
        sourceDigestBytes + rowSourceBytes > CSV_REVIEW_SOURCE_DIGEST_PAGE_BYTES
      ) {
        break;
      }
      if (rowSourceBytes > CSV_REVIEW_SOURCE_ID_PROJECTION_BYTES) {
        sourceDigestBytes += rowSourceBytes;
      }
      const review = projectReviewListRow(
        row,
        (projectedJobId, projectedItemId, bytes) =>
          this.digestReviewSourceId(projectedJobId, projectedItemId, bytes),
      );
      const reviewBytes = Buffer.byteLength(JSON.stringify(review), "utf8") + 1;
      if (reviewBytes > CSV_MAX_ITEM_PROJECTION_BYTES) {
        throw new Error(
          `CSV review item projection is ${reviewBytes} bytes; limit is ${CSV_MAX_ITEM_PROJECTION_BYTES}`,
        );
      }
      if (pageBytes + reviewBytes > CSV_MAX_ITEM_PAGE_BYTES) {
        if (reviews.length === 0) {
          throw new Error(
            `CSV review page cannot admit its first ${reviewBytes} byte item`,
          );
        }
        break;
      }
      reviews.push(review);
      pageBytes += reviewBytes;
    }
    const hasMore = rows.length > reviews.length;
    const lastReview = reviews.at(-1);
    return {
      contractVersion: CSV_JOB_CONTRACT_VERSION,
      reviews,
      ...(hasMore && lastReview !== undefined
        ? {
            nextCursor: encodeCsvJobItemCursor({
              jobId: opts.jobId,
              status,
              rowIndex: lastReview.rowIndex,
              itemId: lastReview.itemId,
            }),
          }
        : {}),
    };
  }

  private digestReviewSourceId(
    jobId: string,
    itemId: string,
    expectedBytes: number,
  ): string {
    if (
      !Number.isSafeInteger(expectedBytes) ||
      expectedBytes <= CSV_REVIEW_SOURCE_ID_PROJECTION_BYTES ||
      expectedBytes > CSV_MAX_FIELD_BYTES
    ) {
      throw new Error("CSV review source id digest length is invalid");
    }
    const digest = createHash("sha256");
    const readChunk = this.driver.prepareState<
      [number, number, string, string],
      {
        readonly source_id_chunk: Uint8Array | null;
        readonly source_id_bytes: number | null;
      }
    >(
      `SELECT substr(CAST(item.source_id AS BLOB), ?, ?)
                AS source_id_chunk,
              length(CAST(item.source_id AS BLOB)) AS source_id_bytes
       FROM csv_agent_job_items AS item
       JOIN csv_agent_jobs AS job ON job.id = item.job_id
       WHERE item.job_id = ? AND item.item_id = ?
         AND job.import_state = 'visible' AND job.retired_at IS NULL`,
    );
    for (let offset = 0; offset < expectedBytes;) {
      const chunkBytes = Math.min(
        CSV_RESULT_BLOB_CHUNK_BYTES,
        expectedBytes - offset,
      );
      const row = readChunk.get(offset + 1, chunkBytes, jobId, itemId);
      if (
        row?.source_id_chunk === null ||
        row?.source_id_chunk === undefined ||
        row.source_id_bytes !== expectedBytes ||
        row.source_id_chunk.byteLength !== chunkBytes
      ) {
        throw new Error("CSV review source id changed during projection");
      }
      digest.update(row.source_id_chunk);
      offset += chunkBytes;
    }
    return digest.digest("hex");
  }

  listItems(opts: {
    readonly jobId: string;
    readonly status?: CsvAgentJobItemStatus;
    readonly limit?: number;
  }): ReadonlyArray<CsvAgentJobItem> {
    const limit = Math.min(opts.limit ?? CSV_MAX_ROWS, CSV_MAX_ROWS);
    const where = [
      "item.job_id = ?",
      "job.import_state = 'visible'",
      "job.retired_at IS NULL",
    ];
    const binds: unknown[] = [opts.jobId];
    if (opts.status !== undefined) {
      where.push("item.status = ?");
      binds.push(opts.status);
    }
    binds.push(limit);
    return this.driver
      .prepareState<unknown[], ItemRow>(
        `SELECT item.* FROM csv_agent_job_items AS item
         JOIN csv_agent_jobs AS job ON job.id = item.job_id
         WHERE ${where.join(" AND ")}
         ORDER BY item.row_index ASC, item.item_id ASC LIMIT ?`,
      )
      .all(...binds)
      .map(decodeItem);
  }

  listItemsPage(opts: {
    readonly jobId: string;
    readonly status?: CsvAgentJobItemStatus;
    readonly cursor?: CsvJobItemCursor;
    readonly limit?: number;
  }): CsvAgentJobItemPage {
    const limit = normalizePageLimit(opts.limit);
    const cursor =
      opts.cursor === undefined
        ? undefined
        : decodeCsvJobItemCursor(opts.cursor, opts.jobId, opts.status);
    if (cursor !== undefined) {
      const cursorWhere = [
        "item.job_id = ?",
        "item.row_index = ?",
        "item.item_id = ?",
        "job.import_state = 'visible'",
        "job.retired_at IS NULL",
      ];
      const cursorBinds: unknown[] = [
        opts.jobId,
        cursor.rowIndex,
        cursor.itemId,
      ];
      if (opts.status !== undefined) {
        cursorWhere.push("item.status = ?");
        cursorBinds.push(opts.status);
      }
      const boundary = this.driver
        .prepareState<unknown[], { readonly present: number }>(
          `SELECT 1 AS present
           FROM csv_agent_job_items AS item
           JOIN csv_agent_jobs AS job ON job.id = item.job_id
           WHERE ${cursorWhere.join(" AND ")}`,
        )
        .get(...cursorBinds);
      if (boundary === undefined) {
        throw new Error("invalid or stale CSV item page cursor");
      }
    }
    const where = [
      "item.job_id = ?",
      "job.import_state = 'visible'",
      "job.retired_at IS NULL",
    ];
    const binds: unknown[] = [opts.jobId];
    if (opts.status !== undefined) {
      where.push("item.status = ?");
      binds.push(opts.status);
    }
    if (cursor !== undefined) {
      where.push(
        "(item.row_index > ? OR (item.row_index = ? AND item.item_id > ?))",
      );
      binds.push(cursor.rowIndex, cursor.rowIndex, cursor.itemId);
    }
    binds.push(limit + 1);
    const rows = this.driver
      .prepareState<
        unknown[],
        Pick<
          ItemRow,
          | "item_id"
          | "row_index"
          | "source_id"
          | "status"
          | "attempt_count"
          | "result_availability"
          | "result_size_bytes"
          | "result_digest"
          | "result_json"
          | "last_error"
          | "review_status"
          | "review_reason"
        >
      >(
        `SELECT item.item_id, item.row_index, item.source_id, item.status,
                item.attempt_count, item.result_availability,
                item.result_size_bytes, item.result_digest,
                substr(item.result_json, 1, ${CSV_MAX_RESULT_PREVIEW_BYTES + 1})
                  AS result_json,
                item.last_error,
                item.review_status, item.review_reason
         FROM csv_agent_job_items AS item
         JOIN csv_agent_jobs AS job ON job.id = item.job_id
         WHERE ${where.join(" AND ")}
         ORDER BY item.row_index ASC, item.item_id ASC LIMIT ?`,
      )
      .all(...binds);
    const projected: CsvAgentJobItemSummary[] = [];
    let pageBytes = Buffer.byteLength(
      JSON.stringify({ contractVersion: CSV_JOB_CONTRACT_VERSION, items: [] }),
      "utf8",
    );
    for (const row of rows.slice(0, limit)) {
      const item = projectItemSummary(row);
      const itemBytes = Buffer.byteLength(JSON.stringify(item), "utf8") + 1;
      if (
        projected.length > 0 &&
        pageBytes + itemBytes > CSV_MAX_ITEM_PAGE_BYTES
      ) {
        break;
      }
      projected.push(item);
      pageBytes += itemBytes;
    }
    const hasMore = rows.length > projected.length;
    const lastRow =
      projected.length === 0 ? undefined : rows[projected.length - 1];
    return {
      contractVersion: CSV_JOB_CONTRACT_VERSION,
      items: projected,
      ...(hasMore && lastRow !== undefined
        ? {
            nextCursor: encodeCsvJobItemCursor({
              jobId: opts.jobId,
              ...(opts.status !== undefined ? { status: opts.status } : {}),
              rowIndex: lastRow.row_index,
              itemId: lastRow.item_id,
            }),
          }
        : {}),
    };
  }

  getSummary(jobId: string): CsvAgentJobSummary | null {
    const job = this.getJob(jobId);
    if (job === null) return null;
    const availability = this.driver
      .prepareState<
        [string],
        {
          available: number;
          unavailable: number;
          not_produced: number;
          review_pending: number;
        }
      >(
        `SELECT
           SUM(result_availability = 'available') AS available,
           SUM(result_availability = 'unavailable_after_review') AS unavailable,
           SUM(result_availability = 'not_produced') AS not_produced,
           SUM(review_status = 'pending') AS review_pending
         FROM csv_agent_job_items WHERE job_id = ?`,
      )
      .get(jobId);
    return {
      contractVersion: CSV_JOB_CONTRACT_VERSION,
      jobId,
      status: job.status,
      totalItems: job.totalItems,
      pendingItems: job.pendingItems,
      runningItems: job.runningItems,
      completedItems: job.completedItems,
      failedItems: job.failedItems,
      cancelledItems: job.cancelledItems,
      unknownOutcomeItems: job.unknownOutcomeItems,
      reviewPendingItems: availability?.review_pending ?? 0,
      resultBytes: job.resultBytes,
      availableResults: availability?.available ?? 0,
      unavailableAfterReviewResults: availability?.unavailable ?? 0,
      notProducedResults: availability?.not_produced ?? 0,
    };
  }

  readResultBlob(opts: {
    readonly jobId: string;
    readonly itemId: string;
    readonly byteOffset?: number;
    readonly maxBytes?: number;
  }): CsvResultBlobChunk | null {
    const offset = opts.byteOffset ?? 0;
    const maxBytes = Math.min(
      opts.maxBytes ?? CSV_RESULT_BLOB_CHUNK_BYTES,
      CSV_RESULT_BLOB_CHUNK_BYTES,
    );
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new Error("CSV result byteOffset must be a non-negative integer");
    }
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new Error("CSV result maxBytes must be a positive integer");
    }
    const row = this.driver
      .prepareState<[string, string], ResultBlobRow>(
        `SELECT item.item_id, item.result_json, item.result_availability,
                item.result_size_bytes, item.result_digest
         FROM csv_agent_job_items AS item
         JOIN csv_agent_jobs AS job ON job.id = item.job_id
         WHERE item.job_id = ? AND item.item_id = ?
           AND job.import_state = 'visible' AND job.retired_at IS NULL`,
      )
      .get(opts.jobId, opts.itemId);
    if (row === undefined) return null;
    const availability = parseResultAvailability(row.result_availability);
    const bytes = Buffer.from(row.result_json ?? "", "utf8");
    const end = Math.min(bytes.byteLength, offset + maxBytes);
    const chunk =
      offset >= bytes.byteLength
        ? Buffer.alloc(0)
        : bytes.subarray(offset, end);
    return {
      contractVersion: CSV_JOB_CONTRACT_VERSION,
      itemId: row.item_id,
      availability,
      totalBytes: row.result_size_bytes,
      ...(row.result_digest !== null ? { digest: row.result_digest } : {}),
      byteOffset: offset,
      dataBase64: chunk.toString("base64"),
      ...(end < bytes.byteLength ? { nextByteOffset: end } : {}),
    };
  }

  private itemResultReservation(jobId: string, itemId: string): number {
    return (
      this.driver
        .prepareState<
          [string, string],
          { readonly result_reserved_bytes: number }
        >(
          `SELECT result_reserved_bytes FROM csv_agent_job_items
           WHERE job_id = ? AND item_id = ?`,
        )
        .get(jobId, itemId)?.result_reserved_bytes ?? 0
    );
  }

  private releaseResultReservation(
    jobId: string,
    reservedBytes: number,
    now: number,
  ): void {
    if (reservedBytes === 0) return;
    const jobRelease = this.driver
      .prepareState(
        `UPDATE csv_agent_jobs SET
           result_reserved_bytes = result_reserved_bytes - ?
         WHERE id = ? AND result_reserved_bytes >= ?`,
      )
      .run(reservedBytes, jobId, reservedBytes);
    const globalRelease = this.driver
      .prepareState(
        `UPDATE csv_storage_quota SET
           result_reserved_bytes = result_reserved_bytes - ?, updated_at = ?
         WHERE singleton = 1 AND result_reserved_bytes >= ?`,
      )
      .run(reservedBytes, now, reservedBytes);
    if (jobRelease.changes !== 1 || globalRelease.changes !== 1) {
      throw new Error("CSV result reservation accounting is inconsistent");
    }
  }

  private assertResultReservationCanRelease(
    jobId: string,
    reservedBytes: number,
  ): void {
    if (reservedBytes === 0) return;
    const job = this.getJob(jobId);
    const quota = this.getQuota();
    if (
      job === null ||
      job.resultReservedBytes < reservedBytes ||
      quota.result_reserved_bytes < reservedBytes
    ) {
      throw new Error("CSV result reservation accounting is inconsistent");
    }
  }

  private assertJobItemStatusAccountingConsistent(jobId: string): void {
    const job = this.getJob(jobId);
    if (job === null) throw new Error(`unknown CSV job ${jobId}`);
    const actual = this.driver
      .prepareState<[string], CsvJobItemStatusAccounting>(
        `SELECT
           SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending_items,
           SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running_items,
           SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed_items,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_items,
           SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled_items,
           SUM(CASE WHEN status = 'unknown_outcome' THEN 1 ELSE 0 END)
             AS unknown_outcome_items
         FROM csv_agent_job_items WHERE job_id = ?`,
      )
      .get(jobId);
    if (
      actual === undefined ||
      actual.unknown_outcome_items < 1 ||
      actual.pending_items !== job.pendingItems ||
      actual.running_items !== job.runningItems ||
      actual.completed_items !== job.completedItems ||
      actual.failed_items !== job.failedItems ||
      actual.cancelled_items !== job.cancelledItems ||
      actual.unknown_outcome_items !== job.unknownOutcomeItems
    ) {
      throw new Error("CSV job item status accounting is inconsistent");
    }
  }

  markItemRunning(jobId: string, itemId: string): void {
    this.beginItemDispatch(jobId, itemId, {});
  }

  markItemRunningWithThread(
    jobId: string,
    itemId: string,
    threadId: string,
  ): void {
    this.beginItemDispatch(jobId, itemId, {});
    this.acknowledgeItemDispatch(jobId, itemId, { threadId });
  }

  beginItemDispatch(
    jobId: string,
    itemId: string,
    evidence: CsvDispatchEvidence,
  ): void {
    const idempotentEvidence =
      evidence.idempotencyProfile !== undefined ||
      evidence.idempotencyProfileVersion !== undefined ||
      evidence.operationKey !== undefined;
    if (
      idempotentEvidence &&
      (evidence.idempotencyProfile === undefined ||
        evidence.idempotencyProfileVersion === undefined ||
        evidence.operationKey === undefined)
    ) {
      throw new Error("CSV idempotency dispatch evidence must be complete");
    }
    const now = nowSeconds();
    this.driver.transactionImmediate(() => {
      const job = this.getJob(jobId);
      if (job === null || !["pending", "running"].includes(job.status)) {
        throw new Error(`CSV item ${jobId}/${itemId} is not dispatchable`);
      }
      const quota = this.getQuota();
      assertQuota(
        quota.result_blob_bytes + quota.result_reserved_bytes,
        job.maxResultBytes,
        CSV_MAX_RESULT_BLOB_BYTES_GLOBAL,
        "result blob byte",
      );
      assertQuota(
        job.resultBytes + job.resultReservedBytes,
        job.maxResultBytes,
        job.maxResultBytesPerJob,
        "per-job result byte",
      );
      assertQuota(
        quota.durable_bytes + quota.result_reserved_bytes,
        job.maxResultBytes,
        CSV_MAX_DURABLE_BYTES,
        "durable byte",
      );
      const result = this.driver
        .prepareState(
          `UPDATE csv_agent_job_items SET
             status = 'running', dispatch_state = 'dispatching',
             assigned_thread_id = NULL, attempt_count = attempt_count + 1,
             effect_run_id = ?, effect_step_id = ?, effect_epoch = ?,
             execution_semantics = ?,
             idempotency_profile = ?, idempotency_profile_version = ?,
             operation_key = ?, provider_acknowledged_key = NULL,
             lookup_evidence_json = NULL, completed_at = NULL,
             reported_at = NULL, updated_at = ?, last_error = NULL,
             result_reserved_bytes = ?
           WHERE job_id = ? AND item_id = ? AND status = 'pending'
             AND result_reserved_bytes = 0
             AND EXISTS (
               SELECT 1 FROM csv_agent_jobs AS job
               WHERE job.id = csv_agent_job_items.job_id
                 AND job.import_state = 'visible'
                 AND job.retired_at IS NULL
                 AND job.status IN ('pending', 'running')
             )`,
        )
        .run(
          evidence.effect?.runId ?? null,
          evidence.effect?.stepId ?? null,
          evidence.effect?.epoch ?? null,
          idempotentEvidence ? "idempotent_with_key" : "at_most_once",
          evidence.idempotencyProfile ?? null,
          evidence.idempotencyProfileVersion ?? null,
          evidence.operationKey ?? null,
          now,
          job.maxResultBytes,
          jobId,
          itemId,
        );
      if (result.changes !== 1) {
        throw new Error(`CSV item ${jobId}/${itemId} is not dispatchable`);
      }
      const jobReservation = this.driver
        .prepareState(
          `UPDATE csv_agent_jobs SET
             result_reserved_bytes = result_reserved_bytes + ?
           WHERE id = ?`,
        )
        .run(job.maxResultBytes, jobId);
      const globalReservation = this.driver
        .prepareState(
          `UPDATE csv_storage_quota SET
             result_reserved_bytes = result_reserved_bytes + ?, updated_at = ?
           WHERE singleton = 1`,
        )
        .run(job.maxResultBytes, now);
      if (jobReservation.changes !== 1 || globalReservation.changes !== 1) {
        throw new Error("CSV result reservation accounting is inconsistent");
      }
    });
  }

  acknowledgeItemDispatch(
    jobId: string,
    itemId: string,
    acknowledgement: CsvDispatchAcknowledgement,
  ): void {
    const now = nowSeconds();
    const result = this.driver
      .prepareState(
        `UPDATE csv_agent_job_items SET
           dispatch_state = 'acknowledged', assigned_thread_id = ?,
           provider_acknowledged_key = ?,
           effect_run_id = COALESCE(?, effect_run_id),
           effect_step_id = COALESCE(?, effect_step_id),
           effect_epoch = COALESCE(?, effect_epoch), updated_at = ?
         WHERE job_id = ? AND item_id = ? AND status = 'running'
           AND dispatch_state = 'dispatching'
           AND (? IS NULL OR operation_key = ?)`,
      )
      .run(
        acknowledgement.threadId ?? null,
        acknowledgement.providerAcknowledgedKey ?? null,
        acknowledgement.effect?.runId ?? null,
        acknowledgement.effect?.stepId ?? null,
        acknowledgement.effect?.epoch ?? null,
        now,
        jobId,
        itemId,
        acknowledgement.providerAcknowledgedKey ?? null,
        acknowledgement.providerAcknowledgedKey ?? null,
      );
    if (result.changes !== 1) {
      throw new Error(
        `CSV item ${jobId}/${itemId} dispatch acknowledgement failed`,
      );
    }
  }

  setItemThread(jobId: string, itemId: string, threadId: string): void {
    this.acknowledgeItemDispatch(jobId, itemId, { threadId });
  }

  markItemPending(
    jobId: string,
    itemId: string,
    lookupEvidence?: Record<string, unknown>,
  ): void {
    const now = nowSeconds();
    this.driver.transactionImmediate(() => {
      const reservation = this.itemResultReservation(jobId, itemId);
      const result = this.driver
        .prepareState(
          `UPDATE csv_agent_job_items SET
             status = 'pending', dispatch_state = 'not_dispatched',
             assigned_thread_id = NULL, lookup_evidence_json = ?,
             result_reserved_bytes = 0,
             updated_at = ?, completed_at = NULL
           WHERE job_id = ? AND item_id = ?
             AND status IN ('pending', 'running')`,
        )
        .run(
          lookupEvidence === undefined ? null : JSON.stringify(lookupEvidence),
          now,
          jobId,
          itemId,
        );
      if (result.changes !== 1) {
        throw new Error(`CSV item ${jobId}/${itemId} cannot return to pending`);
      }
      this.releaseResultReservation(jobId, reservation, now);
    });
  }

  markItemCompleted(
    jobId: string,
    itemId: string,
    result: Record<string, unknown>,
  ): void {
    const canonical = canonicalizeCsvResult(result);
    this.persistCanonicalResult(jobId, itemId, canonical, true, "running");
  }

  markItemCompletedValidated(
    jobId: string,
    itemId: string,
    validated: ValidatedCsvResult,
    expectedStatus: "running" | "unknown_outcome" = "running",
  ): void {
    this.driver.transactionImmediate(() => {
      const plan = this.preflightValidatedResultPersistence(
        jobId,
        itemId,
        validated,
        expectedStatus,
      );
      validated.consumeFor(jobId, itemId, plan.schemaDigest);
      this.applyCanonicalResult(
        jobId,
        itemId,
        plan.canonical,
        plan.previous,
        expectedStatus,
      );
    });
  }

  private preflightValidatedResultPersistence(
    jobId: string,
    itemId: string,
    validated: ValidatedCsvResult,
    expectedStatus: "running" | "unknown_outcome",
  ): ValidatedCsvResultPersistencePlan {
    const job = this.getJob(jobId);
    if (job === null) throw new Error(`unknown CSV job ${jobId}`);
    const canonical = validated.assertFor(
      jobId,
      itemId,
      job.outputSchemaDigest,
    );
    return {
      canonical,
      schemaDigest: job.outputSchemaDigest,
      previous: this.assertCanonicalResultCanPersist(
        jobId,
        itemId,
        canonical,
        false,
        expectedStatus,
      ),
    };
  }

  private persistCanonicalResult(
    jobId: string,
    itemId: string,
    canonical: CanonicalCsvResult,
    validateSchema: boolean,
    expectedStatus: "running" | "unknown_outcome",
  ): void {
    this.driver.transactionImmediate(() => {
      const previous = this.assertCanonicalResultCanPersist(
        jobId,
        itemId,
        canonical,
        validateSchema,
        expectedStatus,
      );
      this.applyCanonicalResult(
        jobId,
        itemId,
        canonical,
        previous,
        expectedStatus,
      );
    });
  }

  private applyCanonicalResult(
    jobId: string,
    itemId: string,
    canonical: CanonicalCsvResult,
    previous: CsvResultPersistenceAccounting,
    expectedStatus: "running" | "unknown_outcome",
  ): void {
    const now = nowSeconds();
    const update = this.driver
      .prepareState(
        `UPDATE csv_agent_job_items SET
           status = 'completed', dispatch_state = 'settled', result_json = ?,
           result_digest = ?, result_availability = 'available',
           result_size_bytes = ?, result_reserved_bytes = 0,
           completed_at = ?, reported_at = ?,
           updated_at = ?, last_error = NULL
         WHERE job_id = ? AND item_id = ?
           AND status = ?`,
      )
      .run(
        canonical.json,
        canonical.digest,
        canonical.bytes,
        now,
        now,
        now,
        jobId,
        itemId,
        expectedStatus,
      );
    if (update.changes !== 1) {
      throw new Error(`CSV item ${jobId}/${itemId} cannot be completed`);
    }
    const jobAccounting = this.driver
      .prepareState(
        `UPDATE csv_agent_jobs SET
           result_reserved_bytes = result_reserved_bytes - ?,
           durable_bytes = durable_bytes - ? + ?
         WHERE id = ? AND result_reserved_bytes >= ?`,
      )
      .run(
        previous.result_reserved_bytes,
        previous.result_size_bytes,
        canonical.bytes,
        jobId,
        previous.result_reserved_bytes,
      );
    const globalAccounting = this.driver
      .prepareState(
        `UPDATE csv_storage_quota SET
           result_reserved_bytes = result_reserved_bytes - ?,
           result_blob_bytes = result_blob_bytes - ? + ?,
           durable_bytes = durable_bytes - ? + ?, updated_at = ?
         WHERE singleton = 1 AND result_reserved_bytes >= ?`,
      )
      .run(
        previous.result_reserved_bytes,
        previous.result_size_bytes,
        canonical.bytes,
        previous.result_size_bytes,
        canonical.bytes,
        now,
        previous.result_reserved_bytes,
      );
    if (jobAccounting.changes !== 1 || globalAccounting.changes !== 1) {
      throw new Error("CSV result persistence accounting is inconsistent");
    }
  }

  private assertCanonicalResultCanPersist(
    jobId: string,
    itemId: string,
    canonical: CanonicalCsvResult,
    validateSchema: boolean,
    expectedStatus: "running" | "unknown_outcome",
  ): CsvResultPersistenceAccounting {
    const job = this.getJob(jobId);
    if (job === null) throw new Error(`unknown CSV job ${jobId}`);
    if (canonical.bytes > job.maxResultBytes) {
      throw new Error(
        `CSV item result is ${canonical.bytes} bytes; limit is ${job.maxResultBytes}`,
      );
    }
    if (validateSchema) {
      const schemaViolation = compileCsvOutputSchema(
        job.outputSchema,
      )?.validate(canonical.value);
      if (schemaViolation !== undefined && schemaViolation !== null) {
        throw new Error(schemaViolation);
      }
    }
    const previous = this.driver
      .prepareState<
        [string, string, "running" | "unknown_outcome"],
        {
          readonly result_size_bytes: number;
          readonly result_reserved_bytes: number;
        }
      >(
        `SELECT item.result_size_bytes, item.result_reserved_bytes
         FROM csv_agent_job_items AS item
         JOIN csv_agent_jobs AS job ON job.id = item.job_id
         WHERE item.job_id = ? AND item.item_id = ?
           AND item.status = ?
           AND job.import_state = 'visible' AND job.retired_at IS NULL`,
      )
      .get(jobId, itemId, expectedStatus);
    if (previous === undefined) {
      throw new Error(`CSV item ${jobId}/${itemId} cannot be completed`);
    }
    const nextJobResultBytes =
      job.resultBytes - previous.result_size_bytes + canonical.bytes;
    if (nextJobResultBytes > job.maxResultBytesPerJob) {
      throw new Error(
        `CSV job result bytes would be ${nextJobResultBytes}; limit is ${job.maxResultBytesPerJob}`,
      );
    }
    const quota = this.getQuota();
    if (
      job.resultReservedBytes < previous.result_reserved_bytes ||
      quota.result_reserved_bytes < previous.result_reserved_bytes
    ) {
      throw new Error("CSV result persistence accounting is inconsistent");
    }
    const nextGlobalResultBytes =
      quota.result_blob_bytes +
      quota.result_reserved_bytes -
      previous.result_reserved_bytes -
      previous.result_size_bytes +
      canonical.bytes;
    if (nextGlobalResultBytes > CSV_MAX_RESULT_BLOB_BYTES_GLOBAL) {
      throw new CsvStorageQuotaError(
        "result blob byte",
        CSV_MAX_RESULT_BLOB_BYTES_GLOBAL,
      );
    }
    const nextGlobalDurableBytes =
      quota.durable_bytes +
      quota.result_reserved_bytes -
      previous.result_reserved_bytes -
      previous.result_size_bytes +
      canonical.bytes;
    if (nextGlobalDurableBytes > CSV_MAX_DURABLE_BYTES) {
      throw new CsvStorageQuotaError("durable byte", CSV_MAX_DURABLE_BYTES);
    }
    return previous;
  }

  markItemFailed(jobId: string, itemId: string, error: string): void {
    const now = nowSeconds();
    this.driver.transactionImmediate(() => {
      const reservation = this.itemResultReservation(jobId, itemId);
      const update = this.driver
        .prepareState(
          `UPDATE csv_agent_job_items SET
             status = 'failed', dispatch_state = 'settled', last_error = ?,
             result_reserved_bytes = 0,
             completed_at = ?, reported_at = ?, updated_at = ?
           WHERE job_id = ? AND item_id = ?
             AND status IN ('pending', 'running')`,
        )
        .run(
          truncateUtf8(error, CSV_ITEM_TEXT_PROJECTION_BYTES * 4).value,
          now,
          now,
          now,
          jobId,
          itemId,
        );
      if (update.changes !== 1) {
        throw new Error(`CSV item ${jobId}/${itemId} cannot be failed`);
      }
      this.releaseResultReservation(jobId, reservation, now);
    });
  }

  markItemCancelled(jobId: string, itemId: string, reason: string): void {
    const now = nowSeconds();
    this.driver.transactionImmediate(() => {
      const reservation = this.itemResultReservation(jobId, itemId);
      const update = this.driver
        .prepareState(
          `UPDATE csv_agent_job_items SET
             status = 'cancelled', dispatch_state = 'settled', last_error = ?,
             result_reserved_bytes = 0, completed_at = ?, updated_at = ?
           WHERE job_id = ? AND item_id = ?
             AND status IN ('pending', 'running')`,
        )
        .run(
          truncateUtf8(reason, CSV_ITEM_TEXT_PROJECTION_BYTES * 4).value,
          now,
          now,
          jobId,
          itemId,
        );
      if (update.changes !== 1) {
        throw new Error(`CSV item ${jobId}/${itemId} cannot be cancelled`);
      }
      this.releaseResultReservation(jobId, reservation, now);
    });
  }

  markItemUnknownOutcome(
    jobId: string,
    itemId: string,
    reason: string,
    lookupEvidence?: Record<string, unknown>,
  ): void {
    const now = nowSeconds();
    this.driver.transactionImmediate(() => {
      const itemUpdate = this.driver
        .prepareState(
          `UPDATE csv_agent_job_items SET
             status = 'unknown_outcome', dispatch_state = 'ambiguous',
             last_error = ?, review_status = 'pending', review_reason = ?,
             review_disposition = NULL, review_domain_action = NULL,
             review_evidence_json = NULL, lookup_evidence_json = ?,
             completed_at = NULL, updated_at = ?
           WHERE job_id = ? AND item_id = ? AND status = 'running'`,
        )
        .run(
          reason,
          reason,
          lookupEvidence !== undefined ? JSON.stringify(lookupEvidence) : null,
          now,
          jobId,
          itemId,
        );
      if (itemUpdate.changes !== 1) {
        throw new Error(`CSV item ${jobId}/${itemId} cannot become ambiguous`);
      }
      this.driver
        .prepareState(
          `INSERT INTO csv_agent_job_review_history (
             job_id, item_id, review_status, disposition, domain_action,
             actor, reason, evidence_json, effect_run_id, effect_step_id,
             effect_epoch, created_at
           )
           SELECT job_id, item_id, 'pending', NULL, NULL,
                  'agenc_runtime', ?, ?, effect_run_id, effect_step_id,
                  effect_epoch, ?
           FROM csv_agent_job_items WHERE job_id = ? AND item_id = ?`,
        )
        .run(
          truncateUtf8(reason, CSV_ITEM_TEXT_PROJECTION_BYTES * 4).value,
          lookupEvidence !== undefined ? JSON.stringify(lookupEvidence) : null,
          now,
          jobId,
          itemId,
        );
      const jobUpdate = this.driver
        .prepareState(
          `UPDATE csv_agent_jobs SET last_error = ?, updated_at = ?
           WHERE id = ? AND import_state = 'visible' AND retired_at IS NULL`,
        )
        .run(
          truncateUtf8(reason, CSV_ITEM_TEXT_PROJECTION_BYTES * 4).value,
          now,
          jobId,
        );
      if (jobUpdate.changes !== 1) {
        throw new Error(`CSV job ${jobId} cannot enter review`);
      }
      this.refreshJobOutcome(jobId);
    });
  }

  async resolveUnknownOutcome(
    resolution: CsvUnknownOutcomeResolution,
    options: CsvResolveUnknownOutcomeOptions = {},
  ): Promise<void> {
    options.signal?.throwIfAborted();
    const valid =
      (resolution.disposition === "confirmed_committed" &&
        resolution.domainAction === "mark_completed") ||
      (resolution.disposition === "confirmed_no_effect" &&
        resolution.domainAction === "retry_new_attempt") ||
      (resolution.disposition === "remains_unknown" &&
        resolution.domainAction === "abandon_item");
    if (!valid) throw new Error("invalid CSV review disposition/domain action");
    if (
      resolution.result !== undefined &&
      !(
        resolution.disposition === "confirmed_committed" &&
        resolution.domainAction === "mark_completed"
      )
    ) {
      throw new Error(
        "CSV review result is only valid for confirmed committed completion",
      );
    }
    requireNonempty(resolution.actor.trim(), "CSV review actor");
    requireNonempty(resolution.reason.trim(), "CSV review reason");
    const requestedEvidence = canonicalizeCsvResult(resolution.evidence);
    const initialItem = this.getItem(resolution.jobId, resolution.itemId);
    if (
      initialItem === null ||
      initialItem.status !== "unknown_outcome" ||
      initialItem.reviewStatus !== "pending"
    ) {
      throw new Error(
        `CSV item ${resolution.jobId}/${resolution.itemId} is not awaiting review`,
      );
    }
    let validatedResult: ValidatedCsvResult | undefined;
    if (resolution.result !== undefined) {
      const job = this.getJob(resolution.jobId);
      if (job === null) throw new Error(`unknown CSV job ${resolution.jobId}`);
      const compiledSchema = compileCsvOutputSchema(job.outputSchema);
      if (compiledSchema?.digest !== job.outputSchemaDigest) {
        throw new Error("CSV output schema digest is inconsistent");
      }
      const canonicalResult = canonicalizeCsvResult(resolution.result);
      const validation = await validateCsvResultForPersistence(
        resolution.jobId,
        resolution.itemId,
        compiledSchema,
        canonicalResult,
      );
      // Reject cancellation observed while the real validator was pending.
      options.signal?.throwIfAborted();
      if (typeof validation === "string") throw new Error(validation);
      validatedResult = validation;
      if (this.pauseAfterResultValidation !== undefined) {
        await this.pauseAfterResultValidation();
      }
      // Nothing asynchronous follows this fence. Cancellation during either
      // validation phase therefore cannot reach A1 or SQLite projection.
      options.signal?.throwIfAborted();
    }
    const now = nowSeconds();
    this.driver.transactionImmediate(() => {
      const reviewedItem = this.getItem(resolution.jobId, resolution.itemId);
      if (
        reviewedItem === null ||
        reviewedItem.status !== "unknown_outcome" ||
        reviewedItem.reviewStatus !== "pending"
      ) {
        throw new Error(
          `CSV item ${resolution.jobId}/${resolution.itemId} is not awaiting review`,
        );
      }
      const resultPlan =
        validatedResult === undefined
          ? undefined
          : this.preflightValidatedResultPersistence(
              resolution.jobId,
              resolution.itemId,
              validatedResult,
              "unknown_outcome",
            );
      const reservation = this.itemResultReservation(
        resolution.jobId,
        resolution.itemId,
      );
      if (resultPlan === undefined) {
        this.assertResultReservationCanRelease(resolution.jobId, reservation);
      }
      if (resolution.domainAction !== "abandon_item") {
        this.assertJobItemStatusAccountingConsistent(resolution.jobId);
      }
      const canonicalEffectReview = this.resolveCanonicalEffectReview(
        reviewedItem,
        resolution,
      );
      if (validatedResult !== undefined && resultPlan !== undefined) {
        validatedResult.consumeFor(
          resolution.jobId,
          resolution.itemId,
          resultPlan.schemaDigest,
        );
      }
      const evidenceJson =
        canonicalEffectReview === undefined
          ? requestedEvidence.json
          : canonicalizeCsvResult(
              canonicalEffectReview as unknown as Record<string, unknown>,
            ).json;
      let changes = 0;
      if (
        resolution.domainAction === "mark_completed" &&
        resolution.result !== undefined
      ) {
        if (resultPlan === undefined) {
          throw new Error("CSV review result has no validation token");
        }
        this.applyCanonicalResult(
          resolution.jobId,
          resolution.itemId,
          resultPlan.canonical,
          resultPlan.previous,
          "unknown_outcome",
        );
        changes = this.driver
          .prepareState(
            `UPDATE csv_agent_job_items SET review_status = 'resolved',
               review_disposition = ?, review_domain_action = ?,
               review_evidence_json = ?, updated_at = ?
             WHERE job_id = ? AND item_id = ? AND status = 'completed'
               AND review_status = 'pending'`,
          )
          .run(
            resolution.disposition,
            resolution.domainAction,
            evidenceJson,
            now,
            resolution.jobId,
            resolution.itemId,
          ).changes;
      } else if (resolution.domainAction === "mark_completed") {
        changes = this.driver
          .prepareState(
            `UPDATE csv_agent_job_items SET status = 'completed',
               dispatch_state = 'settled',
               result_availability = 'unavailable_after_review',
               result_json = NULL, result_digest = NULL, result_size_bytes = 0,
               result_reserved_bytes = 0,
               review_status = 'resolved', review_disposition = ?,
               review_domain_action = ?, review_evidence_json = ?,
               completed_at = ?, updated_at = ?
             WHERE job_id = ? AND item_id = ? AND status = 'unknown_outcome'
               AND review_status = 'pending'`,
          )
          .run(
            resolution.disposition,
            resolution.domainAction,
            evidenceJson,
            now,
            now,
            resolution.jobId,
            resolution.itemId,
          ).changes;
      } else if (resolution.domainAction === "retry_new_attempt") {
        changes = this.driver
          .prepareState(
            `UPDATE csv_agent_job_items SET status = 'pending',
               dispatch_state = 'not_dispatched', assigned_thread_id = NULL,
               result_json = NULL, result_digest = NULL,
               result_availability = 'not_produced', result_size_bytes = 0,
               result_reserved_bytes = 0,
               review_status = 'resolved', review_disposition = ?,
               review_domain_action = ?, review_evidence_json = ?,
               completed_at = NULL, updated_at = ?
             WHERE job_id = ? AND item_id = ? AND status = 'unknown_outcome'
               AND review_status = 'pending'`,
          )
          .run(
            resolution.disposition,
            resolution.domainAction,
            evidenceJson,
            now,
            resolution.jobId,
            resolution.itemId,
          ).changes;
      } else {
        changes = this.driver
          .prepareState(
            `UPDATE csv_agent_job_items SET review_status = 'abandoned',
               review_disposition = ?, review_domain_action = ?,
               review_evidence_json = ?, result_reserved_bytes = 0,
               completed_at = ?, updated_at = ?
             WHERE job_id = ? AND item_id = ? AND status = 'unknown_outcome'
               AND review_status = 'pending'`,
          )
          .run(
            resolution.disposition,
            resolution.domainAction,
            evidenceJson,
            now,
            now,
            resolution.jobId,
            resolution.itemId,
          ).changes;
      }
      if (changes !== 1) {
        throw new Error(
          `CSV item ${resolution.jobId}/${resolution.itemId} is not awaiting review`,
        );
      }
      this.driver
        .prepareState(
          `INSERT INTO csv_agent_job_review_history (
             job_id, item_id, review_status, disposition, domain_action,
             actor, reason, evidence_json, effect_run_id, effect_step_id,
             effect_epoch, created_at
           )
           SELECT job_id, item_id, ?, ?, ?, ?, ?, ?, effect_run_id,
                  effect_step_id, effect_epoch, ?
           FROM csv_agent_job_items WHERE job_id = ? AND item_id = ?`,
        )
        .run(
          resolution.domainAction === "abandon_item" ? "abandoned" : "resolved",
          resolution.disposition,
          resolution.domainAction,
          resolution.actor,
          truncateUtf8(resolution.reason, CSV_ITEM_TEXT_PROJECTION_BYTES * 4)
            .value,
          evidenceJson,
          now,
          resolution.jobId,
          resolution.itemId,
        );
      if (
        resolution.domainAction !== "mark_completed" ||
        resolution.result === undefined
      ) {
        this.releaseResultReservation(resolution.jobId, reservation, now);
      }
      this.refreshJobOutcome(resolution.jobId);
    });
  }

  /**
   * A CSV row is only a projection of A1 effect evidence. When dispatch
   * supplied a canonical effect identity, append/fsync its canonical review
   * event before advancing the CSV projection. Effectless legacy rows retain
   * their local migration review; callers cannot attach an unrelated A1
   * resolution to one after the fact.
   */
  private resolveCanonicalEffectReview(
    item: CsvAgentJobItem,
    resolution: CsvUnknownOutcomeResolution,
  ): EffectReviewResolution | undefined {
    if (item.effect === undefined) {
      if (resolution.effectReview !== undefined) {
        throw new Error("CSV review has no canonical effect identity");
      }
      return undefined;
    }
    const review = resolution.effectReview;
    if (review === undefined) {
      throw new Error("CSV review requires canonical A1 effect evidence");
    }
    const expectedWorkflowStatus =
      resolution.domainAction === "abandon_item" ? "abandoned" : "resolved";
    if (
      review.disposition !== resolution.disposition ||
      review.domainAction !== resolution.domainAction ||
      review.workflowStatus !== expectedWorkflowStatus ||
      review.actorId !== resolution.actor
    ) {
      throw new Error(
        "CSV review disagrees with canonical A1 effect resolution",
      );
    }

    const effects = new StateRunDurabilityRepository(this.driver);
    const effect = effects.getEffect(item.effect.runId, item.effect.stepId);
    if (effect === undefined || effect.epoch !== item.effect.epoch) {
      throw new Error(
        "CSV review canonical effect identity is missing or stale",
      );
    }
    if (effect.outcome !== "unknown_outcome") {
      throw new Error("CSV review canonical effect is not an unknown outcome");
    }
    const callMatches = effects
      .listEffectsBySessionCall(effect.sessionId, effect.callId)
      .filter(
        (candidate) =>
          candidate.outcome === "unknown_outcome" &&
          candidate.reviewStatus === "pending",
      );
    if (
      callMatches.length !== 1 ||
      callMatches[0]?.runId !== item.effect.runId ||
      callMatches[0]?.stepId !== item.effect.stepId ||
      callMatches[0]?.epoch !== item.effect.epoch
    ) {
      throw new Error(
        "CSV review canonical effect call identity is ambiguous or stale",
      );
    }
    const canonical = resolveDurableEffectReview(this.driver, {
      sessionId: effect.sessionId,
      toolCallId: effect.callId,
      resolution: review,
    });
    if (
      canonical.kind === "not_found" ||
      !canonical.durable ||
      canonical.runId !== item.effect.runId ||
      canonical.stepId !== item.effect.stepId
    ) {
      throw new Error("CSV review did not append canonical A1 effect evidence");
    }
    if (canonical.resolution === undefined) {
      throw new Error("CSV review canonical A1 resolution is missing");
    }
    return canonical.resolution;
  }

  getJobProgress(jobId: string): CsvAgentJobProgress {
    const job = this.getJob(jobId);
    const reviewPendingItems =
      job === null
        ? 0
        : (this.driver
            .prepareState<[string], { readonly count: number }>(
              `SELECT COUNT(*) AS count FROM csv_agent_job_items
               WHERE job_id = ? AND review_status = 'pending'`,
            )
            .get(jobId)?.count ?? 0);
    return {
      totalItems: job?.totalItems ?? 0,
      pendingItems: job?.pendingItems ?? 0,
      runningItems: job?.runningItems ?? 0,
      completedItems: job?.completedItems ?? 0,
      failedItems: job?.failedItems ?? 0,
      cancelledItems: job?.cancelledItems ?? 0,
      unknownOutcomeItems: job?.unknownOutcomeItems ?? 0,
      reviewPendingItems,
    };
  }

  refreshJobOutcome(jobId: string): CsvAgentJobStatus {
    return this.driver.transactionImmediate(() => {
      const job = this.getJob(jobId);
      if (job === null) throw new Error(`unknown CSV job ${jobId}`);
      let status: CsvAgentJobStatus;
      let completedAt: number | null = null;
      if (job.runningItems > 0 || job.pendingItems > 0) {
        status = job.startedAt === undefined ? "pending" : "running";
      } else if (job.unknownOutcomeItems > 0) {
        const pendingReviews =
          this.driver
            .prepareState<[string], { count: number }>(
              `SELECT COUNT(*) AS count FROM csv_agent_job_items
             WHERE job_id = ? AND status = 'unknown_outcome'
               AND review_status = 'pending'`,
            )
            .get(jobId)?.count ?? 0;
        status =
          pendingReviews > 0
            ? "needs_review"
            : "finished_with_unknown_outcomes";
        if (pendingReviews === 0) completedAt = nowSeconds();
      } else if (job.failedItems > 0) {
        status = "failed";
        completedAt = nowSeconds();
      } else if (job.cancelledItems > 0) {
        status = "cancelled";
        completedAt = nowSeconds();
      } else {
        status = "completed";
        completedAt = nowSeconds();
      }
      this.driver
        .prepareState(
          `UPDATE csv_agent_jobs SET status = ?, completed_at = ?, updated_at = ?
           WHERE id = ? AND import_state = 'visible' AND retired_at IS NULL`,
        )
        .run(status, completedAt, nowSeconds(), jobId);
      return status;
    });
  }
}
