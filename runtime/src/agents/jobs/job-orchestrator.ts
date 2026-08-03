/** CSV fan-out orchestration with bounded, at-most-once restart semantics. */

import { createHash, randomUUID } from "node:crypto";
import {
  CSV_CAPACITY_RETRY_DELAY_MS,
  CSV_DEFAULT_MAX_CONCURRENCY,
  CSV_DEFAULT_ITEM_PAGE_SIZE,
  CSV_IDEMPOTENCY_LOOKUP_TIMEOUT_MS,
  CSV_JOB_CONTRACT_VERSION,
  CSV_QUEUE_COMPACT_CONSUMED_RATIO,
  CSV_QUEUE_COMPACT_MIN_PREFIX,
  CSV_READY_REFILL_LOW_WATERMARK,
  CSV_RECOVERY_JOB_PAGE_SIZE,
  CSV_RECOVERY_PAGE_ROWS,
  CSV_MAX_RESULT_BYTES,
  CSV_MAX_RESULT_PREVIEW_BYTES,
  CSV_MAX_ROWS,
  CSV_MAX_JOB_CONCURRENCY,
  CSV_MAX_JOB_SUMMARY_BYTES,
  CSV_WORKER_RETIRE_TIMEOUT_MS,
  MAX_CSV_ACTIVE_WORKERS,
  MAX_CSV_JOB_REGISTRATION_HOLD_MS,
  MAX_CSV_READY_ROWS_GLOBAL,
  MAX_CSV_READY_ROWS_PER_JOB,
  MAX_CSV_SUPERVISOR_STARTUP_MS,
  MAX_RECOVERED_CSV_JOBS,
  type CsvAgentJobItemStatus,
  type CsvJobEffectReference,
  type CsvJobItemCursor,
} from "../../contracts/csv-job-contract.js";
import {
  createCsvAgentInvocationEnvelope,
  type AgentInvocationEnvelope,
} from "../../contracts/agent-invocation-envelope.js";
import {
  encodeCsvJobItemCursor,
  type CsvAgentJob,
  type CsvAgentJobItem,
  type CsvAgentJobItemSchedulerCursor,
  type CsvAgentJobImportHandle,
  type CsvAgentJobItemCreateParams,
  type CsvAgentJobItemSummary,
  type CsvAgentJobSummary,
  type CsvAgentJobsRepository,
  type CsvJobSupervisorRegistration,
  type CsvJobSupervisorRegistrationClaim,
} from "../../state/csv-agent-jobs.js";
import {
  type CsvInputRootCapability,
  deriveCsvItemIdentity,
  resolveCsvInputPath,
  scanCsvFile,
  type CsvRow,
} from "./csv-reader.js";
import {
  resolveCsvOutputPath,
  writeCsvOutput,
  type CsvOutputArtifact,
  type CsvOutputIntentStore,
  type CsvOutputMode,
  type CsvOutputRootCapability,
} from "./csv-output.js";
import {
  canonicalizeCsvResult,
  compileCsvOutputSchema,
  primeCsvOutputSchemaValidation,
  releaseCsvOutputSchemaValidation,
  validateCsvResultForPersistence,
  type CanonicalCsvResult,
  type CompiledCsvOutputSchema,
} from "./csv-schema.js";
import type { AgentCapacityPermit } from "../registry.js";

export type JobId = string;
export type ItemId = string;
export type JobItemStatus = CsvAgentJobItemStatus;

const JOB_CANCEL_POLL_MS = 250;
const CSV_IMPORT_BATCH_ROWS = 1_000;
const CSV_ITEM_TEXT_PREVIEW_BYTES = 1_024;

export interface JobItemRecord {
  readonly jobId: JobId;
  readonly itemId: ItemId;
  readonly rowIndex: number;
  readonly sourceId?: string;
  readonly contentSha256: string;
  readonly workerName: string;
  readonly row: CsvRow;
  readonly instruction: string;
  status: JobItemStatus;
  attemptCount: number;
  resultAvailability: "not_produced" | "available" | "unavailable_after_review";
  assignedThreadId?: string;
  operationKey?: string;
  result?: Record<string, unknown>;
  error?: string;
  reviewReason?: string;
  reportedAt?: Date;
  completedAt?: Date;
}

export interface JobConfig {
  readonly jobId: JobId;
  readonly instruction: string;
  readonly outputSchema?: Record<string, unknown>;
  readonly compiledOutputSchema?: CompiledCsvOutputSchema;
  readonly maxConcurrency: number;
  readonly maxRuntimeSeconds?: number;
  readonly maxResultBytes: number;
}

export interface AgentJobSpawnContext {
  readonly jobId: JobId;
  readonly itemId: ItemId;
  readonly workerName: string;
  readonly invocationEnvelope: AgentInvocationEnvelope;
  readonly row: CsvRow;
  readonly operationKey?: string;
  readonly capacityPermit?: AgentCapacityPermit;
  readonly signal?: AbortSignal;
}

export type AgentJobCapacityOutcome =
  | { readonly kind: "acquired"; readonly permit: AgentCapacityPermit }
  | { readonly kind: "capacity_unavailable"; readonly retryAfterMs?: number };

export type AgentJobSpawnOutcome =
  | {
      readonly kind: "launched";
      readonly threadId?: string;
      readonly threadFinished?: Promise<void>;
      readonly providerAcknowledgedOperationKey?: string;
      readonly effect?: CsvJobEffectReference;
    }
  | {
      readonly kind: "capacity_unavailable";
      readonly retryAfterMs?: number;
    }
  | { readonly kind: "rejected"; readonly reason: string };

export interface AgentJobSpawn {
  acquireCapacity?(ctx: {
    readonly jobId: JobId;
    readonly itemId: ItemId;
    readonly signal?: AbortSignal;
  }): Promise<AgentJobCapacityOutcome>;
  spawn(ctx: AgentJobSpawnContext): Promise<AgentJobSpawnOutcome | void>;
  cancelOutstanding(jobId: JobId): Promise<void>;
  retireItem?(jobId: JobId, itemId: ItemId, threadId: string): Promise<void>;
}

export interface AgentJobThreadOps {
  getStatus(
    threadId: string,
  ): Promise<
    | { kind: "running" | "pending_init" | "interrupted" }
    | { kind: "completed"; lastMessage?: string }
    | { kind: "errored"; reason: string }
    | { kind: "shutdown" }
    | { kind: "not_found" }
  >;
  shutdownThread(threadId: string): Promise<void>;
}

export type CsvIdempotencyLookupOutcome =
  | {
      readonly kind: "committed";
      readonly result?: Record<string, unknown>;
      readonly evidence: Record<string, unknown>;
    }
  | {
      readonly kind: "not_found";
      readonly evidence: Record<string, unknown>;
    }
  | {
      readonly kind: "unknown";
      readonly reason: string;
      readonly evidence?: Record<string, unknown>;
    };

export interface CsvIdempotencyProfile {
  readonly name: string;
  readonly version: number;
  deriveOperationKey(ctx: {
    readonly jobId: string;
    readonly itemId: string;
    readonly rowIndex: number;
    readonly contentSha256: string;
  }): string;
  lookup(ctx: {
    readonly jobId: string;
    readonly itemId: string;
    readonly operationKey: string;
    readonly signal: AbortSignal;
  }): Promise<CsvIdempotencyLookupOutcome>;
}

export interface AgentJobProgressUpdate {
  readonly jobId: JobId;
  readonly totalItems: number;
  readonly pendingItems: number;
  readonly runningItems: number;
  readonly completedItems: number;
  readonly failedItems: number;
  readonly cancelledItems: number;
  readonly unknownOutcomeItems: number;
  readonly reviewPendingItems: number;
  readonly etaSeconds?: number;
}

export type AgentJobProgressEmitter = (update: AgentJobProgressUpdate) => void;

export interface RunAgentsOnCsvOpts {
  readonly csvPath: string;
  readonly inputRootCapability: CsvInputRootCapability;
  readonly instruction: string;
  readonly idColumn?: string;
  readonly outputCsvPath?: string;
  readonly outputRootCapability?: CsvOutputRootCapability;
  readonly outputMode?: CsvOutputMode;
  readonly maxConcurrency?: number;
  readonly maxRuntimeSeconds?: number;
  readonly maxResultBytes?: number;
  readonly outputSchema?: Record<string, unknown>;
  readonly spawn: AgentJobSpawn;
  readonly repository?: CsvAgentJobsRepository;
  readonly jobName?: string;
  readonly threadOps?: AgentJobThreadOps;
  readonly progressEmitter?: AgentJobProgressEmitter;
  readonly idempotencyProfile?: CsvIdempotencyProfile;
  readonly signal?: AbortSignal;
}

export interface RunAgentsOnCsvResult {
  readonly contractVersion: typeof CSV_JOB_CONTRACT_VERSION;
  readonly jobId: JobId;
  readonly summary: CsvAgentJobSummary;
  readonly itemPage: ReadonlyArray<CsvAgentJobItemSummary>;
  readonly nextItemCursor?: CsvJobItemCursor;
  readonly stoppedEarly: boolean;
  readonly outputCsvPath?: string;
  readonly outputArtifact?: CsvOutputArtifact;
}

interface JobRuntimeState {
  readonly config: JobConfig;
  readonly items: Map<ItemId, JobItemRecord>;
  readonly pending: Map<ItemId, { resolve: () => void }>;
  readonly repository?: CsvAgentJobsRepository;
  readonly threadOps?: AgentJobThreadOps;
  readonly progress: JobProgressEmitterImpl;
  idempotencyProfile?: CsvIdempotencyProfile;
  readonly progressCounters: RuntimeProgressCounters;
  readonly signal?: AbortSignal;
  readonly preservePendingOnStop: boolean;
  counterAnomalyReconciled: boolean;
  fatalError?: unknown;
  stopRequested: boolean;
}

interface ProcessItemOutcome {
  readonly retryItemId?: ItemId;
}

interface RuntimeProgressCounters {
  totalItems: number;
  pendingItems: number;
  runningItems: number;
  completedItems: number;
  failedItems: number;
  cancelledItems: number;
  unknownOutcomeItems: number;
  reviewPendingItems: number;
}

const RUNTIME_PROGRESS_COUNTER_KEYS = [
  "totalItems",
  "pendingItems",
  "runningItems",
  "completedItems",
  "failedItems",
  "cancelledItems",
  "unknownOutcomeItems",
  "reviewPendingItems",
] as const satisfies ReadonlyArray<keyof RuntimeProgressCounters>;

class CsvRuntimeCounterIntegrityError extends Error {
  constructor() {
    super("CSV in-memory counter integrity violation");
    this.name = "CsvRuntimeCounterIntegrityError";
  }
}

/**
 * FIFO queue whose consumed prefix is compacted geometrically. Retrying an
 * item uses a small front stack instead of `Array.unshift`, so every queue
 * operation is amortized O(1) and retained storage stays proportional to live
 * entries.
 */
export class CsvJobCompactingQueue<T> {
  private readonly front: T[] = [];
  private values: T[] = [];
  private head = 0;

  get size(): number {
    return this.front.length + this.values.length - this.head;
  }

  /** Retained slots are exposed for scheduler metrics and boundedness tests. */
  get retainedSlots(): number {
    return this.front.length + this.values.length;
  }

  enqueue(value: T): void {
    this.values.push(value);
  }

  enqueueFront(value: T): void {
    this.front.push(value);
  }

  dequeue(): T | undefined {
    const priority = this.front.pop();
    if (priority !== undefined) return priority;
    if (this.head >= this.values.length) return undefined;
    const value = this.values[this.head];
    this.head += 1;
    this.compactConsumedPrefix();
    return value;
  }

  private compactConsumedPrefix(): void {
    if (this.head === this.values.length) {
      this.values = [];
      this.head = 0;
      return;
    }
    if (
      this.head < CSV_QUEUE_COMPACT_MIN_PREFIX ||
      this.head / this.values.length < CSV_QUEUE_COMPACT_CONSUMED_RATIO
    ) {
      return;
    }
    this.values = this.values.slice(this.head);
    this.head = 0;
  }
}

