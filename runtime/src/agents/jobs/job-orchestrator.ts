/** CSV fan-out orchestration with bounded, at-most-once restart semantics. */

import { createHash, randomUUID } from "node:crypto";
import {
  CSV_CAPACITY_RETRY_DELAY_MS,
  CSV_DEFAULT_MAX_CONCURRENCY,
  CSV_DEFAULT_ITEM_PAGE_SIZE,
  CSV_IDEMPOTENCY_LOOKUP_TIMEOUT_MS,
  CSV_JOB_CONTRACT_VERSION,
  CSV_MAX_RESULT_BYTES,
  CSV_MAX_RESULT_PREVIEW_BYTES,
  CSV_MAX_ROWS,
  CSV_MAX_JOB_CONCURRENCY,
  CSV_MAX_JOB_SUMMARY_BYTES,
  CSV_WORKER_RETIRE_TIMEOUT_MS,
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
  type CsvAgentJobItem,
  type CsvAgentJobImportHandle,
  type CsvAgentJobItemCreateParams,
  type CsvAgentJobItemSummary,
  type CsvAgentJobSummary,
  type CsvAgentJobsRepository,
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
  readonly idempotencyProfile?: CsvIdempotencyProfile;
  readonly signal?: AbortSignal;
  stopRequested: boolean;
}

