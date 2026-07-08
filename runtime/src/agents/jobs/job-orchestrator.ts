/**
 * Agent-jobs orchestrator (reference parity).
 *
 * Port of reference `core/src/tools/handlers/agent_jobs.rs`. When a
 * `CsvAgentJobsRepository` is supplied, all job + item lifecycle
 * transitions are mirrored to the reference-compatible SQLite tables in
 * `state/csv-agent-jobs.ts`; jobs survive a daemon restart in the DB.
 * When the repository is omitted, the orchestrator runs purely
 * in-memory (used by tests that don't need persistence).
 *
 * Promises that resolve when a worker calls `report_agent_job_result`
 * are always tracked in process memory because Promises cannot be
 * persisted; after a daemon restart, in-flight jobs are visible in the
 * DB but their resolvers are gone (resume across restart is not yet
 * implemented).
 *
 * Surface:
 *   - `runAgentsOnCsv(opts)` — main entry. Parses the CSV, spawns one
 *     subagent per row up to `maxConcurrency`, awaits each item's
 *     `report_agent_job_result` call, and (optionally) writes the
 *     output CSV. Resolves with the per-item summary.
 *   - `recordAgentJobResult({ jobId, itemId, result, stop })` —
 *     called from the `report_agent_job_result` tool handler when a
 *     worker reports its result.
 *
 * @module
 */

import { writeFile } from "node:fs/promises";
import type { CsvAgentJobsRepository } from "../../state/csv-agent-jobs.js";
import { readCsvFile, writeCsv, type CsvRow } from "./csv-reader.js";
import { renderInstructionTemplate } from "./instruction-template.js";

export type JobId = string;
export type ItemId = string;

export type JobItemStatus = "pending" | "completed" | "failed" | "cancelled";

export interface JobItemRecord {
  readonly jobId: JobId;
  readonly itemId: ItemId;
  readonly rowIndex: number;
  readonly sourceId?: string;
  readonly row: CsvRow;
  readonly instruction: string;
  status: JobItemStatus;
  attemptCount: number;
  assignedThreadId?: string;
  result?: Record<string, unknown>;
  error?: string;
  reportedAt?: Date;
  completedAt?: Date;
}

export interface JobConfig {
  readonly jobId: JobId;
  readonly instruction: string;
  readonly outputSchema?: Record<string, unknown>;
  readonly maxConcurrency: number;
  readonly maxRuntimeSeconds: number;
}

export interface AgentJobSpawnContext {
  readonly jobId: JobId;
  readonly itemId: ItemId;
  readonly workerPrompt: string;
  readonly row: CsvRow;
}

export interface AgentJobSpawnOutcome {
  readonly threadId?: string;
  /**
   * Resolves when the spawned worker thread reaches a terminal status
   * (`completed | errored | shutdown | not_found`). The orchestrator
   * uses this to detect workers that finish without calling
   * `report_agent_job_result` and apply reference `finalize_finished_item`
   * guard at `agent_jobs.rs:992-1004` ("worker finished without calling
   * report_agent_job_result"). Adapters that cannot observe terminal
   * status may omit this field; the orchestrator falls back to the
   * `max_runtime_seconds` timeout in that case.
   */
  readonly threadFinished?: Promise<void>;
}

export interface AgentJobSpawn {
  spawn(ctx: AgentJobSpawnContext): Promise<AgentJobSpawnOutcome | void>;
  cancelOutstanding(jobId: JobId): Promise<void>;
}

/**
 * Optional thread-control surface used by `recoverRunningItems`. Mirrors
 * the slice of the reference `AgentControl` that the recovery path touches:
 *   - `agent_control.get_status(thread_id)` (agent_jobs.rs:877)
 *   - `agent_control.shutdown_live_agent(thread_id)` (agent_jobs.rs:850)
 *
 * Adapters that cannot observe live thread state may omit this field;
 * recovery degrades to "stale → fail; no thread id → fail; otherwise
 * leave alone".
 */
export interface AgentJobThreadOps {
  getStatus(
    threadId: string,
  ): Promise<{ kind: "running" | "pending_init" | "interrupted" } | { kind: "completed"; lastMessage?: string } | { kind: "errored"; reason: string } | { kind: "shutdown" } | { kind: "not_found" }>;
  shutdownThread(threadId: string): Promise<void>;
}

/**
 * One progress notification, mirroring reference `AgentJobProgressUpdate`
 * (the payload of `agent_job_progress:{...}` events emitted via
 * `notify_background_event` at `agent_jobs.rs:172-174`). Fields match
 * the reference serialized struct exactly.
 */
