/**
 * Agent-jobs orchestrator (codex-v2 parity).
 *
 * Hand-port of codex `core/src/tools/handlers/agent_jobs.rs`. When a
 * `CsvAgentJobsRepository` is supplied, all job + item lifecycle
 * transitions are mirrored to the codex-shaped SQLite tables in
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
  readonly row: CsvRow;
  readonly instruction: string;
  status: JobItemStatus;
  result?: Record<string, unknown>;
  error?: string;
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

export interface AgentJobSpawn {
  spawn(ctx: AgentJobSpawnContext): Promise<void>;
  cancelOutstanding(jobId: JobId): Promise<void>;
}

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
  stopRequested: boolean;
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
    items.set(itemId, {
      jobId,
      itemId,
      row,
      instruction: rendered,
      status: "pending",
    });
    itemSeed.push({
      itemId,
      rowIndex: index,
      ...(opts.idColumn !== undefined ? { sourceId: row[opts.idColumn] } : {}),
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
    stopRequested: false,
  };
  jobs.set(jobId, state);

  try {
    await processItems(state, opts.spawn);
    if (opts.outputCsvPath !== undefined) {
      await writeOutputCsv(opts.outputCsvPath, csv.headers, items);
    }
    if (opts.repository !== undefined) {
      if (state.stopRequested) {
        opts.repository.markJobCancelled(jobId, "worker requested stop");
      } else {
        opts.repository.markJobCompleted(jobId);
      }
    }
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

function clampConcurrency(value: number | undefined): number {
  const raw = value ?? DEFAULT_MAX_CONCURRENCY;
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_MAX_CONCURRENCY;
  return Math.max(1, Math.min(64, Math.floor(raw)));
}

async function processItems(
  state: JobRuntimeState,
  spawn: AgentJobSpawn,
): Promise<void> {
  const itemIds = Array.from(state.items.keys());
  const max = state.config.maxConcurrency;
  let cursor = 0;
  const inflight: Set<Promise<void>> = new Set();

  const runOne = async (itemId: ItemId): Promise<void> => {
    if (state.stopRequested) {
      const item = state.items.get(itemId)!;
      item.status = "cancelled";
      return;
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
    const timeout = new Promise<void>((_, reject) =>
      setTimeout(
        () => reject(new Error(`item ${itemId} exceeded max_runtime_seconds`)),
        runtimeBudgetMs,
      ),
    );
    state.repository?.markItemRunning(state.config.jobId, itemId);
    try {
      await spawn.spawn(ctx);
      await Promise.race([completion, timeout]);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      item.status = "failed";
      item.error = reason;
      state.repository?.markItemFailed(state.config.jobId, itemId, reason);
    } finally {
      state.pending.delete(itemId);
    }
  };

  while (cursor < itemIds.length || inflight.size > 0) {
    while (inflight.size < max && cursor < itemIds.length) {
      const id = itemIds[cursor]!;
      cursor += 1;
      const promise = runOne(id);
      inflight.add(promise);
      promise.finally(() => inflight.delete(promise));
    }
    if (inflight.size > 0) {
      await Promise.race(inflight);
    }
  }

  if (state.stopRequested) {
    await spawn.cancelOutstanding(state.config.jobId);
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

async function writeOutputCsv(
  path: string,
  inputHeaders: ReadonlyArray<string>,
  items: ReadonlyMap<ItemId, JobItemRecord>,
): Promise<void> {
  const resultKeys = new Set<string>();
  for (const item of items.values()) {
    if (item.result) {
      for (const key of Object.keys(item.result)) resultKeys.add(key);
    }
  }
  const headers: string[] = [
    ...inputHeaders,
    "_status",
    "_error",
    ...Array.from(resultKeys),
  ];
  const rows: CsvRow[] = Array.from(items.values()).map((item) => {
    const row: { [column: string]: string } = { ...item.row };
    row._status = item.status;
    row._error = item.error ?? "";
    for (const key of resultKeys) {
      const value = item.result?.[key];
      row[key] =
        value === undefined
          ? ""
          : typeof value === "string"
            ? value
            : JSON.stringify(value);
    }
    return row;
  });
  await writeFile(path, writeCsv({ headers, rows }), "utf8");
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
  item.result = args.result;
  item.status = "completed";
  state.repository?.markItemCompleted(args.jobId, args.itemId, args.result);
  if (args.stop === true) {
    state.stopRequested = true;
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