interface ProcessItemOutcome {
  readonly retryItemId?: ItemId;
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
  const counts = {
    totalItems: state.items.size,
    pendingItems: 0,
    runningItems: 0,
    completedItems: 0,
    failedItems: 0,
    cancelledItems: 0,
    unknownOutcomeItems: 0,
    reviewPendingItems: 0,
  };
  for (const item of state.items.values()) {
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
  const sorted = [...state.items.values()].sort(
    (left, right) => left.rowIndex - right.rowIndex,
  );
  const inMemoryPage = sorted.slice(0, CSV_DEFAULT_ITEM_PAGE_SIZE);
  const last = inMemoryPage.at(-1);
  const summary =
    state.repository?.getSummary(state.config.jobId) ?? inMemorySummary(state);
  const itemPage = [
    ...(repositoryPage?.items ?? inMemoryPage.map(itemSummary)),
  ];
  let nextItemCursor =
    repositoryPage?.nextCursor ??
    (sorted.length > inMemoryPage.length && last !== undefined
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
          items.set(identity.itemId, item);
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
    ...(opts.idempotencyProfile !== undefined
      ? { idempotencyProfile: opts.idempotencyProfile }
      : {}),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
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
            items,
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

async function processItems(
  state: JobRuntimeState,
  spawn: AgentJobSpawn,
): Promise<void> {
  const queue = [...state.items.values()]
    .filter((item) => item.status === "pending")
    .sort((left, right) => left.rowIndex - right.rowIndex)
    .map((item) => item.itemId);
  const inflight = new Set<Promise<ProcessItemOutcome>>();
  let cancelIssued = false;
  const onAbort = (): void => {
    state.stopRequested = true;
    for (const waiter of state.pending.values()) waiter.resolve();
  };
  state.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    while (queue.length > 0 || inflight.size > 0) {
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
        queue.length > 0
      ) {
        const itemId = queue.shift()!;
        const promise = runOneItem(state, spawn, itemId);
        inflight.add(promise);
        void promise.then(
          () => inflight.delete(promise),
          () => inflight.delete(promise),
        );
      }
      if (inflight.size === 0) break;
      const completed = await Promise.race(inflight);
      if (completed.retryItemId !== undefined)
        queue.unshift(completed.retryItemId);
      state.progress.maybeEmit(
        state.config.jobId,
        computeProgressSnapshot(state),
        false,
      );
    }
    if (state.stopRequested) {
      for (const item of state.items.values()) {
        if (item.status !== "pending") continue;
        item.status = "cancelled";
        item.completedAt = new Date();
        state.repository?.markItemCancelled(
          state.config.jobId,
          item.itemId,
          "CSV job cancelled before dispatch",
        );
      }
    }
  } catch (error) {
    state.stopRequested = true;
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
    const remaining = await Promise.allSettled([...inflight]);
    for (const outcome of remaining) {
      if (outcome.status === "rejected" && outcome.reason !== error) {
        cleanupFailures.push(outcome.reason);
      }
    }
    for (const item of state.items.values()) {
      if (item.status !== "pending") continue;
      item.status = "cancelled";
      item.completedAt = new Date();
      try {
        state.repository?.markItemCancelled(
          state.config.jobId,
          item.itemId,
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
): Promise<ProcessItemOutcome> {
  const item = state.items.get(itemId);
  if (item === undefined || item.status !== "pending") return {};
  if (state.stopRequested) return {};
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
    const capacity = await spawn.acquireCapacity?.({
      jobId: state.config.jobId,
      itemId,
      ...(state.signal !== undefined ? { signal: state.signal } : {}),
    });
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
      });
    } catch (error) {
      capacityPermit?.cancel();
      throw error;
    }
    item.status = "running";
    item.attemptCount += 1;
    dispatchBegan = true;
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
      item.status = "pending";
      state.repository?.markItemPending(state.config.jobId, itemId);
      await delay(
        outcome.retryAfterMs ?? CSV_CAPACITY_RETRY_DELAY_MS,
        state.signal,
      );
      return state.stopRequested ? {} : { retryItemId: itemId };
    }
    if (outcome.kind === "rejected") {
      capacityPermit?.cancel();
      item.status = "failed";
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
    if (item.status === "running") {
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
    while (item.status === "running" && !state.stopRequested) {
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
      if (event === "finished" && item.status === "running") {
        throw new Error("worker finished without recording a CSV job result");
      }
      if (event === "reported") break;
      if (
        state.repository?.getJob(state.config.jobId)?.status === "cancelled"
      ) {
        state.stopRequested = true;
      }
    }
    if (state.stopRequested && item.status === "running") {
      const reason = "CSV item outcome is ambiguous after cancellation";
      item.status = "unknown_outcome";
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
    if (dispatchBegan) {
      const cleanupFailures: unknown[] = [];
      if (
        (item.status as JobItemStatus) !== "unknown_outcome" ||
        !unknownOutcomePersisted
      ) {
        item.status = "unknown_outcome";
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
      item.status = "failed";
      item.error = reason;
      item.completedAt = new Date();
      state.repository?.markItemFailed(state.config.jobId, itemId, reason);
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
  items: ReadonlyMap<ItemId, JobItemRecord>,
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
  const sorted = [...items.values()].sort(
    (left, right) => left.rowIndex - right.rowIndex,
  );
  function* rows(): IterableIterator<ReadonlyArray<string>> {
    for (const item of sorted) {
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
    jobId: sorted[0]?.jobId ?? "csv-job",
    requestedPath: path,
    ...(mode !== undefined ? { mode } : {}),
    headers,
    rows: rows(),
    ...(signal !== undefined ? { signal } : {}),
    ...(intentStore !== undefined ? { intentStore } : {}),
  });
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
  const candidates = [
    ...opts.repository.listJobs({ status: "pending", limit: CSV_MAX_ROWS }),
    ...opts.repository.listJobs({ status: "running", limit: CSV_MAX_ROWS }),
  ];
  const results: RunAgentsOnCsvResult[] = [];
  for (const job of candidates) {
    opts.signal?.throwIfAborted();
    if (jobs.has(job.id) || job.executionGate !== "ready") continue;
    results.push(await resumeSingleJob(job.id, opts));
  }
  return results;
}

async function resumeSingleJob(
  jobId: JobId,
  opts: ResumeAgentJobsOpts,
): Promise<RunAgentsOnCsvResult> {
  const job = opts.repository.getJob(jobId);
  if (job === null) throw new Error(`cannot resume unknown CSV job ${jobId}`);
  const items = new Map<ItemId, JobItemRecord>();
  let resumeProfile: CsvIdempotencyProfile | undefined;
  for (const stored of opts.repository.listItems({
    jobId,
    limit: job.maxItems,
  })) {
    if (stored.idempotencyProfile !== undefined) {
      const candidate = opts.idempotencyProfiles?.get(
        stored.idempotencyProfile,
      );
      if (
        candidate !== undefined &&
        (resumeProfile === undefined || resumeProfile.name === candidate.name)
      ) {
        resumeProfile = candidate;
      } else if (candidate !== undefined) {
        throw new Error(`CSV job ${jobId} mixes idempotency profiles`);
      }
    }
    const row = stored.row as CsvRow;
    const item = itemFromStored(job.instruction, stored, row);
    if (stored.status === "running") {
      await reconcileRestartedItem(opts, stored, item);
    }
    items.set(item.itemId, item);
  }
  const hasUnknown = [...items.values()].some(
    (item) => item.status === "unknown_outcome",
  );
  const hasRunnable = [...items.values()].some(
    (item) => item.status === "pending",
  );
  const config: JobConfig = {
    jobId,
    instruction: job.instruction,
    ...(job.outputSchema !== undefined
      ? {
          outputSchema: job.outputSchema,
          compiledOutputSchema: compileCsvOutputSchema(job.outputSchema),
        }
      : {}),
    maxConcurrency: Math.min(
      job.requestedMaxConcurrency,
      opts.maxConcurrency === undefined
        ? job.requestedMaxConcurrency
        : requestedConcurrency(opts.maxConcurrency),
    ),
    ...(job.maxRuntimeSeconds !== undefined
      ? { maxRuntimeSeconds: job.maxRuntimeSeconds }
      : {}),
    maxResultBytes: job.maxResultBytes,
  };
  try {
    await primeCsvOutputSchemaValidation(jobId, config.compiledOutputSchema);
  } catch (error) {
    releaseCsvOutputSchemaValidation(jobId);
    throw error;
  }
  const state: JobRuntimeState = {
    config,
    items,
    pending: new Map(),
    repository: opts.repository,
    ...(opts.threadOps !== undefined ? { threadOps: opts.threadOps } : {}),
    progress: new JobProgressEmitterImpl(opts.progressEmitter),
    ...(resumeProfile !== undefined
      ? { idempotencyProfile: resumeProfile }
      : {}),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    stopRequested: false,
  };
  jobs.set(jobId, state);
  try {
    let outputArtifact: CsvOutputArtifact | undefined;
    // An ambiguous row is blocked, but it does not block independent rows.
    // Only a job made entirely of unresolved outcomes skips execution.
    if (!hasUnknown || hasRunnable) {
      opts.repository.markJobRunning(jobId, config.maxConcurrency);
      state.progress.maybeEmit(jobId, computeProgressSnapshot(state), true);
      await processItems(state, opts.spawn);
      if (job.autoExport && job.outputCsvPath.length > 0) {
        if (opts.outputRootCapability === undefined) {
          throw new Error(
            "resuming CSV output requires an authenticated CsvOutputRootCapability",
          );
        }
        outputArtifact = await writeOutputCsv(
          job.outputCsvPath,
          opts.outputRootCapability,
          job.outputMode,
          job.inputHeaders,
          items,
          opts.signal,
          opts.repository,
        );
      }
    }
    opts.repository.refreshJobOutcome(jobId);
    state.progress.maybeEmit(jobId, computeProgressSnapshot(state), true);
    return buildRunResult(state, outputArtifact);
  } catch (error) {
    const current = opts.repository.getJob(jobId);
    if (current !== null && current.status !== "needs_review") {
      opts.repository.markJobFailed(
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
  item.status = "completed";
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
  item.status = "completed";
  item.resultAvailability = "available";
  item.reportedAt = now;
  item.completedAt = now;
  if (args.stop === true) state.stopRequested = true;
  state.pending.get(args.itemId)?.resolve();
  state.pending.delete(args.itemId);
  return { kind: "ok" };
}