class JobProgressEmitterImpl {
  private readonly startedAtMs = Date.now();
  private lastEmitAtMs = 0;
  private lastProcessed = 0;
  private lastFailed = 0;
  private static readonly EMIT_INTERVAL_MS = 1_000;

  constructor(private readonly emit: AgentJobProgressEmitter | undefined) {}

  maybeEmit(
    jobId: JobId,
    progress: Omit<AgentJobProgressUpdate, "jobId" | "etaSeconds">,
    force: boolean,
  ): void {
    if (this.emit === undefined) return;
    const processed =
      progress.completedItems +
      progress.failedItems +
      progress.cancelledItems +
      progress.unknownOutcomeItems;
    const shouldEmit =
      force ||
      processed !== this.lastProcessed ||
      progress.failedItems !== this.lastFailed ||
      Date.now() - this.lastEmitAtMs >= JobProgressEmitterImpl.EMIT_INTERVAL_MS;
    if (!shouldEmit) return;
    const elapsedSeconds = (Date.now() - this.startedAtMs) / 1_000;
    const remaining = progress.pendingItems + progress.runningItems;
    const etaSeconds =
      processed > 0 && elapsedSeconds > 0
        ? Math.round(remaining / (processed / elapsedSeconds))
        : undefined;
    this.emit({
      jobId,
      ...progress,
      ...(etaSeconds !== undefined ? { etaSeconds } : {}),
    });
    this.lastEmitAtMs = Date.now();
    this.lastProcessed = processed;
    this.lastFailed = progress.failedItems;
  }
}

const jobs = new Map<JobId, JobRuntimeState>();

function freshJobId(): JobId {
  return `csv_job_${randomUUID()}`;
}

function requestedConcurrency(requested: number | undefined): number {
  const value = requested ?? CSV_DEFAULT_MAX_CONCURRENCY;
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > CSV_MAX_JOB_CONCURRENCY
  ) {
    throw new Error(
      `CSV maxConcurrency must be between 1 and ${CSV_MAX_JOB_CONCURRENCY}`,
    );
  }
  return value;
}

function requestedResultBytes(requested: number | undefined): number {
  const value = requested ?? CSV_MAX_RESULT_BYTES;
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > CSV_MAX_RESULT_BYTES
  ) {
    throw new Error(
      `CSV maxResultBytes must be between 1 and ${CSV_MAX_RESULT_BYTES}`,
    );
  }
  return value;
}

function requestedRuntimeSeconds(
  requested: number | undefined,
): number | undefined {
  if (requested === undefined) return undefined;
  if (
    !Number.isSafeInteger(requested) ||
    requested < 1 ||
    !Number.isSafeInteger(requested * 1_000)
  ) {
    throw new Error("CSV maxRuntimeSeconds must be a positive safe duration");
  }
  return requested;
}

function computeProgressSnapshot(
  state: JobRuntimeState,
): Omit<AgentJobProgressUpdate, "jobId" | "etaSeconds"> {
  if (state.repository !== undefined) {
    return state.repository.getJobProgress(state.config.jobId);
  }
  return { ...state.progressCounters };
}

function createRuntimeProgressCounters(
  items: Iterable<JobItemRecord>,
): RuntimeProgressCounters {
  const counts: RuntimeProgressCounters = {
    totalItems: 0,
    pendingItems: 0,
    runningItems: 0,
    completedItems: 0,
    failedItems: 0,
    cancelledItems: 0,
    unknownOutcomeItems: 0,
    reviewPendingItems: 0,
  };
  for (const item of items) {
    counts.totalItems += 1;
    switch (item.status) {
      case "pending":
        counts.pendingItems += 1;
        break;
      case "running":
        counts.runningItems += 1;
        break;
      case "completed":
        counts.completedItems += 1;
        break;
      case "failed":
        counts.failedItems += 1;
        break;
      case "cancelled":
        counts.cancelledItems += 1;
        break;
      case "unknown_outcome":
        counts.unknownOutcomeItems += 1;
        if (item.reviewReason !== undefined) counts.reviewPendingItems += 1;
        break;
    }
  }
  return counts;
}

function createRuntimeProgressCountersFromJob(
  job: CsvAgentJob,
): RuntimeProgressCounters {
  return {
    totalItems: job.totalItems,
    pendingItems: job.pendingItems,
    runningItems: job.runningItems,
    completedItems: job.completedItems,
    failedItems: job.failedItems,
    cancelledItems: job.cancelledItems,
    unknownOutcomeItems: job.unknownOutcomeItems,
    reviewPendingItems: job.reviewPendingItems,
  };
}

function synchronizeRuntimeProgressCounters(state: JobRuntimeState): void {
  if (state.repository === undefined) return;
  Object.assign(
    state.progressCounters,
    state.repository.getJobProgress(state.config.jobId),
  );
  assertRuntimeProgressCounters(state.progressCounters);
}

function transitionRuntimeItemStatus(
  state: JobRuntimeState,
  item: JobItemRecord,
  status: JobItemStatus,
  reviewPending = false,
): void {
  const previous = item.status;
  const previousReviewPending =
    previous === "unknown_outcome" && item.reviewReason !== undefined;
  if (previous !== status) {
    adjustStatusCounter(state.progressCounters, previous, -1);
    adjustStatusCounter(state.progressCounters, status, 1);
    item.status = status;
  }
  if (previousReviewPending !== reviewPending) {
    state.progressCounters.reviewPendingItems += reviewPending ? 1 : -1;
  }
  assertRuntimeProgressCounters(state.progressCounters);
}

function assertRuntimeItemTransition(
  state: JobRuntimeState,
  item: JobItemRecord,
  status: JobItemStatus,
  reviewPending = false,
): void {
  const projected = { ...state.progressCounters };
  const previous = item.status;
  if (previous !== status) {
    adjustStatusCounter(projected, previous, -1);
    adjustStatusCounter(projected, status, 1);
  }
  const previousReviewPending =
    previous === "unknown_outcome" && item.reviewReason !== undefined;
  if (previousReviewPending !== reviewPending) {
    projected.reviewPendingItems += reviewPending ? 1 : -1;
  }
  assertRuntimeProgressCounters(projected);
}

function assertRuntimeProgressCounters(
  counters: RuntimeProgressCounters,
): void {
  const statusTotal =
    counters.pendingItems +
    counters.runningItems +
    counters.completedItems +
    counters.failedItems +
    counters.cancelledItems +
    counters.unknownOutcomeItems;
  const values = Object.values(counters);
  if (
    values.some((value) => !Number.isSafeInteger(value) || value < 0) ||
    statusTotal !== counters.totalItems ||
    counters.reviewPendingItems > counters.unknownOutcomeItems
  ) {
    throw new CsvRuntimeCounterIntegrityError();
  }
}

function reconcileRuntimeCounterAnomalyOnce(
  state: JobRuntimeState,
  error: unknown,
): void {
  if (
    !(error instanceof CsvRuntimeCounterIntegrityError) ||
    state.counterAnomalyReconciled
  ) {
    return;
  }
  state.counterAnomalyReconciled = true;
  state.repository?.reconcileJobCounters(state.config.jobId, "anomaly");
}

function publishRuntimeFatalError(
  state: JobRuntimeState,
  error: unknown,
): void {
  reconcileRuntimeCounterAnomalyOnce(state, error);
  state.fatalError ??= error;
  for (const waiter of state.pending.values()) waiter.resolve();
  state.pending.clear();
}

function assertRuntimeCountersMatchDurable(state: JobRuntimeState): void {
  const durable = state.repository?.getJobProgress(state.config.jobId);
  if (durable === undefined) return;
  if (
    RUNTIME_PROGRESS_COUNTER_KEYS.some(
      (key) => durable[key] !== state.progressCounters[key],
    )
  ) {
    throw new CsvRuntimeCounterIntegrityError();
  }
}

function adjustStatusCounter(
  counters: RuntimeProgressCounters,
  status: JobItemStatus,
  delta: -1 | 1,
): void {
  switch (status) {
    case "pending":
      counters.pendingItems += delta;
      return;
    case "running":
      counters.runningItems += delta;
      return;
    case "completed":
      counters.completedItems += delta;
      return;
    case "failed":
      counters.failedItems += delta;
      return;
    case "cancelled":
      counters.cancelledItems += delta;
      return;
    case "unknown_outcome":
      counters.unknownOutcomeItems += delta;
  }
}

function itemSummary(item: JobItemRecord): CsvAgentJobItemSummary {
  const source =
    item.sourceId === undefined
      ? undefined
      : projectText(item.sourceId, CSV_ITEM_TEXT_PREVIEW_BYTES);
  const resultJson =
    item.result === undefined ? undefined : JSON.stringify(item.result);
  const preview =
    resultJson === undefined
      ? undefined
      : projectText(resultJson, CSV_MAX_RESULT_PREVIEW_BYTES);
  const error =
    item.error === undefined
      ? undefined
      : projectText(item.error, CSV_ITEM_TEXT_PREVIEW_BYTES);
  const reviewReason =
    item.reviewReason === undefined
      ? undefined
      : projectText(item.reviewReason, CSV_ITEM_TEXT_PREVIEW_BYTES);
  return {
    itemId: item.itemId,
    rowIndex: item.rowIndex,
    ...(source !== undefined
      ? {
          sourceId: source.value,
          ...(source.truncated
            ? { sourceIdTruncated: true, sourceIdDigest: source.digest }
            : {}),
        }
      : {}),
    status: item.status,
    attemptCount: item.attemptCount,
    resultAvailability: item.resultAvailability,
    resultSizeBytes:
      item.result === undefined ? 0 : Buffer.byteLength(resultJson!, "utf8"),
    ...(resultJson !== undefined
      ? {
          resultDigest: createHash("sha256").update(resultJson).digest("hex"),
          resultPreviewJson: preview!.value,
          ...(preview!.truncated ? { resultPreviewTruncated: true } : {}),
        }
      : {}),
    ...(error !== undefined
      ? {
          lastError: error.value,
          ...(error.truncated ? { lastErrorTruncated: true } : {}),
        }
      : {}),
    ...(reviewReason !== undefined
      ? {
          reviewStatus: "pending" as const,
          reviewReason: reviewReason.value,
          ...(reviewReason.truncated ? { reviewReasonTruncated: true } : {}),
        }
      : {}),
  };
}

function projectText(
  value: string,
  maxBytes: number,
): {
  readonly value: string;
  readonly truncated: boolean;
  readonly digest?: string;
} {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maxBytes) return { value, truncated: false };
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return {
    value: bytes.subarray(0, end).toString("utf8"),
    truncated: true,
    digest: createHash("sha256").update(bytes).digest("hex"),
  };
}

function inMemorySummary(state: JobRuntimeState): CsvAgentJobSummary {
  const progress = computeProgressSnapshot(state);
  const resultBytes = [...state.items.values()].reduce(
    (total, item) =>
      total +
      (item.result === undefined
        ? 0
        : Buffer.byteLength(JSON.stringify(item.result), "utf8")),
    0,
  );
  const availableResults = [...state.items.values()].filter(
    (item) => item.resultAvailability === "available",
  ).length;
  const unavailableAfterReviewResults = [...state.items.values()].filter(
    (item) => item.resultAvailability === "unavailable_after_review",
  ).length;
  const status =
    progress.runningItems > 0 || progress.pendingItems > 0
      ? "running"
      : progress.unknownOutcomeItems > 0
        ? "needs_review"
        : progress.failedItems > 0
          ? "failed"
          : progress.cancelledItems > 0
            ? "cancelled"
            : "completed";
  return {
    contractVersion: CSV_JOB_CONTRACT_VERSION,
    jobId: state.config.jobId,
    status,
    ...progress,
    resultBytes,
    availableResults,
    unavailableAfterReviewResults,
    notProducedResults:
      state.items.size - availableResults - unavailableAfterReviewResults,
  };
}