export interface AgentJobProgressUpdate {
  readonly jobId: JobId;
  readonly totalItems: number;
  readonly pendingItems: number;
  readonly runningItems: number;
  readonly completedItems: number;
  readonly failedItems: number;
  readonly etaSeconds?: number;
}

export type AgentJobProgressEmitter = (
  update: AgentJobProgressUpdate,
) => void;

export interface RunAgentsOnCsvOpts {
  readonly csvPath: string;
  readonly instruction: string;
  readonly idColumn?: string;
  readonly outputCsvPath?: string;
  readonly maxConcurrency?: number;
  readonly maxRuntimeSeconds?: number;
  readonly outputSchema?: Record<string, unknown>;
  readonly spawn: AgentJobSpawn;
  readonly repository?: CsvAgentJobsRepository;
  readonly jobName?: string;
  readonly threadOps?: AgentJobThreadOps;
  /**
   * Optional progress callback. The orchestrator rate-limits emissions
   * to one per second except when state actually changes (matches reference
   * `JobProgressEmitter::maybe_emit` at `agent_jobs.rs:134-179`). The
   * caller is responsible for serializing the update to a JSON-encoded
   * `agent_job_progress:{payload}` event if it wants byte-for-byte
   * reference parity on the emitted line.
   */
  readonly progressEmitter?: AgentJobProgressEmitter;
}

export interface RunAgentsOnCsvResult {
  readonly jobId: JobId;
  readonly items: ReadonlyArray<JobItemRecord>;
  readonly stoppedEarly: boolean;
  readonly outputCsvPath?: string;
}

const DEFAULT_MAX_CONCURRENCY = 16;
const DEFAULT_MAX_RUNTIME_SECONDS = 1800;

interface JobRuntimeState {
  readonly config: JobConfig;
  readonly items: Map<ItemId, JobItemRecord>;
  readonly pending: Map<
    ItemId,
    { resolve: (value: void) => void; reject: (err: Error) => void }
  >;
  readonly repository?: CsvAgentJobsRepository;
  readonly threadOps?: AgentJobThreadOps;
  readonly progress: JobProgressEmitterImpl;
  stopRequested: boolean;
}

/**
 * Port of reference `JobProgressEmitter` at `agent_jobs.rs:113-180`.
 * Decides when to fire a progress callback: forced (init/completion),
 * or when the processed/failed counts change, or when 1 second has
 * elapsed since the last emission. Computes `eta_seconds` from
 * processed-rate (matches reference agent_jobs.rs:150-161).
 */
class JobProgressEmitterImpl {
  private readonly startedAtMs = Date.now();
  private lastEmitAtMs = 0;
  private lastProcessed = 0;
  private lastFailed = 0;
  private static readonly EMIT_INTERVAL_MS = 1000;

  constructor(private readonly emit: AgentJobProgressEmitter | undefined) {}

  maybeEmit(
    jobId: JobId,
    progress: {
      readonly totalItems: number;
      readonly pendingItems: number;
      readonly runningItems: number;
      readonly completedItems: number;
      readonly failedItems: number;
    },
    force: boolean,
  ): void {
    if (this.emit === undefined) return;
    const processed = progress.completedItems + progress.failedItems;
    const elapsedSinceLastMs = Date.now() - this.lastEmitAtMs;
    const shouldEmit =
      force ||
      processed !== this.lastProcessed ||
      progress.failedItems !== this.lastFailed ||
      elapsedSinceLastMs >= JobProgressEmitterImpl.EMIT_INTERVAL_MS;
    if (!shouldEmit) return;
    const elapsedSec = (Date.now() - this.startedAtMs) / 1000;
    let etaSeconds: number | undefined;
    if (processed > 0 && elapsedSec > 0) {
      const rate = processed / elapsedSec;
      if (rate > 0) {
        const remaining = Math.max(0, progress.totalItems - processed);
        etaSeconds = Math.round(remaining / rate);
      }
    }
    this.emit({
      jobId,
      totalItems: progress.totalItems,
      pendingItems: progress.pendingItems,
      runningItems: progress.runningItems,
      completedItems: progress.completedItems,
      failedItems: progress.failedItems,
      ...(etaSeconds !== undefined ? { etaSeconds } : {}),
    });
    this.lastEmitAtMs = Date.now();
    this.lastProcessed = processed;
    this.lastFailed = progress.failedItems;
  }
}

