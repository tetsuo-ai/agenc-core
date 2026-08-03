export const CSV_JOB_CONTRACT_VERSION = 1;
export const CSV_JOB_IDENTITY_FORMAT_VERSION = 1;

export const CSV_MAX_INPUT_BYTES = 268_435_456;
export const CSV_MAX_ROWS = 1_000_000;
export const CSV_MAX_COLUMNS = 1_024;
export const CSV_MAX_HEADER_BYTES = 262_144;
export const CSV_MAX_FIELD_BYTES = 4_194_304;
export const CSV_MAX_RECORD_BYTES = 8_388_608;
export const CSV_MAX_OUTPUT_BYTES = 536_870_912;
export const CSV_MAX_RESULT_BYTES = 1_048_576;
export const CSV_MAX_RESULT_BYTES_PER_JOB = 268_435_456;
export const CSV_DEFAULT_ITEM_PAGE_SIZE = 20;
export const CSV_MAX_ITEM_PAGE_SIZE = 100;
export const CSV_MAX_ITEM_PAGE_BYTES = 1_048_576;
export const CSV_MAX_ITEM_PROJECTION_BYTES = 8_192;
export const CSV_MAX_RESULT_PREVIEW_BYTES = 4_096;
export const CSV_MAX_JOB_SUMMARY_BYTES = 262_144;
export const CSV_RESULT_BLOB_CHUNK_BYTES = 65_536;
export const CSV_OUTPUT_CONTRACT_VERSION = 1;
export const CSV_MAX_OUTPUT_STAGING_FILES_GLOBAL = 4_096;
export const CSV_MAX_OUTPUT_STAGING_BYTES_GLOBAL = 2_147_483_648;
export const CSV_IMPORT_LEASE_SECONDS = 5 * 60;
export const CSV_IDEMPOTENCY_LOOKUP_TIMEOUT_MS = 5_000;
export const CSV_CAPACITY_RETRY_DELAY_MS = 25;
export const CSV_WORKER_RETIRE_TIMEOUT_MS = 5_000;

export const CSV_DEFAULT_MAX_CONCURRENCY = 16;
export const CSV_MAX_JOB_CONCURRENCY = 64;

export const CSV_OUTPUT_SCHEMA_CONTRACT_VERSION = 1;
export const CSV_MAX_OUTPUT_SCHEMA_BYTES = 262_144;
export const CSV_MAX_OUTPUT_SCHEMA_DEPTH = 64;
export const CSV_MAX_OUTPUT_SCHEMA_NODES = 10_000;
export const CSV_MAX_OUTPUT_SCHEMA_REF_EXPANSIONS = 10_000;
export const CSV_MAX_OUTPUT_SCHEMA_ENUM_MEMBERS = 256;
export const CSV_MAX_SCHEMA_COMPILE_MS = 1_000;
export const CSV_MAX_VALIDATION_WORKERS = 4;
export const CSV_MAX_VALIDATION_QUEUE = 4_096;
export const CSV_MAX_VALIDATION_QUEUE_BYTES = 268_435_456;
export const CSV_MAX_COMPILED_SCHEMA_CACHE_ENTRIES = 256;
export const CSV_MAX_COMPILED_SCHEMA_CACHE_BYTES = 67_108_864;
export const CSV_COMPILED_SCHEMA_CACHE_TTL_MS = 600_000;
export const CSV_MAX_RESULT_VALIDATION_BATCH = 256;
export const CSV_MAX_RESULT_VALIDATION_MS = 250;
export const CSV_MAX_RESULT_VALIDATION_CPU_MS_PER_JOB = 3_600_000;
export const CSV_MAX_RESULT_DEPTH = 64;
export const CSV_MAX_RESULT_NODES = 10_000;