function buildRunResult(
  state: JobRuntimeState,
  outputArtifact: CsvOutputArtifact | undefined,
): RunAgentsOnCsvResult {
  const repositoryPage = state.repository?.listItemsPage({
    jobId: state.config.jobId,
    limit: CSV_DEFAULT_ITEM_PAGE_SIZE,
  });
  const inMemoryPage =
    repositoryPage === undefined
      ? [...state.items.values()].slice(0, CSV_DEFAULT_ITEM_PAGE_SIZE)
      : [];
  const last = inMemoryPage.at(-1);
  const summary =
    state.repository?.getSummary(state.config.jobId) ?? inMemorySummary(state);
  const itemPage = [
    ...(repositoryPage?.items ?? inMemoryPage.map(itemSummary)),
  ];
  let nextItemCursor =
    repositoryPage?.nextCursor ??
    (state.items.size > inMemoryPage.length && last !== undefined
      ? encodeCsvJobItemCursor({
          jobId: state.config.jobId,
          rowIndex: last.rowIndex,
          itemId: last.itemId,
        })
      : undefined);
  const build = (): RunAgentsOnCsvResult => ({
    contractVersion: CSV_JOB_CONTRACT_VERSION,
    jobId: state.config.jobId,
    summary,
    itemPage,
    ...(nextItemCursor !== undefined ? { nextItemCursor } : {}),
    stoppedEarly: state.stopRequested,
    ...(outputArtifact !== undefined
      ? { outputCsvPath: outputArtifact.path, outputArtifact }
      : {}),
  });
  while (
    itemPage.length > 1 &&
    Buffer.byteLength(JSON.stringify(build()), "utf8") >
      CSV_MAX_JOB_SUMMARY_BYTES
  ) {
    itemPage.pop();
    const pageLast = itemPage.at(-1)!;
    nextItemCursor = encodeCsvJobItemCursor({
      jobId: state.config.jobId,
      rowIndex: pageLast.rowIndex,
      itemId: pageLast.itemId,
    });
  }
  const result = build();
  const encodedBytes = Buffer.byteLength(JSON.stringify(result), "utf8");
  if (encodedBytes > CSV_MAX_JOB_SUMMARY_BYTES) {
    throw new Error(
      `CSV job summary is ${encodedBytes} bytes; limit is ${CSV_MAX_JOB_SUMMARY_BYTES}`,
    );
  }
  return result;
}

export async function runAgentsOnCsv(
  opts: RunAgentsOnCsvOpts,
): Promise<RunAgentsOnCsvResult> {
  opts.signal?.throwIfAborted();
  const jobId = freshJobId();
  const maxConcurrency = requestedConcurrency(opts.maxConcurrency);
  const maxResultBytes = requestedResultBytes(opts.maxResultBytes);
  const maxRuntimeSeconds = requestedRuntimeSeconds(opts.maxRuntimeSeconds);
  const resolvedCsvPath = resolveCsvInputPath(
    opts.inputRootCapability,
    opts.csvPath,
  );
  if (
    opts.outputCsvPath !== undefined &&
    opts.outputRootCapability === undefined
  ) {
    throw new Error(
      "outputCsvPath requires an authenticated CsvOutputRootCapability",
    );
  }
  const resolvedOutputPath =
    opts.outputRootCapability === undefined
      ? undefined
      : resolveCsvOutputPath(
          opts.outputRootCapability,
          jobId,
          opts.outputCsvPath,
        );
  const compiledOutputSchema = compileCsvOutputSchema(opts.outputSchema);
  try {
    await primeCsvOutputSchemaValidation(jobId, compiledOutputSchema);
  } catch (error) {
    releaseCsvOutputSchemaValidation(jobId);
    throw error;
  }
  const config: JobConfig = {
    jobId,
    instruction: opts.instruction,
    ...(compiledOutputSchema !== undefined
      ? {
          outputSchema: compiledOutputSchema.schema,
          compiledOutputSchema,
        }
      : {}),
    maxConcurrency,
    ...(maxRuntimeSeconds !== undefined ? { maxRuntimeSeconds } : {}),
    maxResultBytes,
  };
  const items = new Map<ItemId, JobItemRecord>();
  let inputHeaders: ReadonlyArray<string> = [];
  let importHandle: CsvAgentJobImportHandle | undefined;
  let importBatch: CsvAgentJobItemCreateParams[] = [];
  const flushImportBatch = (): void => {
    if (importHandle === undefined || importBatch.length === 0) return;
    opts.repository!.appendJobImportItems(importHandle, importBatch);
    importBatch = [];
  };
  try {
    const scanned = await scanCsvFile(
      resolvedCsvPath,
      {
        idColumn: opts.idColumn,
        inputRootCapability: opts.inputRootCapability,
        signal: opts.signal,
        validateSourceIdUniqueness: opts.repository === undefined,
      },
      {
        onHeaders: (headers) => {
          inputHeaders = headers;
          if (opts.repository === undefined) return;
          importHandle = opts.repository.beginJobImport({
            id: jobId,
            name: opts.jobName ?? jobId,
            instruction: opts.instruction,
            autoExport: resolvedOutputPath !== undefined,
            ...(maxRuntimeSeconds !== undefined ? { maxRuntimeSeconds } : {}),
            ...(compiledOutputSchema !== undefined
              ? { outputSchema: compiledOutputSchema.schema }
              : {}),
            inputHeaders: headers,
            inputCsvPath: resolvedCsvPath,
            outputCsvPath: resolvedOutputPath ?? "",
            outputMode: opts.outputMode ?? "replace_existing_regular",
            ...(opts.idColumn !== undefined ? { idColumn: opts.idColumn } : {}),
            maxItems: CSV_MAX_ROWS,
            maxResultBytes,
            requestedMaxConcurrency: config.maxConcurrency,
          });
        },
        onRow: (row, rowIndex) => {
          const identity = deriveCsvItemIdentity(
            jobId,
            rowIndex,
            inputHeaders,
            row,
          );
          if (items.has(identity.itemId)) {
            throw new Error(
              `CSV item identity collision at data row ${rowIndex + 1}`,
            );
          }
          const sourceId =
            opts.idColumn === undefined ? undefined : row[opts.idColumn];
          const item: JobItemRecord = {
            jobId,
            itemId: identity.itemId,
            rowIndex,
            ...(sourceId !== undefined ? { sourceId } : {}),
            contentSha256: identity.contentSha256,
            workerName: identity.workerName,
            row,
            instruction: opts.instruction,
            status: "pending",
            attemptCount: 0,
            resultAvailability: "not_produced",
          };
          if (opts.repository === undefined) {
            items.set(identity.itemId, item);
            return;
          }
          if (importHandle === undefined) return;
          importBatch.push({
            itemId: item.itemId,
            rowIndex: item.rowIndex,
            ...(item.sourceId !== undefined ? { sourceId: item.sourceId } : {}),
            contentSha256: item.contentSha256,
            workerName: item.workerName,
            row: item.row,
          });
          if (importBatch.length >= CSV_IMPORT_BATCH_ROWS) flushImportBatch();
        },
      },
    );
    if (scanned.rowCount === 0) {
      throw new Error("csv_path produced zero data rows");
    }
    flushImportBatch();
    if (importHandle !== undefined) {
      opts.repository!.promoteJobImport(importHandle, {
        importDigest: scanned.inputSha256,
        inputBytes: scanned.inputBytes,
        totalItems: scanned.rowCount,
      });
    }
  } catch (error) {
    if (importHandle !== undefined) {
      opts.repository!.abortJobImport(
        importHandle,
        error instanceof Error ? error.message : String(error),
      );
      opts.repository!.deleteAbortedImport(importHandle);
    }
    releaseCsvOutputSchemaValidation(jobId);
    throw error;
  }

  try {
    if (opts.repository !== undefined) {
      opts.repository.markJobRunning(jobId, config.maxConcurrency);
    }
  } catch (error) {
    releaseCsvOutputSchemaValidation(jobId);
    throw error;
  }

  const state: JobRuntimeState = {
    config,
    items,
    pending: new Map(),
    ...(opts.repository !== undefined ? { repository: opts.repository } : {}),
    ...(opts.threadOps !== undefined ? { threadOps: opts.threadOps } : {}),
    progress: new JobProgressEmitterImpl(opts.progressEmitter),
    progressCounters:
      opts.repository === undefined
        ? createRuntimeProgressCounters(items.values())
        : createRuntimeProgressCountersFromJob(
            opts.repository.getJob(jobId) ??
              (() => {
                throw new Error(`CSV job ${jobId} disappeared after import`);
              })(),
          ),
    ...(opts.idempotencyProfile !== undefined
      ? { idempotencyProfile: opts.idempotencyProfile }
      : {}),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    preservePendingOnStop: false,
    counterAnomalyReconciled: false,
    stopRequested: false,
  };
  jobs.set(jobId, state);
  try {
    state.progress.maybeEmit(jobId, computeProgressSnapshot(state), true);
    await processItems(state, opts.spawn);
    const outputArtifact =
      resolvedOutputPath !== undefined &&
      opts.outputRootCapability !== undefined
        ? await writeOutputCsv(
            resolvedOutputPath,
            opts.outputRootCapability,
            opts.outputMode,
            inputHeaders,
            jobId,
            opts.repository === undefined
              ? items.values()
              : iteratePersistedJobItems(
                  opts.repository,
                  jobId,
                  opts.instruction,
                ),
            opts.signal,
            opts.repository,
          )
        : undefined;
    if (opts.repository !== undefined) {
      if (
        state.stopRequested &&
        opts.repository.getJob(jobId)?.unknownOutcomeItems === 0
      ) {
        opts.repository.markJobCancelled(jobId, "CSV job cancelled by request");
      } else {
        opts.repository.refreshJobOutcome(jobId);
      }
    }
    state.progress.maybeEmit(jobId, computeProgressSnapshot(state), true);
    return buildRunResult(state, outputArtifact);
  } catch (error) {
    const current = opts.repository?.getJob(jobId);
    if (
      current !== null &&
      current !== undefined &&
      current.status !== "needs_review"
    ) {
      opts.repository?.markJobFailed(
        jobId,
        error instanceof Error ? error.message : String(error),
      );
    }
    throw error;
  } finally {
    jobs.delete(jobId);
    releaseCsvOutputSchemaValidation(jobId);
  }
}

function operationKeyForItem(
  state: JobRuntimeState,
  item: JobItemRecord,
): string | undefined {
  const profile = state.idempotencyProfile;
  if (profile === undefined) return undefined;
  if (
    profile.name.length === 0 ||
    !Number.isSafeInteger(profile.version) ||
    profile.version <= 0
  ) {
    throw new Error("invalid CSV idempotency profile identity");
  }
  const derived = profile.deriveOperationKey({
    jobId: item.jobId,
    itemId: item.itemId,
    rowIndex: item.rowIndex,
    contentSha256: item.contentSha256,
  });
  if (derived.length === 0)
    throw new Error("CSV idempotency operation key is empty");
  if (item.operationKey !== undefined && item.operationKey !== derived) {
    throw new Error(`CSV idempotency operation key changed for ${item.itemId}`);
  }
  return derived;
}

function* iteratePersistedJobItems(
  repository: CsvAgentJobsRepository,
  jobId: JobId,
  instruction: string,
): IterableIterator<JobItemRecord> {
  for (const stored of repository.iterateItemsForScheduler(
    jobId,
    CSV_RECOVERY_PAGE_ROWS,
  )) {
    yield itemFromStored(instruction, stored, stored.row as CsvRow);
  }
}