function computeProgressSnapshot(state: JobRuntimeState): {
  readonly totalItems: number;
  readonly pendingItems: number;
  readonly runningItems: number;
  readonly completedItems: number;
  readonly failedItems: number;
} {
  if (state.repository !== undefined) {
    return state.repository.getJobProgress(state.config.jobId);
  }
  let pending = 0;
  let running = 0;
  let completed = 0;
  let failed = 0;
  for (const item of state.items.values()) {
    switch (item.status) {
      case "pending":
        pending += 1;
        break;
      case "completed":
        completed += 1;
        break;
      case "failed":
        failed += 1;
        break;
      case "cancelled":
        // The reference AgentJobItemStatus has no Cancelled; mapping cancelled
        // items into failedItems for the purpose of progress counts
        // matches "processed = completed + failed" in the emitter.
        failed += 1;
        break;
    }
    if (item.assignedThreadId !== undefined && item.status === "pending") {
      running += 1;
    }
  }
  return {
    totalItems: state.items.size,
    pendingItems: pending,
    runningItems: running,
    completedItems: completed,
    failedItems: failed,
  };
}

const jobs: Map<JobId, JobRuntimeState> = new Map();

function freshJobId(): JobId {
  return `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export async function runAgentsOnCsv(
  opts: RunAgentsOnCsvOpts,
): Promise<RunAgentsOnCsvResult> {
  const csv = await readCsvFile(opts.csvPath);
  if (csv.rows.length === 0) {
    throw new Error("csv_path produced zero data rows");
  }
  if (opts.idColumn !== undefined && !csv.headers.includes(opts.idColumn)) {
    throw new Error(`id_column "${opts.idColumn}" is not in the CSV header`);
  }
  const jobId = freshJobId();
  const config: JobConfig = {
    jobId,
    instruction: opts.instruction,
    ...(opts.outputSchema !== undefined ? { outputSchema: opts.outputSchema } : {}),
    maxConcurrency: clampConcurrency(opts.maxConcurrency),
    maxRuntimeSeconds: opts.maxRuntimeSeconds ?? DEFAULT_MAX_RUNTIME_SECONDS,
  };
  const items = new Map<ItemId, JobItemRecord>();
  const itemSeed: Array<{
    itemId: string;
    rowIndex: number;
    sourceId?: string;
    row: CsvRow;
  }> = [];
  csv.rows.forEach((row, index) => {
    const itemId =
      opts.idColumn !== undefined
        ? (row[opts.idColumn] ?? `item_${index}`)
        : `item_${index}`;
    const rendered = renderInstructionTemplate(opts.instruction, row);
    const sourceId =
      opts.idColumn !== undefined ? row[opts.idColumn] : undefined;
    items.set(itemId, {
      jobId,
      itemId,
      rowIndex: index,
      ...(sourceId !== undefined ? { sourceId } : {}),
      row,
      instruction: rendered,
      status: "pending",
      attemptCount: 0,
    });
    itemSeed.push({
      itemId,
      rowIndex: index,
      ...(sourceId !== undefined ? { sourceId } : {}),
      row,
    });
  });

  if (opts.repository !== undefined) {
    opts.repository.createJob(
      {
        id: jobId,
        name: opts.jobName ?? jobId,
        instruction: opts.instruction,
        autoExport: opts.outputCsvPath !== undefined,
        ...(opts.maxRuntimeSeconds !== undefined
          ? { maxRuntimeSeconds: opts.maxRuntimeSeconds }
          : {}),
        ...(opts.outputSchema !== undefined
          ? { outputSchema: opts.outputSchema }
          : {}),
        inputHeaders: csv.headers,
        inputCsvPath: opts.csvPath,
        outputCsvPath: opts.outputCsvPath ?? "",
      },
      itemSeed.map((seed) => ({
        itemId: seed.itemId,
        rowIndex: seed.rowIndex,
        ...(seed.sourceId !== undefined ? { sourceId: seed.sourceId } : {}),
        row: seed.row,
      })),
    );
    opts.repository.markJobRunning(jobId);
  }

  const state: JobRuntimeState = {
    config,
    items,
    pending: new Map(),
    ...(opts.repository !== undefined ? { repository: opts.repository } : {}),
    ...(opts.threadOps !== undefined ? { threadOps: opts.threadOps } : {}),
    progress: new JobProgressEmitterImpl(opts.progressEmitter),
    stopRequested: false,
  };
  jobs.set(jobId, state);

  try {
    // reference `run_agent_job_loop` calls `recover_running_items`
    // (agent_jobs.rs:588) before dispatching new items. For freshly-
    // created jobs this is a no-op; the helper is defensive against
    // re-entry where an item was left in `running` status.
    await recoverRunningItems(state);
    // Initial progress (force=true) — reference agent_jobs.rs:597-605.
    state.progress.maybeEmit(jobId, computeProgressSnapshot(state), true);
    await processItems(state, opts.spawn);
    if (opts.outputCsvPath !== undefined) {
      await writeOutputCsv(opts.outputCsvPath, csv.headers, items);
    }
    if (opts.repository !== undefined) {
      if (state.stopRequested) {
        // recordAgentJobResult may have already flipped the job to
        // `cancelled` (with reason "cancelled by worker request" per
        // reference agent_jobs.rs:500-505). Avoid clobbering that exact
        // reason with a different one — only mark cancelled here if
        // the job hasn't already transitioned.
        const current = opts.repository.getJob(jobId);
        if (current?.status !== "cancelled") {
          opts.repository.markJobCancelled(jobId, "cancelled by worker request");
        }
      } else {
        opts.repository.markJobCompleted(jobId);
      }
    }
    // Final progress (force=true) — reference agent_jobs.rs:790-803.
    state.progress.maybeEmit(jobId, computeProgressSnapshot(state), true);
    return {
      jobId,
      items: Array.from(items.values()),
      stoppedEarly: state.stopRequested,
      ...(opts.outputCsvPath !== undefined ? { outputCsvPath: opts.outputCsvPath } : {}),
    };
  } catch (err) {
    if (opts.repository !== undefined) {
      opts.repository.markJobFailed(
        jobId,
        err instanceof Error ? err.message : String(err),
      );
    }
    throw err;
  } finally {
    jobs.delete(jobId);
  }
}

function clampConcurrency(
  requested: number | undefined,
): number {
  const raw = requested ?? DEFAULT_MAX_CONCURRENCY;
  if (!Number.isFinite(raw)) return DEFAULT_MAX_CONCURRENCY;
  return Math.max(1, Math.min(64, Math.floor(raw)));
}

/**
 * reference `recover_running_items` (agent_jobs.rs:825-903): defensive
 * within-run reconciliation. Called at the start of every job run to
 * resolve items left in `running` status (e.g. from a re-entered job
 * or from a half-finished prior dispatch).
 *
 * Branches mirror the reference policy:
 *   - Stale (age >= maxRuntimeSeconds): markItemFailed + shutdown thread
 *     (agent_jobs.rs:840-852)
 *   - Missing assigned_thread_id: markItemFailed (agent_jobs.rs:855-862)
 *   - Thread in final state: finalize from DB (agent_jobs.rs:877-885)
 *   - Otherwise: leave alone — caller's loop will observe the worker
 *     via subscribeStatus (reference agent_jobs.rs:887-902); AgenC's
 *     orchestrator does not currently re-attach Promise resolvers in
 *     this branch since the original `report_agent_job_result` waiter
 *     is gone, so we mark the item failed defensively.
 */
async function recoverRunningItems(state: JobRuntimeState): Promise<void> {
  const repository = state.repository;
  if (repository === undefined) return;
  const running = repository.listItems({
    jobId: state.config.jobId,
    status: "running",
  });
  if (running.length === 0) return;
  const nowSec = Math.floor(Date.now() / 1000);
  const runtimeTimeoutSec = state.config.maxRuntimeSeconds;
  for (const dbItem of running) {
    const inMemoryItem = state.items.get(dbItem.itemId);
    const ageSec = nowSec - dbItem.updatedAt;
    if (ageSec >= runtimeTimeoutSec) {
      const message = `worker exceeded max runtime of ${runtimeTimeoutSec}s`;
      repository.markItemFailed(state.config.jobId, dbItem.itemId, message);
      if (inMemoryItem !== undefined) {
        inMemoryItem.status = "failed";
        inMemoryItem.error = message;
        inMemoryItem.completedAt = new Date();
      }
      if (
        dbItem.assignedThreadId !== undefined &&
        state.threadOps !== undefined
      ) {
        await state.threadOps
          .shutdownThread(dbItem.assignedThreadId)
          .catch(() => {});
      }
      continue;
    }
    if (dbItem.assignedThreadId === undefined) {
      const message = "running item is missing assigned_thread_id";
      repository.markItemFailed(state.config.jobId, dbItem.itemId, message);
      if (inMemoryItem !== undefined) {
        inMemoryItem.status = "failed";
        inMemoryItem.error = message;
        inMemoryItem.completedAt = new Date();
      }
      continue;
    }
    if (state.threadOps !== undefined) {
      const status = await state.threadOps.getStatus(dbItem.assignedThreadId);
      if (
        status.kind === "completed" ||
        status.kind === "errored" ||
        status.kind === "shutdown" ||
        status.kind === "not_found"
      ) {
        // reference finalize_finished_item path (agent_jobs.rs:877-885).
        if (status.kind === "completed" && dbItem.result !== undefined) {
          repository.markItemCompleted(
            state.config.jobId,
            dbItem.itemId,
            dbItem.result,
          );
          if (inMemoryItem !== undefined) {
            inMemoryItem.status = "completed";
            inMemoryItem.result = dbItem.result;
            inMemoryItem.completedAt = new Date();
            inMemoryItem.reportedAt = new Date();
          }
        } else {
          const message =
            status.kind === "errored"
              ? status.reason
              : status.kind === "shutdown" ||
                  status.kind === "not_found" ||
                  status.kind === "completed"
                ? "worker finished without calling report_agent_job_result"
                : "worker terminated";
          repository.markItemFailed(
            state.config.jobId,
            dbItem.itemId,
            message,
          );
          if (inMemoryItem !== undefined) {
            inMemoryItem.status = "failed";
            inMemoryItem.error = message;
            inMemoryItem.completedAt = new Date();
          }
        }
      }
      // Otherwise (thread still alive, not stale): reference re-attaches
      // to the active set via subscribe_status. AgenC has no way to
      // recreate the original `report_agent_job_result` Promise here,
      // so this branch is unreachable from a fresh runAgentsOnCsv
      // call (no items in `running` status at start). Leaving the
      // item alone — `processItems` will skip it via the status guard.
    }
  }
}

async function processItems(
  state: JobRuntimeState,
  spawn: AgentJobSpawn,
): Promise<void> {
  const max = state.config.maxConcurrency;
  // Preserve original row order while still allowing capacity-rejected
  // items to be re-queued at the front. `unshift` inside the catch path
  // matches reference `mark_agent_job_item_pending` + `break` behavior at
  // agent_jobs.rs:658-665. Items that aren't pending in memory (e.g.
  // moved to `failed` by recoverRunningItems) are filtered out.
  const queue: ItemId[] = Array.from(state.items.entries())
    .filter(([, item]) => item.status === "pending")
    .map(([id]) => id);
  const inflight: Set<Promise<{ retryItemId?: ItemId }>> = new Set();

  const runOne = async (
    itemId: ItemId,
  ): Promise<{ retryItemId?: ItemId }> => {
    if (state.stopRequested) {
      const item = state.items.get(itemId)!;
      item.status = "cancelled";
      item.completedAt = new Date();
      state.repository?.markItemCancelled(
        state.config.jobId,
        itemId,
        "job cancelled before dispatch",
      );
      return {};
    }
    const item = state.items.get(itemId)!;
    const ctx: AgentJobSpawnContext = {
      jobId: state.config.jobId,
      itemId,
      row: item.row,
      workerPrompt: buildWorkerPrompt(state.config, item),
    };
    const completion = new Promise<void>((resolve, reject) => {
      state.pending.set(itemId, { resolve, reject });
    });
    const runtimeBudgetMs = state.config.maxRuntimeSeconds * 1000;
    // gaphunt3 #6: capture the watchdog handle so it can be cleared once the
    // item completes; otherwise the timer stays armed for the full
    // max_runtime_seconds budget (default 30min) after every completed row,
    // leaking one live timer per row and pinning the event loop.
    let runtimeTimer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((_, reject) => {
      runtimeTimer = setTimeout(
        () => reject(new Error(`item ${itemId} exceeded max_runtime_seconds`)),
        runtimeBudgetMs,
      );
      runtimeTimer.unref?.();
    });
    item.attemptCount += 1;
    // Mirror reference ordering: status flips to running before the worker
    // can report. Thread_id is attached after spawn returns. On capacity
    // rejection we roll back to pending below.
    state.repository?.markItemRunning(state.config.jobId, itemId);
    try {
      const outcome = await spawn.spawn(ctx);
      if (outcome?.threadId !== undefined) {
        item.assignedThreadId = outcome.threadId;
        state.repository?.setItemThread(
          state.config.jobId,
          itemId,
          outcome.threadId,
        );
      }
      const racers: Array<Promise<void>> = [completion, timeout];
      if (outcome?.threadFinished !== undefined) {
        racers.push(outcome.threadFinished);
      }
      await Promise.race(racers);
      // reference finalize_finished_item guard (agent_jobs.rs:992-1004):
      // if the item is still pending after the worker thread terminated
      // (or after the wait resolved without `recordAgentJobResult`),
      // mark failed with the reference message.
      if (item.status === "pending") {
        if (state.stopRequested) {
          // The job was cancelled while this item was in flight and its
          // worker was terminated by cancelOutstanding — that's a
          // cancellation, not a worker failure.
          const message = "job cancelled while item was in flight";
          item.status = "cancelled";
          item.error = message;
          item.completedAt = new Date();
          state.repository?.markItemCancelled(
            state.config.jobId,
            itemId,
            message,
          );
        } else {
          const message =
            "worker finished without calling report_agent_job_result";
          item.status = "failed";
          item.error = message;
          item.completedAt = new Date();
          state.repository?.markItemFailed(
            state.config.jobId,
            itemId,
            message,
          );
        }
      }
      return {};
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      item.status = "failed";
      item.error = reason;
      item.completedAt = new Date();
      state.repository?.markItemFailed(state.config.jobId, itemId, reason);
      return {};
    } finally {
      // gaphunt3 #6: clear the per-item watchdog so it does not survive the
      // race it lost (completion / threadFinished won).
      if (runtimeTimer !== undefined) clearTimeout(runtimeTimer);
      state.pending.delete(itemId);
    }
  };

  let cancelIssued = false;
  while (queue.length > 0 || inflight.size > 0) {
    // reference `run_agent_job_loop` polls `is_agent_job_cancelled` at the
    // top of each loop iteration (agent_jobs.rs:611) so external
    // cancellation flips the job's flag in the DB and the next
    // dispatch round notices. AgenC mirrors via the repository.
    if (!state.stopRequested && state.repository !== undefined) {
      const dbJob = state.repository.getJob(state.config.jobId);
      if (dbJob?.status === "cancelled") {
        state.stopRequested = true;
      }
    }
    // Cancel must fire while items are still in flight — waiting for the
    // in-flight set to drain first (the old tail-call placement) blocks
    // on the very work cancellation is supposed to stop. Terminate the
    // worker threads, then release the report waiters so the finalize
    // guard can mark still-pending items cancelled.
    if (state.stopRequested && !cancelIssued) {
      cancelIssued = true;
      try {
        await spawn.cancelOutstanding(state.config.jobId);
      } catch {
        /* cancellation is best-effort; the runtime timeout still bounds workers */
      }
      for (const waiter of state.pending.values()) {
        waiter.resolve();
      }
    }
    while (!state.stopRequested && inflight.size < max && queue.length > 0) {
      const id = queue.shift()!;
      const promise = runOne(id);
      inflight.add(promise);
      promise.finally(() => inflight.delete(promise));
    }
    if (inflight.size === 0) break;
    const completed = await Promise.race(inflight);
    if (completed.retryItemId !== undefined) {
      queue.unshift(completed.retryItemId);
    }
    // Per-iteration progress emit. The emitter throttles to one
    // notification per second except on actual state change
    // (agent_jobs.rs:142-149).
    state.progress.maybeEmit(
      state.config.jobId,
      computeProgressSnapshot(state),
      false,
    );
  }

  if (state.stopRequested) {
    if (!cancelIssued) {
      try {
        await spawn.cancelOutstanding(state.config.jobId);
      } catch {
        /* best-effort */
      }
    }
    // Rows that were still queued when the job was cancelled were never
    // dispatched (the dispatch loop skips on stopRequested) — mark them
    // cancelled instead of leaving them pending forever.
    for (const [itemId, item] of state.items) {
      if (item.status === "pending" && !state.pending.has(itemId)) {
        item.status = "cancelled";
        item.completedAt = new Date();
        state.repository?.markItemCancelled(
          state.config.jobId,
          itemId,
          "job cancelled before dispatch",
        );
      }
    }
  }
}

function buildWorkerPrompt(
  config: JobConfig,
  item: JobItemRecord,
): string {
  const schemaText = config.outputSchema
    ? JSON.stringify(config.outputSchema, null, 2)
    : "{}";
  const rowJson = JSON.stringify(item.row, null, 2);
  return [
    "You are processing one item for a generic agent job.",
    `Job ID: ${item.jobId}`,
    `Item ID: ${item.itemId}`,
    "",
    "Task instruction:",
    item.instruction,
    "",
    "Input row (JSON):",
    rowJson,
    "",
    "Expected result schema (JSON Schema or {}):",
    schemaText,
    "",
    "You MUST call the `report_agent_job_result` tool exactly once with:",
    `1. \`job_id\` = "${item.jobId}"`,
    `2. \`item_id\` = "${item.itemId}"`,
    "3. `result` = a JSON object that contains your analysis result for this row.",
    "",
    "If you need to stop the job early, include `stop` = true in the tool call.",
    "",
    "After the tool call succeeds, stop.",
  ].join("\n");
}