export const CSV_MAX_ACTIVE_IMPORTS = 64;
export const CSV_MAX_STAGING_ROWS_GLOBAL = 4_000_000;
export const CSV_MAX_STAGING_BYTES_GLOBAL = 2_147_483_648;
export const CSV_STAGING_GC_PAGE_ROWS = 1_000;
export const CSV_MAX_STAGING_GC_MS_PER_START = 30_000;
export const CSV_MAX_DURABLE_JOBS = 100_000;
export const CSV_MAX_DURABLE_ITEMS = 10_000_000;
export const CSV_MAX_DURABLE_BYTES = 8_589_934_592;
export const CSV_MAX_RESULT_BLOB_BYTES_GLOBAL = 4_294_967_296;
export const CSV_MAX_JOB_TOMBSTONES = 1_000_000;
export const CSV_MAX_JOB_TOMBSTONE_BYTES = 1_073_741_824;
export const CSV_TERMINAL_JOB_RETENTION_MS = 2_592_000_000;
export const CSV_JOB_GC_PAGE_ITEMS = 1_000;
export const CSV_MAX_JOB_GC_MS_PER_SLICE = 30_000;

// Canonical specification spellings. Keep the CSV_* names above as the
// established runtime API while exposing the TODO/design-contract names for
// protocol mirrors, tests, and downstream packages.
export const MAX_CSV_INPUT_BYTES = CSV_MAX_INPUT_BYTES;
export const MAX_CSV_ROWS = CSV_MAX_ROWS;
export const MAX_CSV_COLUMNS = CSV_MAX_COLUMNS;
export const MAX_CSV_HEADER_UTF8_BYTES = CSV_MAX_HEADER_BYTES;
export const MAX_CSV_FIELD_UTF8_BYTES = CSV_MAX_FIELD_BYTES;
export const MAX_CSV_RECORD_UTF8_BYTES = CSV_MAX_RECORD_BYTES;
export const MAX_CSV_OUTPUT_BYTES = CSV_MAX_OUTPUT_BYTES;
export const MAX_CSV_RESULT_UTF8_BYTES = CSV_MAX_RESULT_BYTES;
export const MAX_CSV_RESULT_UTF8_BYTES_PER_JOB = CSV_MAX_RESULT_BYTES_PER_JOB;
export const DEFAULT_CSV_MAX_CONCURRENCY = CSV_DEFAULT_MAX_CONCURRENCY;
export const MAX_CSV_JOB_CONCURRENCY = CSV_MAX_JOB_CONCURRENCY;
export const MAX_CSV_OUTPUT_SCHEMA_UTF8_BYTES = CSV_MAX_OUTPUT_SCHEMA_BYTES;
export const MAX_CSV_OUTPUT_SCHEMA_DEPTH = CSV_MAX_OUTPUT_SCHEMA_DEPTH;
export const MAX_CSV_OUTPUT_SCHEMA_NODES = CSV_MAX_OUTPUT_SCHEMA_NODES;
export const MAX_CSV_OUTPUT_SCHEMA_REF_EXPANSIONS =
  CSV_MAX_OUTPUT_SCHEMA_REF_EXPANSIONS;
export const MAX_CSV_OUTPUT_SCHEMA_ENUM_MEMBERS =
  CSV_MAX_OUTPUT_SCHEMA_ENUM_MEMBERS;
export const MAX_CSV_SCHEMA_COMPILE_MS = CSV_MAX_SCHEMA_COMPILE_MS;
export const MAX_CSV_VALIDATION_WORKERS = CSV_MAX_VALIDATION_WORKERS;
export const MAX_CSV_VALIDATION_QUEUE = CSV_MAX_VALIDATION_QUEUE;
export const MAX_CSV_VALIDATION_QUEUE_BYTES = CSV_MAX_VALIDATION_QUEUE_BYTES;
export const MAX_CSV_COMPILED_SCHEMA_CACHE_ENTRIES =
  CSV_MAX_COMPILED_SCHEMA_CACHE_ENTRIES;
export const MAX_CSV_COMPILED_SCHEMA_CACHE_BYTES =
  CSV_MAX_COMPILED_SCHEMA_CACHE_BYTES;
export const MAX_CSV_RESULT_VALIDATION_BATCH = CSV_MAX_RESULT_VALIDATION_BATCH;
export const MAX_CSV_RESULT_VALIDATION_MS = CSV_MAX_RESULT_VALIDATION_MS;
export const MAX_CSV_RESULT_VALIDATION_CPU_MS_PER_JOB =
  CSV_MAX_RESULT_VALIDATION_CPU_MS_PER_JOB;