function cancelPendingItems(state: JobRuntimeState, reason: string): void {
  const repository = state.repository;
  if (repository === undefined) {
    for (const item of state.items.values()) {
      if (item.status !== "pending") continue;
      transitionRuntimeItemStatus(state, item, "cancelled");
      item.completedAt = new Date();
    }
    return;
  }

  let cursor: CsvAgentJobItemSchedulerCursor | undefined;
  do {
    const page = repository.listItemsForScheduler({
      jobId: state.config.jobId,
      status: "pending",
      limit: CSV_RECOVERY_PAGE_ROWS,
      ...(cursor !== undefined ? { cursor } : {}),
    });
    for (const item of page.items) {
      repository.markItemCancelled(state.config.jobId, item.itemId, reason);
      const resident = state.items.get(item.itemId);
      if (resident !== undefined) {
        resident.status = "cancelled";
        resident.completedAt = new Date();
      }
    }
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  synchronizeRuntimeProgressCounters(state);
}

async function processItems(
  state: JobRuntimeState,
  spawn: AgentJobSpawn,
): Promise<void> {
  const queue = new CsvJobCompactingQueue<ItemId>();
  // CSV import and repository keyset pages both populate the map in row order.
  // Preserve that insertion order without materializing and sorting a second
  // million-entry array.
  for (const item of state.items.values()) {
    if (item.status === "pending") queue.enqueue(item.itemId);
  }
  let persistedCursor: CsvAgentJobItemSchedulerCursor | undefined;
  let persistedScanDone = state.repository === undefined;
  const refillPersistedItems = (): void => {
    if (state.repository === undefined || persistedScanDone) return;
    const room = MAX_CSV_READY_ROWS_PER_JOB - queue.size - inflight.size;
    if (room <= 0) return;
    const page = state.repository.listItemsForScheduler({
      jobId: state.config.jobId,
      status: "pending",
      limit: Math.min(CSV_RECOVERY_PAGE_ROWS, room),
      ...(persistedCursor !== undefined ? { cursor: persistedCursor } : {}),
    });
    for (const stored of page.items) {
      const item = itemFromStored(
        state.config.instruction,
        stored,
        stored.row as CsvRow,
      );
      state.items.set(item.itemId, item);
      queue.enqueue(item.itemId);
    }
    persistedCursor = page.nextCursor;
    persistedScanDone = page.nextCursor === undefined;
  };
  const inflight = new Map<
    ItemId,
    Promise<ProcessItemOutcome & { readonly itemId: ItemId }>
  >();
  let cancelIssued = false;
  const onAbort = (): void => {
    state.stopRequested = true;
    for (const waiter of state.pending.values()) waiter.resolve();
  };
  state.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    while (!persistedScanDone || queue.size > 0 || inflight.size > 0) {
      if (state.fatalError !== undefined) throw state.fatalError;
      if (queue.size <= CSV_READY_REFILL_LOW_WATERMARK) {
        refillPersistedItems();
      }
      if (!state.stopRequested && state.repository !== undefined) {
        if (
          state.repository.getJob(state.config.jobId)?.status === "cancelled"
        ) {
          state.stopRequested = true;
        }
      }
      if (state.stopRequested && !cancelIssued) {
        cancelIssued = true;
        await spawn.cancelOutstanding(state.config.jobId).catch(() => {});
        for (const waiter of state.pending.values()) waiter.resolve();
      }
      while (
        !state.stopRequested &&
        inflight.size < state.config.maxConcurrency &&
        queue.size > 0
      ) {
        const itemId = queue.dequeue();
        if (itemId === undefined) break;
        const promise = runOneItem(state, spawn, itemId).then((outcome) => ({
          ...outcome,
          itemId,
        }));
        inflight.set(itemId, promise);
      }
      if (inflight.size === 0) break;
      const completed = await Promise.race(inflight.values());
      inflight.delete(completed.itemId);
      if (completed.retryItemId !== undefined) {
        queue.enqueueFront(completed.retryItemId);
      } else if (state.repository !== undefined) {
        state.items.delete(completed.itemId);
      }
      state.progress.maybeEmit(
        state.config.jobId,
        computeProgressSnapshot(state),
        false,
      );
    }
    if (state.stopRequested && !state.preservePendingOnStop) {
      cancelPendingItems(state, "CSV job cancelled before dispatch");
    }
  } catch (error) {
    reconcileRuntimeCounterAnomalyOnce(state, error);
    state.stopRequested = true;
    const counterIntegrityFailure =
      error instanceof CsvRuntimeCounterIntegrityError ||
      state.fatalError === error;
    const cleanupFailures: unknown[] = [];
    if (!cancelIssued) {
      cancelIssued = true;
      try {
        await spawn.cancelOutstanding(state.config.jobId);
      } catch (cancellationError) {
        cleanupFailures.push(cancellationError);
      }
    }
    for (const waiter of state.pending.values()) waiter.resolve();
    const remaining = await Promise.allSettled(inflight.values());
    for (const outcome of remaining) {
      if (outcome.status === "rejected" && outcome.reason !== error) {
        cleanupFailures.push(outcome.reason);
      }
    }
    if (!state.preservePendingOnStop && !counterIntegrityFailure) {
      try {
        cancelPendingItems(
          state,
          "CSV job stopped after a worker lifecycle failure",
        );
      } catch (projectionError) {
        cleanupFailures.push(projectionError);
      }
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [error, ...cleanupFailures],
        "CSV job stopped with unresolved worker cleanup",
      );
    }
    throw error;
  } finally {
    state.signal?.removeEventListener("abort", onAbort);
  }
}

async function runOneItem(
  state: JobRuntimeState,
  spawn: AgentJobSpawn,
  itemId: ItemId,
  preacquiredCapacity?: AgentJobCapacityOutcome,
  supervisorClaim?: CsvJobSupervisorRegistrationClaim,
  capacityAlreadyChecked = false,
): Promise<ProcessItemOutcome> {
  const item = state.items.get(itemId);
  if (item === undefined || item.status !== "pending" || state.stopRequested) {
    if (preacquiredCapacity?.kind === "acquired") {
      preacquiredCapacity.permit.cancel();
    }
    return {};
  }
  let dispatchBegan = false;
  let retirementAttempted = false;
  let unknownOutcomePersisted = false;
  let launchedThreadFinished: Promise<void> | undefined;
  const retireLaunchedWorker = async (): Promise<void> => {
    if (item.assignedThreadId === undefined || spawn.retireItem === undefined) {
      return;
    }
    retirementAttempted = true;
    await retireWorkerIfNeeded(state, spawn, item, launchedThreadFinished);
  };
  const completion = new Promise<void>((resolve) => {
    state.pending.set(itemId, { resolve });
  });
  try {
    const invocationEnvelope = createCsvAgentInvocationEnvelope({
      jobId: state.config.jobId,
      itemId,
      rowIndex: item.rowIndex,
      rowSha256: item.contentSha256,
      instruction: item.instruction,
      row: item.row,
      ...(state.config.outputSchema !== undefined
        ? { outputSchema: state.config.outputSchema }
        : {}),
    });
    const operationKey = operationKeyForItem(state, item);
    if (operationKey !== undefined) item.operationKey = operationKey;
    const capacity = capacityAlreadyChecked
      ? preacquiredCapacity
      : (preacquiredCapacity ??
        (await spawn.acquireCapacity?.({
          jobId: state.config.jobId,
          itemId,
          ...(state.signal !== undefined ? { signal: state.signal } : {}),
        })));
    if (capacity?.kind === "capacity_unavailable") {
      await delay(
        capacity.retryAfterMs ?? CSV_CAPACITY_RETRY_DELAY_MS,
        state.signal,
      );
      return state.stopRequested ? {} : { retryItemId: itemId };
    }
    const capacityPermit = capacity?.permit;
    if (state.stopRequested || state.signal?.aborted === true) {
      capacityPermit?.cancel();
      state.stopRequested = true;
      return {};
    }
    try {
      state.repository?.beginItemDispatch(state.config.jobId, itemId, {
        ...(state.idempotencyProfile !== undefined
          ? {
              idempotencyProfile: state.idempotencyProfile.name,
              idempotencyProfileVersion: state.idempotencyProfile.version,
            }
          : {}),
        ...(operationKey !== undefined ? { operationKey } : {}),
        ...(supervisorClaim !== undefined ? { supervisorClaim } : {}),
      });
    } catch (error) {
      capacityPermit?.cancel();
      throw error;
    }
    dispatchBegan = true;
    transitionRuntimeItemStatus(state, item, "running");
    item.attemptCount += 1;
    const context: AgentJobSpawnContext = {
      jobId: state.config.jobId,
      itemId,
      workerName: item.workerName,
      row: item.row,
      invocationEnvelope,
      ...(operationKey !== undefined ? { operationKey } : {}),
      ...(capacityPermit !== undefined ? { capacityPermit } : {}),
      ...(state.signal !== undefined ? { signal: state.signal } : {}),
    };
    let rawOutcome: AgentJobSpawnOutcome | void;
    try {
      rawOutcome = await spawn.spawn(context);
    } catch (error) {
      capacityPermit?.cancel();
      throw error;
    }
    const outcome: AgentJobSpawnOutcome = rawOutcome ?? { kind: "launched" };
    if (outcome.kind === "capacity_unavailable") {
      capacityPermit?.cancel();
      transitionRuntimeItemStatus(state, item, "pending");
      state.repository?.markItemPending(
        state.config.jobId,
        itemId,
        undefined,
        supervisorClaim,
      );
      await delay(
        outcome.retryAfterMs ?? CSV_CAPACITY_RETRY_DELAY_MS,
        state.signal,
      );
      return state.stopRequested ? {} : { retryItemId: itemId };
    }
    if (outcome.kind === "rejected") {
      capacityPermit?.cancel();
      transitionRuntimeItemStatus(state, item, "failed");
      item.error = outcome.reason;
      item.completedAt = new Date();
      state.repository?.markItemFailed(
        state.config.jobId,
        itemId,
        outcome.reason,
      );
      return {};
    }
    if (capacityPermit !== undefined && !capacityPermit.isConsumed()) {
      capacityPermit.cancel();
      throw new Error("CSV worker launch did not consume its capacity permit");
    }
    if (outcome.threadId !== undefined)
      item.assignedThreadId = outcome.threadId;
    launchedThreadFinished = outcome.threadFinished;
    if ((item.status as JobItemStatus) === "running") {
      state.repository?.acknowledgeItemDispatch(state.config.jobId, itemId, {
        ...(outcome.threadId !== undefined
          ? { threadId: outcome.threadId }
          : {}),
        ...(outcome.providerAcknowledgedOperationKey !== undefined
          ? {
              providerAcknowledgedKey: outcome.providerAcknowledgedOperationKey,
            }
          : {}),
        ...(outcome.effect !== undefined ? { effect: outcome.effect } : {}),
      });
    }

    const deadlineAt =
      state.config.maxRuntimeSeconds === undefined
        ? undefined
        : Date.now() + state.config.maxRuntimeSeconds * 1_000;
    while (
      (item.status as JobItemStatus) === "running" &&
      !state.stopRequested
    ) {
      const remaining =
        deadlineAt === undefined
          ? undefined
          : Math.max(0, deadlineAt - Date.now());
      if (remaining === 0) {
        throw new Error(`CSV item ${itemId} exceeded max_runtime_seconds`);
      }
      const pollMs = Math.min(
        JOB_CANCEL_POLL_MS,
        remaining ?? JOB_CANCEL_POLL_MS,
      );
      const racers: Array<Promise<"reported" | "finished" | "poll">> = [
        completion.then(() => "reported" as const),
        delay(pollMs).then(() => "poll" as const),
      ];
      if (outcome.threadFinished !== undefined) {
        racers.push(outcome.threadFinished.then(() => "finished" as const));
      }
      const event = await Promise.race(racers);
      if (state.fatalError !== undefined) throw state.fatalError;
      if (
        event === "finished" &&
        (item.status as JobItemStatus) === "running"
      ) {
        throw new Error("worker finished without recording a CSV job result");
      }
      if (event === "reported") break;
      if (
        state.repository?.getJob(state.config.jobId)?.status === "cancelled"
      ) {
        state.stopRequested = true;
      }
    }
    if (state.stopRequested && (item.status as JobItemStatus) === "running") {
      const reason = "CSV item outcome is ambiguous after cancellation";
      transitionRuntimeItemStatus(state, item, "unknown_outcome", true);
      item.error = reason;
      item.reviewReason = reason;
      state.repository?.markItemUnknownOutcome(
        state.config.jobId,
        itemId,
        reason,
      );
      unknownOutcomePersisted = true;
      await retireLaunchedWorker();
    }
    if ((item.status as JobItemStatus) === "completed") {
      await retireLaunchedWorker();
    }
    return {};
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if ((item.status as JobItemStatus) === "completed") throw error;
    if (retirementAttempted) throw error;
    if (!dispatchBegan && state.signal?.aborted === true) {
      // Admission was cancelled before the durable dispatch transition. Leave
      // the item pending so processItems can apply the job-wide cancellation
      // transition; this is not a worker failure or an ambiguous effect.
      state.stopRequested = true;
      return {};
    }
    if (!dispatchBegan && supervisorClaim !== undefined) {
      return { retryItemId: itemId };
    }
    if (dispatchBegan) {
      const cleanupFailures: unknown[] = [];
      if (
        (item.status as JobItemStatus) !== "unknown_outcome" ||
        !unknownOutcomePersisted
      ) {
        transitionRuntimeItemStatus(state, item, "unknown_outcome", true);
        item.error = reason;
        item.reviewReason = reason;
        try {
          state.repository?.markItemUnknownOutcome(
            state.config.jobId,
            itemId,
            reason,
          );
          unknownOutcomePersisted = true;
        } catch (projectionError) {
          cleanupFailures.push(projectionError);
        }
      }
      try {
        await retireLaunchedWorker();
      } catch (retirementError) {
        cleanupFailures.push(retirementError);
      }
      if (cleanupFailures.length > 0) {
        throw new AggregateError(
          [error, ...cleanupFailures],
          `CSV item ${itemId} failed with unresolved durable/lifecycle cleanup`,
        );
      }
    } else {
      transitionRuntimeItemStatus(state, item, "failed");
      item.error = reason;
      item.completedAt = new Date();
      state.repository?.markItemFailed(state.config.jobId, itemId, reason);
    }
    if (
      error instanceof CsvRuntimeCounterIntegrityError ||
      state.fatalError === error
    ) {
      throw error;
    }
    return {};
  } finally {
    state.pending.delete(itemId);
  }
}