/**
 * Render the output CSV with the reference column shape
 * (reference `agent_jobs.rs:1143-1217`):
 *   {input_headers...} + job_id, item_id, row_index, source_id, status,
 *   attempt_count, last_error, result_json, reported_at, completed_at.
 * All items are written regardless of status.
 */
async function writeOutputCsv(
  path: string,
  inputHeaders: ReadonlyArray<string>,
  items: ReadonlyMap<ItemId, JobItemRecord>,
): Promise<void> {
  const headers: string[] = [
    ...inputHeaders,
    "job_id",
    "item_id",
    "row_index",
    "source_id",
    "status",
    "attempt_count",
    "last_error",
    "result_json",
    "reported_at",
    "completed_at",
  ];
  const rows: CsvRow[] = Array.from(items.values())
    .sort((a, b) => a.rowIndex - b.rowIndex)
    .map((item) => {
      const row: { [column: string]: string } = {};
      for (const header of inputHeaders) {
        const value = item.row[header];
        row[header] = value === undefined ? "" : value;
      }
      row.job_id = item.jobId;
      row.item_id = item.itemId;
      row.row_index = String(item.rowIndex);
      row.source_id = item.sourceId ?? "";
      row.status = item.status;
      row.attempt_count = String(item.attemptCount);
      row.last_error = item.error ?? "";
      row.result_json =
        item.result !== undefined ? JSON.stringify(item.result) : "";
      row.reported_at = item.reportedAt?.toISOString() ?? "";
      row.completed_at = item.completedAt?.toISOString() ?? "";
      return row;
    });
  await writeFile(path, writeCsv({ headers, rows }), "utf8");
}