export const MAX_CSV_RESULT_DEPTH = CSV_MAX_RESULT_DEPTH;
export const MAX_CSV_RESULT_NODES = CSV_MAX_RESULT_NODES;
export const MAX_CSV_ACTIVE_IMPORTS = CSV_MAX_ACTIVE_IMPORTS;
export const MAX_CSV_STAGING_ROWS_GLOBAL = CSV_MAX_STAGING_ROWS_GLOBAL;
export const MAX_CSV_STAGING_BYTES_GLOBAL = CSV_MAX_STAGING_BYTES_GLOBAL;
export const CSV_STAGING_GC_PAGE_SIZE = CSV_STAGING_GC_PAGE_ROWS;
export const MAX_CSV_STAGING_GC_MS_PER_START = CSV_MAX_STAGING_GC_MS_PER_START;
export const MAX_CSV_DURABLE_JOBS = CSV_MAX_DURABLE_JOBS;
export const MAX_CSV_DURABLE_ITEMS = CSV_MAX_DURABLE_ITEMS;
export const MAX_CSV_DURABLE_BYTES = CSV_MAX_DURABLE_BYTES;
export const MAX_CSV_RESULT_BLOB_BYTES_GLOBAL =
  CSV_MAX_RESULT_BLOB_BYTES_GLOBAL;
export const MAX_CSV_JOB_TOMBSTONES = CSV_MAX_JOB_TOMBSTONES;
export const MAX_CSV_JOB_TOMBSTONE_BYTES = CSV_MAX_JOB_TOMBSTONE_BYTES;
export const MAX_CSV_JOB_TOMBSTONE_BYTES_GLOBAL = CSV_MAX_JOB_TOMBSTONE_BYTES;
export const MAX_CSV_JOB_GC_MS_PER_SLICE = CSV_MAX_JOB_GC_MS_PER_SLICE;
export const CSV_JOB_GC_PAGE_SIZE = CSV_JOB_GC_PAGE_ITEMS;
export const MAX_CSV_OUTPUT_STAGING_FILES_GLOBAL =
  CSV_MAX_OUTPUT_STAGING_FILES_GLOBAL;
export const MAX_CSV_OUTPUT_STAGING_BYTES_GLOBAL =
  CSV_MAX_OUTPUT_STAGING_BYTES_GLOBAL;
export const MAX_CSV_JOB_SUMMARY_UTF8_BYTES = CSV_MAX_JOB_SUMMARY_BYTES;
export const MAX_CSV_ITEM_PROJECTION_UTF8_BYTES = CSV_MAX_ITEM_PROJECTION_BYTES;
export const MAX_CSV_RESULT_PREVIEW_UTF8_BYTES = CSV_MAX_RESULT_PREVIEW_BYTES;
export const MAX_CSV_ITEM_PAGE_SIZE = CSV_MAX_ITEM_PAGE_SIZE;
export const MAX_CSV_ITEM_PAGE_UTF8_BYTES = CSV_MAX_ITEM_PAGE_BYTES;

export const CSV_RESERVED_OUTPUT_HEADERS: ReadonlySet<string> = new Set([
  "job_id",
  "item_id",
  "row_index",
  "source_id",
  "status",
  "attempt_count",
  "last_error",
  "result_json",
  "result_availability",
  "reported_at",
  "completed_at",
]);

export const CSV_AGENT_JOB_STATUSES = [
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
  "needs_review",
  "finished_with_unknown_outcomes",
] as const;
export type CsvAgentJobStatus = (typeof CSV_AGENT_JOB_STATUSES)[number];

export const CSV_AGENT_JOB_ITEM_STATUSES = [
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
  "unknown_outcome",
] as const;
export type CsvAgentJobItemStatus =
  (typeof CSV_AGENT_JOB_ITEM_STATUSES)[number];

export const CSV_RESULT_AVAILABILITIES = [
  "not_produced",
  "available",
  "unavailable_after_review",
] as const;
export type CsvResultAvailability = (typeof CSV_RESULT_AVAILABILITIES)[number];

export type CsvReviewStatus = "pending" | "resolved" | "abandoned";
export type CsvReviewDisposition =
  "confirmed_committed" | "confirmed_no_effect" | "remains_unknown";
export type CsvReviewDomainAction =
  "mark_completed" | "retry_new_attempt" | "abandon_item";

/** Opaque, scope-bound keyset continuation token for a CSV item page. */
export type CsvJobItemCursor = string;

export interface CsvJobEffectReference {
  readonly runId: string;
  readonly stepId: string;
  readonly epoch: number;
}