async function retireWorkerIfNeeded(
  state: JobRuntimeState,
  spawn: AgentJobSpawn,
  item: JobItemRecord,
  threadFinished: Promise<void> | undefined,
): Promise<void> {
  if (item.assignedThreadId === undefined || spawn.retireItem === undefined) {
    return;
  }
  if (threadFinished !== undefined) {
    await Promise.race([
      threadFinished.catch(() => undefined),
      delay(CSV_WORKER_RETIRE_TIMEOUT_MS),
    ]);
  }
  // One-shot CSV workers are retired even after a clean join: the generic
  // reusable-agent path deliberately keeps clean background agents live.
  // An unresolved join is also handed to the lifecycle owner for explicit
  // termination; capacity is not released by the orchestrator itself.
  await spawn.retireItem(
    state.config.jobId,
    item.itemId,
    item.assignedThreadId,
  );
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = (): void => {
      signal?.removeEventListener("abort", finish);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    timer.unref?.();
    signal?.addEventListener("abort", finish, { once: true });
  });
}

async function writeOutputCsv(
  path: string,
  capability: CsvOutputRootCapability,
  mode: CsvOutputMode | undefined,
  inputHeaders: ReadonlyArray<string>,
  jobId: string,
  items: Iterable<JobItemRecord>,
  signal: AbortSignal | undefined,
  intentStore: CsvOutputIntentStore | undefined,
): Promise<CsvOutputArtifact> {
  const sourceIdIsInput = inputHeaders.includes("source_id");
  const headers = [
    ...inputHeaders,
    "job_id",
    "item_id",
    "row_index",
    ...(!sourceIdIsInput ? ["source_id"] : []),
    "status",
    "attempt_count",
    "last_error",
    "result_json",
    "result_availability",
    "reported_at",
    "completed_at",
  ];
  function* rows(): IterableIterator<ReadonlyArray<string>> {
    for (const item of items) {
      yield [
        ...inputHeaders.map((header) => item.row[header] ?? ""),
        item.jobId,
        item.itemId,
        String(item.rowIndex),
        ...(!sourceIdIsInput ? [item.sourceId ?? ""] : []),
        item.status,
        String(item.attemptCount),
        item.error ?? "",
        item.result === undefined ? "" : JSON.stringify(item.result),
        item.resultAvailability,
        item.reportedAt?.toISOString() ?? "",
        item.completedAt?.toISOString() ?? "",
      ];
    }
  }
  return writeCsvOutput({
    capability,
    jobId,
    requestedPath: path,
    ...(mode !== undefined ? { mode } : {}),
    headers,
    rows: rows(),
    ...(signal !== undefined ? { signal } : {}),
    ...(intentStore !== undefined ? { intentStore } : {}),
  });
}

interface RecoveredJobRuntime {
  registration: CsvJobSupervisorRegistration;
  registrationHeld: boolean;
  rotationDue: boolean;
  holdWakeTimer?: ReturnType<typeof setTimeout>;
  readonly ready: CsvJobCompactingQueue<ItemId>;
  readonly readyIds: Set<ItemId>;
  readonly recoveryRows: CsvJobCompactingQueue<CsvAgentJobItem>;
  readonly inflight: Set<Promise<void>>;
  recoveryCursor?: CsvAgentJobItemSchedulerCursor;
  recoveryScanDone: boolean;
  initialized: boolean;
  finalized: boolean;
  queuedForRound: boolean;
  job?: CsvAgentJob;
  state?: JobRuntimeState;
}

interface CsvWorkerSettlementWaiter {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

interface CsvSupervisorFatalFailure {
  readonly error: unknown;
  readonly runtime?: RecoveredJobRuntime;
}

export interface CsvJobRecoverySupervisorOpts extends ResumeAgentJobsOpts {
  readonly onError?: (error: unknown) => void;
}

/**
 * Process owner for durable CSV recovery. The SQLite registration queue is the
 * durable source of scheduling order; this class retains only the bounded
 * registration window, ready rows, capacity waiter, and launched workers.
 */
export class CsvJobRecoverySupervisor {
  private readonly controller = new AbortController();
  private readonly active = new Map<JobId, RecoveredJobRuntime>();
  private readonly round = new CsvJobCompactingQueue<JobId>();
  private readonly globalCapacityWaiters = new CsvJobCompactingQueue<JobId>();
  private readonly globalCapacityWaiterIds = new Set<JobId>();
  private readonly ownedWorkers = new Set<Promise<void>>();
  private readonly results: RunAgentsOnCsvResult[] = [];
  private readonly startupPromise: Promise<number>;
  private resolveStartup!: (startedJobs: number) => void;
  private rejectStartup!: (error: unknown) => void;
  private completionPromise: Promise<RunAgentsOnCsvResult[]> | undefined;
  private terminalObservationPromise: Promise<void> | undefined;
  private readyRowsGlobal = 0;
  private activeWorkers = 0;
  private registeredRuntimeCountValue = 0;
  private startedJobs = 0;
  private startupSettled = false;
  private fatalFailure: CsvSupervisorFatalFailure | undefined;
  private workerSettlementWaiter: CsvWorkerSettlementWaiter | undefined;
  private supervisorWakeWaiter: CsvWorkerSettlementWaiter | undefined;
  private supervisorStarted = false;
  private parentAbortListener: (() => void) | undefined;

  constructor(private readonly opts: CsvJobRecoverySupervisorOpts) {
    this.startupPromise = new Promise<number>((resolve, reject) => {
      this.resolveStartup = resolve;
      this.rejectStartup = reject;
    });
  }

  get activeRuntimeCount(): number {
    return this.active.size;
  }

  get registeredRuntimeCount(): number {
    return this.registeredRuntimeCountValue;
  }

  async start(): Promise<number> {
    if (this.completionPromise === undefined) {
      this.supervisorStarted = true;
      this.opts.repository.claimSupervisorOwnership();
      const parentSignal = this.opts.signal;
      if (parentSignal !== undefined) {
        this.parentAbortListener = () =>
          this.controller.abort(parentSignal.reason);
        parentSignal.addEventListener("abort", this.parentAbortListener, {
          once: true,
        });
        if (parentSignal.aborted) this.parentAbortListener();
      }
      this.completionPromise = this.runLoop();
      this.terminalObservationPromise = this.completionPromise.then(
        () => undefined,
        () => undefined,
      );
    }
    return this.startupPromise;
  }

  async waitForCompletion(): Promise<RunAgentsOnCsvResult[]> {
    await this.start();
    return this.completionPromise!;
  }

  async shutdown(reason = "CSV recovery supervisor shutdown"): Promise<void> {
    this.controller.abort(reason);
    if (this.completionPromise === undefined) {
      this.settleStartupSuccess();
      return;
    }
    await this.completionPromise.then(
      () => undefined,
      () => undefined,
    );
    await this.terminalObservationPromise;
  }

  private async runLoop(): Promise<RunAgentsOnCsvResult[]> {
    const foregroundDeadline = Date.now() + MAX_CSV_SUPERVISOR_STARTUP_MS;
    try {
      await this.reconstructFirstPage();
      while (!this.controller.signal.aborted) {
        this.throwFatalFailureIfPresent();
        this.advanceRegistrationCleanup();

        await this.extendDurableRegistrationQueue(foregroundDeadline);
        this.registerQueuedJobs();

        const jobId = this.round.dequeue();
        if (jobId !== undefined) {
          const runtime = this.active.get(jobId);
          if (runtime !== undefined) {
            runtime.queuedForRound = false;
            try {
              await this.stepJob(runtime);
            } catch (error) {
              this.reconcileCounterAnomalyOnce(runtime, error);
              throw error;
            }
            this.enqueueForRoundIfRunnable(runtime);
          }
          continue;
        }

        if (this.ownedWorkers.size > 0) {
          await this.waitForWorkerSettlementOrShutdown();
          continue;
        }

        if (this.registerQueuedJobs() > 0) continue;
        const supervisorState = this.opts.repository.getSupervisorState();
        if (!supervisorState.epochScanComplete) continue;
        // The bounded query both sweeps stale queued rows and proves whether a
        // later keyset page remains.
        this.opts.repository.queueNextSupervisorJobPage(
          CSV_RECOVERY_JOB_PAGE_SIZE,
        );
        if (this.registerQueuedJobs() > 0) continue;
        if (!this.opts.repository.getSupervisorState().cleanupScanComplete) {
          continue;
        }
        if (this.opts.repository.beginNextSupervisorEpochIfNeeded()) continue;
        break;
      }
      this.throwFatalFailureIfPresent();
      this.settleStartupSuccess();
      return [...this.results];
    } catch (error) {
      this.fatalFailure ??= { error };
      this.settleStartupFailure(error);
      this.opts.onError?.(error);
      throw error;
    } finally {
      await this.stopOwnedWork();
      if (
        this.opts.signal !== undefined &&
        this.parentAbortListener !== undefined
      ) {
        this.opts.signal.removeEventListener("abort", this.parentAbortListener);
      }
    }
  }

  private async reconstructFirstPage(): Promise<void> {
    const state = this.opts.repository.getSupervisorState();
    if (!state.epochScanComplete) {
      this.opts.repository.queueNextSupervisorJobPage(
        CSV_RECOVERY_JOB_PAGE_SIZE,
      );
    }
    const registered = this.registerQueuedJobs();
    if (registered === 0) {
      const refreshed = this.opts.repository.getSupervisorState();
      if (refreshed.epochScanComplete) this.settleStartupSuccess();
      return;
    }
    // Eagerly reconstruct and validate the first owner. Later registrations
    // remain background-owned and cannot delay the foreground startup gate.
    const firstId = this.round.dequeue();
    if (firstId === undefined) {
      this.settleStartupSuccess();
      return;
    }
    const first = this.active.get(firstId);
    if (first !== undefined) {
      first.queuedForRound = false;
      await this.initializeRuntime(first);
      this.enqueueForRoundIfRunnable(first);
    }
    this.settleStartupSuccess();
  }

  private advanceRegistrationCleanup(): void {
    if (this.opts.repository.getSupervisorState().cleanupScanComplete) return;
    this.opts.repository.sweepNextInvalidSupervisorRegistrationPage(
      CSV_RECOVERY_JOB_PAGE_SIZE,
    );
  }