export interface ResumeAgentJobsOpts {
  readonly repository: CsvAgentJobsRepository;
  readonly spawn: AgentJobSpawn;
  readonly threadOps?: AgentJobThreadOps;
  readonly progressEmitter?: AgentJobProgressEmitter;
  readonly maxConcurrency?: number;
}

/**
 * Resume jobs left `running` in the DB by a daemon that died mid-flight.
 *
 * The in-process resolvers are gone after a restart, so every orphaned
 * `running` item is reset to `pending` (unless it already carries a
 * reported result, in which case it is finalized as completed) and
 * re-dispatched through the normal loop respecting `maxConcurrency`.
 * Row execution is idempotent by construction: the output CSV is
 * rendered from the full item map at completion, so a re-run row
 * overwrites its output instead of appending a duplicate.
 */
export async function resumeAgentJobsFromRepository(
  opts: ResumeAgentJobsOpts,
): Promise<RunAgentsOnCsvResult[]> {
  const results: RunAgentsOnCsvResult[] = [];
  for (const job of opts.repository.listJobs({ status: "running" })) {
    if (jobs.has(job.id)) continue; // already live in this process
    results.push(await resumeSingleJob(job.id, opts));
  }
  return results;
}

async function resumeSingleJob(
  jobId: JobId,
  opts: ResumeAgentJobsOpts,
): Promise<RunAgentsOnCsvResult> {
  const repository = opts.repository;
  const job = repository.getJob(jobId);
  if (job === null) {
    throw new Error(`cannot resume unknown agent job ${jobId}`);
  }
  const config: JobConfig = {
    jobId,
    instruction: job.instruction,
    ...(job.outputSchema !== undefined ? { outputSchema: job.outputSchema } : {}),
    maxConcurrency: clampConcurrency(opts.maxConcurrency),
    maxRuntimeSeconds: job.maxRuntimeSeconds ?? DEFAULT_MAX_RUNTIME_SECONDS,
  };
  const items = new Map<ItemId, JobItemRecord>();
  for (const dbItem of repository.listItems({ jobId })) {
    const mutableRow: { [column: string]: string } = {};
    for (const [key, value] of Object.entries(dbItem.row)) {
      mutableRow[key] = typeof value === "string" ? value : String(value ?? "");
    }
    const row: CsvRow = mutableRow;
    let status: JobItemStatus;
    switch (dbItem.status) {
      case "completed":
        status = "completed";
        break;
      case "failed":
        status = "failed";
        break;
      case "cancelled":
        status = "cancelled";
        break;
      case "running":
        // Orphaned by the dead daemon: its resolver no longer exists.
        // A result on the row means the worker reported before the
        // crash — finalize; otherwise the row goes back to pending
        // for re-dispatch.
        if (dbItem.result !== undefined) {
          repository.markItemCompleted(jobId, dbItem.itemId, dbItem.result);
          status = "completed";
        } else {
          repository.markItemPending(jobId, dbItem.itemId);
          status = "pending";
        }
        break;
      default:
        status = "pending";
    }
    items.set(dbItem.itemId, {
      jobId,
      itemId: dbItem.itemId,
      rowIndex: dbItem.rowIndex,
      ...(dbItem.sourceId !== undefined ? { sourceId: dbItem.sourceId } : {}),
      row,
      instruction: renderInstructionTemplate(job.instruction, row),
      status,
      attemptCount: dbItem.attemptCount,
      ...(dbItem.result !== undefined ? { result: dbItem.result } : {}),
      ...(dbItem.lastError !== undefined ? { error: dbItem.lastError } : {}),
    });
  }
  const state: JobRuntimeState = {
    config,
    items,
    pending: new Map(),
    repository,
    ...(opts.threadOps !== undefined ? { threadOps: opts.threadOps } : {}),
    progress: new JobProgressEmitterImpl(opts.progressEmitter),
    stopRequested: false,
  };
  jobs.set(jobId, state);
  try {
    state.progress.maybeEmit(jobId, computeProgressSnapshot(state), true);
    await processItems(state, opts.spawn);
    if (job.autoExport && job.outputCsvPath.length > 0) {
      await writeOutputCsv(job.outputCsvPath, job.inputHeaders, items);
    }
    if (state.stopRequested) {
      const current = repository.getJob(jobId);
      if (current?.status !== "cancelled") {
        repository.markJobCancelled(jobId, "cancelled by worker request");
      }
    } else {
      repository.markJobCompleted(jobId);
    }
    state.progress.maybeEmit(jobId, computeProgressSnapshot(state), true);
    return {
      jobId,
      items: Array.from(items.values()),
      stoppedEarly: state.stopRequested,
      ...(job.autoExport && job.outputCsvPath.length > 0
        ? { outputCsvPath: job.outputCsvPath }
        : {}),
    };
  } catch (err) {
    repository.markJobFailed(
      jobId,
      err instanceof Error ? err.message : String(err),
    );
    throw err;
  } finally {
    jobs.delete(jobId);
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
  if (!state) return { kind: "unknown_job" };
  const item = state.items.get(args.itemId);
  if (!item) return { kind: "unknown_item" };
  if (item.status !== "pending") return { kind: "already_reported" };
  const violation = validateAgainstSchema(args.result, state.config.outputSchema);
  if (violation !== null) {
    return { kind: "schema_violation", reason: violation };
  }
  const now = new Date();
  item.result = args.result;
  item.status = "completed";
  item.reportedAt = now;
  item.completedAt = now;
  state.repository?.markItemCompleted(args.jobId, args.itemId, args.result);
  if (args.stop === true) {
    state.stopRequested = true;
    // reference agent_jobs.rs:500-505: when a worker reports stop=true, the
    // job's status is flipped to cancelled in the DB so subsequent
    // `is_agent_job_cancelled` checks (and other observers) see the
    // cancellation. The reason text mirrors reference byte-for-byte.
    state.repository?.markJobCancelled(args.jobId, "cancelled by worker request");
  }
  state.pending.get(args.itemId)?.resolve();
  state.pending.delete(args.itemId);
  return { kind: "ok" };
}

function validateAgainstSchema(
  value: unknown,
  schema: Record<string, unknown> | undefined,
): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "result must be a JSON object";
  }
  if (!schema) return null;
  const required = schema.required;
  if (Array.isArray(required)) {
    for (const key of required) {
      if (typeof key === "string" && !(key in (value as object))) {
        return `result is missing required key \`${key}\``;
      }
    }
  }
  return null;
}