  private async extendDurableRegistrationQueue(
    foregroundDeadline: number,
  ): Promise<void> {
    const state = this.opts.repository.getSupervisorState();
    if (state.epochScanComplete) return;
    if (Date.now() >= foregroundDeadline) {
      this.opts.repository.setSupervisorBackgroundScanRequired(true);
    }
    this.opts.repository.queueNextSupervisorJobPage(CSV_RECOVERY_JOB_PAGE_SIZE);
  }

  private registerQueuedJobs(): number {
    let registered = 0;
    while (
      registered < CSV_RECOVERY_JOB_PAGE_SIZE &&
      this.registeredRuntimeCountValue < MAX_RECOVERED_CSV_JOBS
    ) {
      const registration = this.opts.repository.registerNextSupervisorJob();
      if (registration === null) break;
      const existing = this.active.get(registration.jobId);
      if (existing !== undefined) {
        existing.registration = registration;
        if (!existing.registrationHeld) {
          existing.registrationHeld = true;
          this.registeredRuntimeCountValue += 1;
          this.scheduleRegistrationHoldWake(existing);
        }
        this.enqueueForRoundIfRunnable(existing);
      } else {
        const runtime: RecoveredJobRuntime = {
          registration,
          registrationHeld: true,
          rotationDue: false,
          ready: new CsvJobCompactingQueue<ItemId>(),
          readyIds: new Set<ItemId>(),
          recoveryRows: new CsvJobCompactingQueue<CsvAgentJobItem>(),
          inflight: new Set<Promise<void>>(),
          recoveryScanDone: false,
          initialized: false,
          finalized: false,
          queuedForRound: false,
        };
        this.active.set(registration.jobId, runtime);
        this.registeredRuntimeCountValue += 1;
        this.scheduleRegistrationHoldWake(runtime);
        this.enqueueForRoundIfRunnable(runtime);
        this.startedJobs += 1;
      }
      registered += 1;
    }
    return registered;
  }

  private async initializeRuntime(runtime: RecoveredJobRuntime): Promise<void> {
    if (runtime.initialized || runtime.finalized) return;
    const job = this.opts.repository.getJob(runtime.registration.jobId);
    if (
      job === null ||
      job.executionGate !== "ready" ||
      job.counterIntegrityState === "poisoned" ||
      !["pending", "running"].includes(job.status)
    ) {
      this.finishRegistration(runtime);
      return;
    }
    const reconciliation = this.opts.repository.reconcileJobCounters(
      job.id,
      "startup",
    );
    if (!reconciliation.matches) {
      this.finishRegistration(runtime);
      return;
    }
    const compiledOutputSchema = compileCsvOutputSchema(job.outputSchema);
    await primeCsvOutputSchemaValidation(job.id, compiledOutputSchema);
    const config: JobConfig = {
      jobId: job.id,
      instruction: job.instruction,
      ...(job.outputSchema !== undefined
        ? { outputSchema: job.outputSchema, compiledOutputSchema }
        : {}),
      maxConcurrency: Math.min(
        job.requestedMaxConcurrency,
        this.opts.maxConcurrency === undefined
          ? job.requestedMaxConcurrency
          : requestedConcurrency(this.opts.maxConcurrency),
      ),
      ...(job.maxRuntimeSeconds !== undefined
        ? { maxRuntimeSeconds: job.maxRuntimeSeconds }
        : {}),
      maxResultBytes: job.maxResultBytes,
    };
    const state: JobRuntimeState = {
      config,
      items: new Map(),
      pending: new Map(),
      repository: this.opts.repository,
      ...(this.opts.threadOps !== undefined
        ? { threadOps: this.opts.threadOps }
        : {}),
      progress: new JobProgressEmitterImpl(this.opts.progressEmitter),
      progressCounters: createRuntimeProgressCountersFromJob(job),
      signal: this.controller.signal,
      preservePendingOnStop: true,
      counterAnomalyReconciled: false,
      stopRequested: false,
    };
    if (jobs.has(job.id)) {
      releaseCsvOutputSchemaValidation(job.id);
      this.finishRegistration(runtime);
      return;
    }
    jobs.set(job.id, state);
    runtime.job = job;
    runtime.state = state;
    runtime.initialized = true;
    state.progress.maybeEmit(job.id, computeProgressSnapshot(state), true);
  }

  private async stepJob(runtime: RecoveredJobRuntime): Promise<void> {
    if (runtime.finalized) return;
    await this.initializeRuntime(runtime);
    const state = runtime.state;
    const job = runtime.job;
    if (state === undefined || job === undefined || runtime.finalized) return;
    if (!this.registrationIsCurrent(runtime)) return;

    const claim = this.claimFor(runtime);
    runtime.rotationDue = false;
    if (this.opts.repository.rotateSupervisorRegistration(claim, false)) {
      this.releaseRegistrationWindow(runtime);
      this.suspendRuntime(runtime);
      return;
    }

    if (!runtime.recoveryScanDone || runtime.recoveryRows.size > 0) {
      await this.reconcileOneRunningItem(runtime);
      return;
    }

    if (runtime.ready.size <= CSV_READY_REFILL_LOW_WATERMARK) {
      this.refillReadyRows(runtime);
    }

    if (runtime.ready.size === 0 && runtime.inflight.size === 0) {
      const current = this.opts.repository.getJob(job.id);
      if (current === null) {
        this.finishRegistration(runtime);
        return;
      }
      if (current.pendingItems > 0) {
        if (this.opts.repository.rotateSupervisorRegistration(claim, true)) {
          this.releaseRegistrationWindow(runtime);
          this.suspendRuntime(runtime);
        }
        return;
      }
      if (current.runningItems === 0) {
        await this.finalizeRuntime(runtime);
      }
      return;
    }

    if (
      runtime.ready.size === 0 ||
      runtime.inflight.size >= state.config.maxConcurrency ||
      this.activeWorkers >= MAX_CSV_ACTIVE_WORKERS
    ) {
      return;
    }
    await this.admitOneReadyItem(runtime);
  }

  private async reconcileOneRunningItem(
    runtime: RecoveredJobRuntime,
  ): Promise<void> {
    if (runtime.recoveryRows.size === 0) {
      const remainingGlobal = MAX_CSV_READY_ROWS_GLOBAL - this.readyRowsGlobal;
      if (remainingGlobal <= 0) return;
      const page = this.opts.repository.listItemsForScheduler({
        jobId: runtime.registration.jobId,
        status: "running",
        limit: Math.min(CSV_RECOVERY_PAGE_ROWS, remainingGlobal),
        ...(runtime.recoveryCursor !== undefined
          ? { cursor: runtime.recoveryCursor }
          : {}),
      });
      for (const item of page.items) {
        runtime.recoveryRows.enqueue(item);
        this.readyRowsGlobal += 1;
      }
      runtime.recoveryCursor = page.nextCursor;
      if (page.nextCursor === undefined) runtime.recoveryScanDone = true;
    }
    const stored = runtime.recoveryRows.dequeue();
    if (stored === undefined) return;
    this.readyRowsGlobal -= 1;
    const item = itemFromStored(
      runtime.job!.instruction,
      stored,
      stored.row as CsvRow,
    );
    await reconcileRestartedItem(this.opts, stored, item);
    synchronizeRuntimeProgressCounters(runtime.state!);
    this.adoptIdempotencyProfile(runtime.state!, stored);
  }

  private refillReadyRows(runtime: RecoveredJobRuntime): void {
    const perJobRoom = MAX_CSV_READY_ROWS_PER_JOB - runtime.ready.size;
    const globalRoom = MAX_CSV_READY_ROWS_GLOBAL - this.readyRowsGlobal;
    const limit = Math.min(CSV_RECOVERY_PAGE_ROWS, perJobRoom, globalRoom);
    if (limit <= 0) return;
    const page = this.opts.repository.listReadyItemsForSupervisor(
      this.claimFor(runtime),
      limit,
    );
    for (const stored of page.items) {
      if (runtime.readyIds.has(stored.itemId)) continue;
      const item = itemFromStored(
        runtime.job!.instruction,
        stored,
        stored.row as CsvRow,
      );
      runtime.state!.items.set(item.itemId, item);
      this.adoptIdempotencyProfile(runtime.state!, stored);
      runtime.ready.enqueue(item.itemId);
      runtime.readyIds.add(item.itemId);
      this.readyRowsGlobal += 1;
      if (
        runtime.ready.size >= MAX_CSV_READY_ROWS_PER_JOB ||
        this.readyRowsGlobal >= MAX_CSV_READY_ROWS_GLOBAL
      ) {
        break;
      }
    }
  }

  private adoptIdempotencyProfile(
    state: JobRuntimeState,
    stored: CsvAgentJobItem,
  ): void {
    if (stored.idempotencyProfile === undefined) return;
    const candidate = this.opts.idempotencyProfiles?.get(
      stored.idempotencyProfile,
    );
    if (candidate === undefined) return;
    if (
      state.idempotencyProfile !== undefined &&
      state.idempotencyProfile.name !== candidate.name
    ) {
      throw new Error(`CSV job ${stored.jobId} mixes idempotency profiles`);
    }
    state.idempotencyProfile = candidate;
  }

  private async admitOneReadyItem(runtime: RecoveredJobRuntime): Promise<void> {
    const itemId = runtime.ready.dequeue();
    if (itemId === undefined) return;
    runtime.readyIds.delete(itemId);
    this.readyRowsGlobal -= 1;
    const claim = this.claimFor(runtime);
    let capacity: AgentJobCapacityOutcome | undefined;
    try {
      capacity = await this.opts.spawn.acquireCapacity?.({
        jobId: claim.jobId,
        itemId,
        signal: this.controller.signal,
      });
    } catch (error) {
      if (this.controller.signal.aborted) return;
      throw error;
    }
    if (capacity?.kind === "capacity_unavailable") {
      runtime.ready.enqueueFront(itemId);
      runtime.readyIds.add(itemId);
      this.readyRowsGlobal += 1;
      await delay(
        capacity.retryAfterMs ?? CSV_CAPACITY_RETRY_DELAY_MS,
        this.controller.signal,
      );
      return;
    }
    if (this.controller.signal.aborted) {
      if (capacity?.kind === "acquired") capacity.permit.cancel();
      return;
    }
    this.launchOwnedWorker(runtime, itemId, capacity, claim);
    if (this.opts.repository.rotateSupervisorRegistration(claim, false)) {
      this.releaseRegistrationWindow(runtime);
      this.suspendRuntime(runtime);
    }
  }

  private launchOwnedWorker(
    runtime: RecoveredJobRuntime,
    itemId: ItemId,
    capacity: AgentJobCapacityOutcome | undefined,
    claim: CsvJobSupervisorRegistrationClaim,
  ): void {
    this.activeWorkers += 1;
    let owned!: Promise<void>;
    owned = (async () => {
      try {
        const outcome = await runOneItem(
          runtime.state!,
          this.opts.spawn,
          itemId,
          capacity,
          claim,
          this.opts.spawn.acquireCapacity !== undefined,
        );
        if (
          outcome.retryItemId !== undefined &&
          this.registrationIsCurrent(runtime) &&
          runtime.ready.size < MAX_CSV_READY_ROWS_PER_JOB &&
          this.readyRowsGlobal < MAX_CSV_READY_ROWS_GLOBAL
        ) {
          runtime.ready.enqueueFront(outcome.retryItemId);
          runtime.readyIds.add(outcome.retryItemId);
          this.readyRowsGlobal += 1;
        } else {
          runtime.state!.items.delete(itemId);
        }
        runtime.state!.progress.maybeEmit(
          runtime.registration.jobId,
          computeProgressSnapshot(runtime.state!),
          false,
        );
      } catch (error) {
        if (!this.controller.signal.aborted) {
          reconcileRuntimeCounterAnomalyOnce(runtime.state!, error);
          this.fatalFailure = { error, runtime };
          this.controller.abort(error);
        }
      } finally {
        runtime.inflight.delete(owned);
        this.ownedWorkers.delete(owned);
        this.activeWorkers -= 1;
        this.notifyWorkerSettlement();
        if (runtime.finalized && runtime.inflight.size === 0) {
          this.releaseRuntime(runtime);
        } else if (
          runtime.inflight.size === 0 &&
          !this.registrationIsCurrent(runtime)
        ) {
          this.completeRotationAndRelease(runtime);
        }
        this.wakeNextGlobalCapacityWaiter();
        this.enqueueForRoundIfRunnable(runtime);
      }
    })();
    runtime.inflight.add(owned);
    this.ownedWorkers.add(owned);
  }

  private async finalizeRuntime(runtime: RecoveredJobRuntime): Promise<void> {
    if (runtime.finalized) return;
    const job = this.opts.repository.getJob(runtime.registration.jobId);
    if (job === null) {
      this.finishRegistration(runtime);
      return;
    }
    const reconciliation = this.opts.repository.reconcileJobCounters(
      job.id,
      "finalization",
    );
    if (!reconciliation.matches) {
      this.finishRegistration(runtime);
      return;
    }
    let outputArtifact: CsvOutputArtifact | undefined;
    if (job.autoExport && job.outputCsvPath.length > 0) {
      if (this.opts.outputRootCapability === undefined) {
        throw new Error(
          "resuming CSV output requires an authenticated CsvOutputRootCapability",
        );
      }
      const items = this.recoveredOutputItems(job);
      outputArtifact = await writeOutputCsv(
        job.outputCsvPath,
        this.opts.outputRootCapability,
        job.outputMode,
        job.inputHeaders,
        job.id,
        items,
        this.controller.signal,
        this.opts.repository,
      );
    }
    this.opts.repository.refreshJobOutcome(job.id);
    runtime.state!.progress.maybeEmit(
      job.id,
      computeProgressSnapshot(runtime.state!),
      true,
    );
    this.results.push(buildRunResult(runtime.state!, outputArtifact));
    this.finishRegistration(runtime);
  }

  private reconcileCounterAnomalyOnce(
    runtime: RecoveredJobRuntime,
    error: unknown,
  ): void {
    if (!(error instanceof CsvRuntimeCounterIntegrityError)) return;
    if (runtime.state !== undefined) {
      reconcileRuntimeCounterAnomalyOnce(runtime.state, error);
    } else {
      this.opts.repository.reconcileJobCounters(
        runtime.registration.jobId,
        "anomaly",
      );
    }
  }

  private *recoveredOutputItems(
    job: CsvAgentJob,
  ): IterableIterator<JobItemRecord> {
    for (const stored of this.opts.repository.iterateItemsForScheduler(
      job.id,
      CSV_RECOVERY_PAGE_ROWS,
    )) {
      yield itemFromStored(job.instruction, stored, stored.row as CsvRow);
    }
  }

  private finishRegistration(runtime: RecoveredJobRuntime): void {
    if (runtime.finalized) return;
    runtime.finalized = true;
    this.releaseRegistrationWindow(runtime);
    this.opts.repository.finishSupervisorRegistration(this.claimFor(runtime));
    this.spillReadyRows(runtime);
    if (runtime.inflight.size === 0) this.releaseRuntime(runtime);
  }

  private releaseRuntime(runtime: RecoveredJobRuntime): void {
    const jobId = runtime.registration.jobId;
    this.releaseRegistrationWindow(runtime);
    this.globalCapacityWaiterIds.delete(jobId);
    jobs.delete(jobId);
    releaseCsvOutputSchemaValidation(jobId);
    this.active.delete(jobId);
  }

  private spillReadyRows(runtime: RecoveredJobRuntime): void {
    while (runtime.ready.dequeue() !== undefined) {
      this.readyRowsGlobal -= 1;
    }
    while (runtime.recoveryRows.dequeue() !== undefined) {
      this.readyRowsGlobal -= 1;
    }
    runtime.readyIds.clear();
    for (const [itemId, item] of runtime.state?.items ?? []) {
      if (item.status === "pending") runtime.state!.items.delete(itemId);
    }
  }

  private suspendRuntime(runtime: RecoveredJobRuntime): void {
    this.releaseRegistrationWindow(runtime);
    this.spillReadyRows(runtime);
    if (runtime.inflight.size === 0) this.completeRotationAndRelease(runtime);
  }

  private completeRotationAndRelease(runtime: RecoveredJobRuntime): void {
    this.opts.repository.completeSupervisorRotation(this.claimFor(runtime));
    this.releaseRuntime(runtime);
  }

  private registrationIsCurrent(runtime: RecoveredJobRuntime): boolean {
    const current = this.opts.repository.getSupervisorRegistration(
      runtime.registration.jobId,
    );
    return (
      current !== null &&
      current.substate === "registered" &&
      current.supervisorEpoch === runtime.registration.supervisorEpoch &&
      current.registrationGeneration ===
        runtime.registration.registrationGeneration
    );
  }

  private claimFor(
    runtime: RecoveredJobRuntime,
  ): CsvJobSupervisorRegistrationClaim {
    return {
      supervisorEpoch: runtime.registration.supervisorEpoch,
      jobId: runtime.registration.jobId,
      registrationGeneration: runtime.registration.registrationGeneration,
    };
  }

  private enqueueForRoundIfRunnable(runtime: RecoveredJobRuntime): void {
    if (
      runtime.finalized ||
      runtime.queuedForRound ||
      !this.registrationIsCurrent(runtime)
    ) {
      return;
    }
    if (!this.runtimeCanMakeImmediateProgress(runtime)) {
      this.blockOnGlobalCapacity(runtime);
      return;
    }
    this.globalCapacityWaiterIds.delete(runtime.registration.jobId);
    runtime.queuedForRound = true;
    this.round.enqueue(runtime.registration.jobId);
  }

  private runtimeCanMakeImmediateProgress(
    runtime: RecoveredJobRuntime,
  ): boolean {
    if (runtime.rotationDue) return true;
    if (!runtime.initialized) return true;
    if (!runtime.recoveryScanDone || runtime.recoveryRows.size > 0) return true;
    const state = runtime.state;
    if (state === undefined) return true;
    if (runtime.ready.size === 0) return runtime.inflight.size === 0;
    return (
      runtime.inflight.size < state.config.maxConcurrency &&
      this.activeWorkers < MAX_CSV_ACTIVE_WORKERS
    );
  }

  private scheduleRegistrationHoldWake(runtime: RecoveredJobRuntime): void {
    this.clearRegistrationHoldWake(runtime);
    if (!this.supervisorStarted || !runtime.registrationHeld) {
      return;
    }
    const registeredAt =
      runtime.registration.registeredAtMs ?? runtime.registration.updatedAtMs;
    const remainingMs = Math.max(
      0,
      registeredAt + MAX_CSV_JOB_REGISTRATION_HOLD_MS - Date.now(),
    );
    runtime.holdWakeTimer = setTimeout(() => {
      runtime.holdWakeTimer = undefined;
      if (
        this.controller.signal.aborted ||
        !runtime.registrationHeld ||
        runtime.finalized
      ) {
        return;
      }
      runtime.rotationDue = true;
      this.enqueueForRoundIfRunnable(runtime);
      this.notifySupervisorWake();
    }, remainingMs);
    runtime.holdWakeTimer.unref?.();
  }

  private clearRegistrationHoldWake(runtime: RecoveredJobRuntime): void {
    if (runtime.holdWakeTimer === undefined) return;
    clearTimeout(runtime.holdWakeTimer);
    runtime.holdWakeTimer = undefined;
  }

  private releaseRegistrationWindow(runtime: RecoveredJobRuntime): void {
    this.clearRegistrationHoldWake(runtime);
    runtime.rotationDue = false;
    if (!runtime.registrationHeld) return;
    runtime.registrationHeld = false;
    this.registeredRuntimeCountValue -= 1;
  }

  private blockOnGlobalCapacity(runtime: RecoveredJobRuntime): void {
    const state = runtime.state;
    if (
      state === undefined ||
      runtime.ready.size === 0 ||
      runtime.inflight.size >= state.config.maxConcurrency ||
      this.activeWorkers < MAX_CSV_ACTIVE_WORKERS
    ) {
      return;
    }
    const jobId = runtime.registration.jobId;
    if (this.globalCapacityWaiterIds.has(jobId)) return;
    this.globalCapacityWaiterIds.add(jobId);
    this.globalCapacityWaiters.enqueue(jobId);
  }

  private wakeNextGlobalCapacityWaiter(): void {
    while (this.globalCapacityWaiters.size > 0) {
      const jobId = this.globalCapacityWaiters.dequeue();
      if (jobId === undefined || !this.globalCapacityWaiterIds.delete(jobId)) {
        continue;
      }
      const runtime = this.active.get(jobId);
      if (
        runtime === undefined ||
        runtime.finalized ||
        !this.registrationIsCurrent(runtime)
      ) {
        continue;
      }
      if (!this.runtimeCanMakeImmediateProgress(runtime)) {
        this.blockOnGlobalCapacity(runtime);
        return;
      }
      this.enqueueForRoundIfRunnable(runtime);
      return;
    }
  }

  private async waitForWorkerSettlementOrShutdown(): Promise<void> {
    if (this.controller.signal.aborted || this.ownedWorkers.size === 0) return;
    const workerSettled = this.nextWorkerSettlement();
    const supervisorWake = this.nextSupervisorWake();
    let onAbort!: () => void;
    const shutdown = new Promise<void>((resolve) => {
      onAbort = resolve;
      this.controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      await Promise.race([workerSettled, supervisorWake, shutdown]);
    } finally {
      this.controller.signal.removeEventListener("abort", onAbort);
    }
  }

  private nextWorkerSettlement(): Promise<void> {
    if (this.workerSettlementWaiter === undefined) {
      let resolve!: () => void;
      const promise = new Promise<void>((settled) => {
        resolve = settled;
      });
      this.workerSettlementWaiter = { promise, resolve };
    }
    return this.workerSettlementWaiter.promise;
  }

  private notifyWorkerSettlement(): void {
    const waiter = this.workerSettlementWaiter;
    this.workerSettlementWaiter = undefined;
    waiter?.resolve();
  }

  private nextSupervisorWake(): Promise<void> {
    if (this.supervisorWakeWaiter === undefined) {
      let resolve!: () => void;
      const promise = new Promise<void>((settled) => {
        resolve = settled;
      });
      this.supervisorWakeWaiter = { promise, resolve };
    }
    return this.supervisorWakeWaiter.promise;
  }

  private notifySupervisorWake(): void {
    const waiter = this.supervisorWakeWaiter;
    this.supervisorWakeWaiter = undefined;
    waiter?.resolve();
  }

  private throwFatalFailureIfPresent(): void {
    const failure = this.fatalFailure;
    if (failure === undefined) return;
    if (failure.runtime !== undefined) {
      this.reconcileCounterAnomalyOnce(failure.runtime, failure.error);
    }
    throw failure.error;
  }

  private settleStartupSuccess(): void {
    if (this.startupSettled) return;
    this.startupSettled = true;
    this.resolveStartup(this.startedJobs);
  }

  private settleStartupFailure(error: unknown): void {
    if (this.startupSettled) return;
    this.startupSettled = true;
    this.rejectStartup(error);
  }

  private async stopOwnedWork(): Promise<void> {
    for (const runtime of this.active.values()) {
      if (runtime.state !== undefined) runtime.state.stopRequested = true;
    }
    const cancellations = await Promise.allSettled(
      [...this.active.keys()].map((jobId) =>
        this.opts.spawn.cancelOutstanding(jobId),
      ),
    );
    await Promise.allSettled([...this.ownedWorkers]);
    for (const outcome of cancellations) {
      if (outcome.status === "rejected" && this.fatalFailure === undefined) {
        this.fatalFailure = { error: outcome.reason };
      }
    }
    for (const runtime of [...this.active.values()]) {
      this.spillReadyRows(runtime);
      if (runtime.inflight.size === 0) this.releaseRuntime(runtime);
    }
    this.settleStartupSuccess();
  }
}

export interface ResumeAgentJobsOpts {
  readonly repository: CsvAgentJobsRepository;
  readonly spawn: AgentJobSpawn;
  readonly threadOps?: AgentJobThreadOps;
  readonly progressEmitter?: AgentJobProgressEmitter;
  readonly maxConcurrency?: number;
  readonly idempotencyProfiles?: ReadonlyMap<string, CsvIdempotencyProfile>;
  readonly outputRootCapability?: CsvOutputRootCapability;
  readonly signal?: AbortSignal;
}

export async function resumeAgentJobsFromRepository(
  opts: ResumeAgentJobsOpts,
): Promise<RunAgentsOnCsvResult[]> {
  const supervisor = new CsvJobRecoverySupervisor(opts);
  await supervisor.start();
  return supervisor.waitForCompletion();
}

function itemFromStored(
  instruction: string,
  stored: CsvAgentJobItem,
  row: CsvRow,
): JobItemRecord {
  return {
    jobId: stored.jobId,
    itemId: stored.itemId,
    rowIndex: stored.rowIndex,
    ...(stored.sourceId !== undefined ? { sourceId: stored.sourceId } : {}),
    contentSha256: stored.contentSha256 ?? "0".repeat(64),
    workerName: stored.workerName,
    row,
    instruction,
    status: stored.status,
    attemptCount: stored.attemptCount,
    resultAvailability: stored.resultAvailability,
    ...(stored.assignedThreadId !== undefined
      ? { assignedThreadId: stored.assignedThreadId }
      : {}),
    ...(stored.operationKey !== undefined
      ? { operationKey: stored.operationKey }
      : {}),
    ...(stored.result !== undefined ? { result: stored.result } : {}),
    ...(stored.lastError !== undefined ? { error: stored.lastError } : {}),
    ...(stored.reviewReason !== undefined
      ? { reviewReason: stored.reviewReason }
      : {}),
    ...(stored.reportedAt !== undefined
      ? { reportedAt: new Date(stored.reportedAt * 1_000) }
      : {}),
    ...(stored.completedAt !== undefined
      ? { completedAt: new Date(stored.completedAt * 1_000) }
      : {}),
  };
}

async function reconcileRestartedItem(
  opts: ResumeAgentJobsOpts,
  stored: CsvAgentJobItem,
  item: JobItemRecord,
): Promise<void> {
  if (stored.assignedThreadId !== undefined && opts.threadOps !== undefined) {
    try {
      const status = await opts.threadOps.getStatus(stored.assignedThreadId);
      if (
        status.kind === "running" ||
        status.kind === "pending_init" ||
        status.kind === "interrupted"
      ) {
        await opts.threadOps.shutdownThread(stored.assignedThreadId);
      }
    } catch (error) {
      const reason = `CSV recovered worker retirement is unresolved: ${
        error instanceof Error ? error.message : String(error)
      }`;
      opts.repository.markItemUnknownOutcome(
        stored.jobId,
        stored.itemId,
        reason,
      );
      item.status = "unknown_outcome";
      item.error = reason;
      item.reviewReason = reason;
      return;
    }
  }
  if (
    stored.resultAvailability === "available" &&
    stored.result !== undefined
  ) {
    opts.repository.markItemCompleted(
      stored.jobId,
      stored.itemId,
      stored.result,
    );
    item.status = "completed";
    return;
  }
  if (stored.dispatchState === "not_dispatched") {
    opts.repository.markItemPending(stored.jobId, stored.itemId);
    item.status = "pending";
    return;
  }
  const profile =
    stored.idempotencyProfile === undefined
      ? undefined
      : opts.idempotencyProfiles?.get(stored.idempotencyProfile);
  const evidenceComplete =
    profile !== undefined &&
    stored.idempotencyProfileVersion === profile.version &&
    stored.operationKey !== undefined &&
    stored.providerAcknowledgedKey === stored.operationKey;
  if (
    !evidenceComplete ||
    profile === undefined ||
    stored.operationKey === undefined
  ) {
    const reason =
      stored.identityFormatVersion === 0
        ? "legacy_csv_ambiguous"
        : "CSV dispatch lacks authoritative idempotency evidence";
    opts.repository.markItemUnknownOutcome(stored.jobId, stored.itemId, reason);
    item.status = "unknown_outcome";
    item.error = reason;
    item.reviewReason = reason;
    return;
  }
  let lookup: CsvIdempotencyLookupOutcome;
  try {
    lookup = await boundedLookup(profile, stored, opts.signal);
  } catch (error) {
    lookup = {
      kind: "unknown",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  if (lookup.kind === "not_found") {
    opts.repository.markItemPending(
      stored.jobId,
      stored.itemId,
      lookup.evidence,
    );
    item.status = "pending";
    item.operationKey = stored.operationKey;
    return;
  }
  if (lookup.kind === "committed") {
    const reason = "CSV idempotency lookup confirmed the dispatch committed";
    const evidenceDigest = canonicalizeCsvResult(lookup.evidence).digest;
    const evidenceReferenceDigest = createHash("sha256")
      .update(profile.name)
      .update("\0")
      .update(String(profile.version))
      .update("\0")
      .update(stored.operationKey)
      .digest("hex");
    opts.repository.markItemUnknownOutcome(
      stored.jobId,
      stored.itemId,
      reason,
      lookup.evidence,
    );
    await opts.repository.resolveUnknownOutcome({
      jobId: stored.jobId,
      itemId: stored.itemId,
      disposition: "confirmed_committed",
      domainAction: "mark_completed",
      evidence: lookup.evidence,
      actor: "csv_idempotency_profile",
      reason,
      ...(stored.effect !== undefined
        ? {
            effectReview: {
              version: 1,
              kind: "effect_review_resolution",
              disposition: "confirmed_committed",
              actorKind: "system_settlement",
              actorId: "csv_idempotency_profile",
              evidenceKind: "idempotency_lookup",
              evidenceRef: `csv-idempotency-lookup:${evidenceReferenceDigest}`,
              evidenceSha256: evidenceDigest,
              reviewedAt: new Date().toISOString(),
              workflowStatus: "resolved",
              domainAction: "mark_completed",
            },
          }
        : {}),
      ...(lookup.result !== undefined ? { result: lookup.result } : {}),
    });
    item.status = "completed";
    item.resultAvailability =
      lookup.result === undefined ? "unavailable_after_review" : "available";
    if (lookup.result !== undefined) item.result = lookup.result;
    return;
  }
  opts.repository.markItemUnknownOutcome(
    stored.jobId,
    stored.itemId,
    lookup.reason,
    lookup.evidence,
  );
  item.status = "unknown_outcome";
  item.error = lookup.reason;
  item.reviewReason = lookup.reason;
}

async function boundedLookup(
  profile: CsvIdempotencyProfile,
  stored: CsvAgentJobItem,
  parentSignal: AbortSignal | undefined,
): Promise<CsvIdempotencyLookupOutcome> {
  const controller = new AbortController();
  const abort = (): void => controller.abort(parentSignal?.reason);
  parentSignal?.addEventListener("abort", abort, { once: true });
  if (parentSignal?.aborted === true) abort();
  const timer = setTimeout(
    () => controller.abort("CSV lookup timeout"),
    CSV_IDEMPOTENCY_LOOKUP_TIMEOUT_MS,
  );
  timer.unref?.();
  let rejectAbortedLookup: ((reason: Error) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbortedLookup = reject;
  });
  const onLookupAbort = (): void => {
    const reason =
      typeof controller.signal.reason === "string"
        ? controller.signal.reason
        : "CSV idempotency lookup aborted";
    rejectAbortedLookup?.(new Error(reason));
  };
  controller.signal.addEventListener("abort", onLookupAbort, { once: true });
  if (controller.signal.aborted) onLookupAbort();
  try {
    const lookup = profile.lookup({
      jobId: stored.jobId,
      itemId: stored.itemId,
      operationKey: stored.operationKey!,
      signal: controller.signal,
    });
    return await Promise.race([lookup, aborted]);
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener("abort", onLookupAbort);
    parentSignal?.removeEventListener("abort", abort);
  }
}

export interface RecordAgentJobResultArgs {
  readonly jobId: JobId;
  readonly itemId: ItemId;
  readonly result: Record<string, unknown>;
  readonly stop?: boolean;
}

export type RecordAgentJobResultOutcome =
  | { readonly kind: "ok" }
  | { readonly kind: "unknown_job" }
  | { readonly kind: "unknown_item" }
  | { readonly kind: "already_reported" }
  | { readonly kind: "schema_violation"; readonly reason: string };

export function recordAgentJobResult(
  args: RecordAgentJobResultArgs,
): RecordAgentJobResultOutcome {
  const state = jobs.get(args.jobId);
  if (state === undefined) return { kind: "unknown_job" };
  const item = state.items.get(args.itemId);
  if (item === undefined) return { kind: "unknown_item" };
  if (item.status !== "running") return { kind: "already_reported" };
  let canonical: CanonicalCsvResult;
  try {
    canonical = canonicalizeCsvResult(args.result);
  } catch (error) {
    return {
      kind: "schema_violation",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  const violation = state.config.compiledOutputSchema?.validate(
    canonical.value,
  );
  if (violation !== undefined && violation !== null) {
    return { kind: "schema_violation", reason: violation };
  }
  if (canonical.bytes > state.config.maxResultBytes) {
    return {
      kind: "schema_violation",
      reason: `result is ${canonical.bytes} bytes; limit is ${state.config.maxResultBytes}`,
    };
  }
  const now = new Date();
  try {
    assertRuntimeCountersMatchDurable(state);
    assertRuntimeItemTransition(state, item, "completed");
  } catch (error) {
    publishRuntimeFatalError(state, error);
    throw error;
  }
  try {
    state.repository?.markItemCompleted(
      args.jobId,
      args.itemId,
      canonical.value,
    );
  } catch (error) {
    return {
      kind: "schema_violation",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  item.result = canonical.value;
  transitionRuntimeItemStatus(state, item, "completed");
  item.resultAvailability = "available";
  item.reportedAt = now;
  item.completedAt = now;
  if (args.stop === true) state.stopRequested = true;
  state.pending.get(args.itemId)?.resolve();
  state.pending.delete(args.itemId);
  return { kind: "ok" };
}

/** Production report path: schema execution runs in the shared owned pool. */
export async function recordAgentJobResultAsync(
  args: RecordAgentJobResultArgs,
): Promise<RecordAgentJobResultOutcome> {
  const state = jobs.get(args.jobId);
  if (state === undefined) return { kind: "unknown_job" };
  const item = state.items.get(args.itemId);
  if (item === undefined) return { kind: "unknown_item" };
  if (item.status !== "running") return { kind: "already_reported" };
  let canonical: CanonicalCsvResult;
  try {
    canonical = canonicalizeCsvResult(args.result);
  } catch (error) {
    return {
      kind: "schema_violation",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  let validated: Awaited<ReturnType<typeof validateCsvResultForPersistence>>;
  try {
    validated = await validateCsvResultForPersistence(
      args.jobId,
      args.itemId,
      state.config.compiledOutputSchema,
      canonical,
    );
  } catch (error) {
    return {
      kind: "schema_violation",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  if (typeof validated === "string") {
    return { kind: "schema_violation", reason: validated };
  }
  // Another report can win while this task waits in the fair pool.
  if (item.status !== "running") return { kind: "already_reported" };
  if (canonical.bytes > state.config.maxResultBytes) {
    return {
      kind: "schema_violation",
      reason: `result is ${canonical.bytes} bytes; limit is ${state.config.maxResultBytes}`,
    };
  }
  const now = new Date();
  try {
    assertRuntimeCountersMatchDurable(state);
    assertRuntimeItemTransition(state, item, "completed");
  } catch (error) {
    publishRuntimeFatalError(state, error);
    throw error;
  }
  try {
    state.repository?.markItemCompletedValidated(
      args.jobId,
      args.itemId,
      validated,
    );
  } catch (error) {
    return {
      kind: "schema_violation",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  item.result = canonical.value;
  transitionRuntimeItemStatus(state, item, "completed");
  item.resultAvailability = "available";
  item.reportedAt = now;
  item.completedAt = now;
  if (args.stop === true) state.stopRequested = true;
  state.pending.get(args.itemId)?.resolve();
  state.pending.delete(args.itemId);
  return { kind: "ok" };
}
