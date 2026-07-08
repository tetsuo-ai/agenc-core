/**
 * CSV agent-jobs persistence.
 *
 * AgenC stores imported batch jobs in `csv_agent_jobs` /
 * `csv_agent_job_items` so they do not collide with the existing
 * `agent_jobs` queue table. The schema is created by migration v2 in the
 * versioned state migration registry.
 *
 * Dates are stored as Unix epoch seconds.
 *
 * @module
 */

import type { StateSqliteDriver } from "./sqlite-driver.js";

// ─────────────────────────────────────────────────────────────────────
// Status enums
// ─────────────────────────────────────────────────────────────────────

export type CsvAgentJobStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type CsvAgentJobItemStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

const JOB_STATUSES: ReadonlySet<CsvAgentJobStatus> = new Set([
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
]);

const ITEM_STATUSES: ReadonlySet<CsvAgentJobItemStatus> = new Set([
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
]);

function parseJobStatus(raw: string): CsvAgentJobStatus {
  if (!JOB_STATUSES.has(raw as CsvAgentJobStatus)) {
    throw new Error(`invalid agent job status: ${raw}`);
  }
  return raw as CsvAgentJobStatus;
}

function parseItemStatus(raw: string): CsvAgentJobItemStatus {
  if (!ITEM_STATUSES.has(raw as CsvAgentJobItemStatus)) {
    throw new Error(`invalid agent job item status: ${raw}`);
  }
  return raw as CsvAgentJobItemStatus;
}

// ─────────────────────────────────────────────────────────────────────
// Records and create-params
// ─────────────────────────────────────────────────────────────────────

export interface CsvAgentJob {
  readonly id: string;
  readonly name: string;
  readonly status: CsvAgentJobStatus;
  readonly instruction: string;
  readonly autoExport: boolean;
  readonly maxRuntimeSeconds?: number;
  readonly outputSchema?: Record<string, unknown>;
  readonly inputHeaders: ReadonlyArray<string>;
  readonly inputCsvPath: string;
  readonly outputCsvPath: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly startedAt?: number;
  readonly completedAt?: number;
  readonly lastError?: string;
}

export interface CsvAgentJobItem {
  readonly jobId: string;
  readonly itemId: string;
  readonly rowIndex: number;
  readonly sourceId?: string;
  readonly row: Record<string, unknown>;
  readonly status: CsvAgentJobItemStatus;
  readonly assignedThreadId?: string;
  readonly attemptCount: number;
  readonly result?: Record<string, unknown>;
  readonly lastError?: string;
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
}

export interface CsvAgentJobCreateParams {
  readonly id: string;
  readonly name: string;
  readonly instruction: string;
  readonly autoExport: boolean;
  readonly maxRuntimeSeconds?: number;
  readonly outputSchema?: Record<string, unknown>;
  readonly inputHeaders: ReadonlyArray<string>;
  readonly inputCsvPath: string;
  readonly outputCsvPath: string;
}

export interface CsvAgentJobItemCreateParams {
  readonly itemId: string;
  readonly rowIndex: number;
  readonly sourceId?: string;
  readonly row: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────
// Row decoders
// ─────────────────────────────────────────────────────────────────────

interface JobRow {
  id: string;
  name: string;
  status: string;
  instruction: string;
  auto_export: number;
  max_runtime_seconds: number | null;
  output_schema_json: string | null;
  input_headers_json: string;
  input_csv_path: string;
  output_csv_path: string;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  completed_at: number | null;
  last_error: string | null;
}

interface ItemRow {
  job_id: string;
  item_id: string;
  row_index: number;
  source_id: string | null;
  row_json: string;
  status: string;
  assigned_thread_id: string | null;
  attempt_count: number;
  result_json: string | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  reported_at: number | null;
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
    ...(row.output_schema_json !== null
      ? { outputSchema: JSON.parse(row.output_schema_json) as Record<string, unknown> }
      : {}),
    inputHeaders: JSON.parse(row.input_headers_json) as string[],
    inputCsvPath: row.input_csv_path,
    outputCsvPath: row.output_csv_path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.started_at !== null ? { startedAt: row.started_at } : {}),
    ...(row.completed_at !== null ? { completedAt: row.completed_at } : {}),
    ...(row.last_error !== null ? { lastError: row.last_error } : {}),
  };
}

function decodeItem(row: ItemRow): CsvAgentJobItem {
  return {
    jobId: row.job_id,
    itemId: row.item_id,
    rowIndex: row.row_index,
    ...(row.source_id !== null ? { sourceId: row.source_id } : {}),
    row: JSON.parse(row.row_json) as Record<string, unknown>,
    status: parseItemStatus(row.status),
    ...(row.assigned_thread_id !== null
      ? { assignedThreadId: row.assigned_thread_id }
      : {}),
    attemptCount: row.attempt_count,
    ...(row.result_json !== null
      ? { result: JSON.parse(row.result_json) as Record<string, unknown> }
      : {}),
    ...(row.last_error !== null ? { lastError: row.last_error } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.completed_at !== null ? { completedAt: row.completed_at } : {}),
    ...(row.reported_at !== null ? { reportedAt: row.reported_at } : {}),
  };
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

// ─────────────────────────────────────────────────────────────────────
// Repository
// ─────────────────────────────────────────────────────────────────────

export class CsvAgentJobsRepository {
  constructor(private readonly driver: StateSqliteDriver) {}

  createJob(
    params: CsvAgentJobCreateParams,
    items: ReadonlyArray<CsvAgentJobItemCreateParams>,
  ): CsvAgentJob {
    const now = nowSeconds();
    const inputHeadersJson = JSON.stringify(params.inputHeaders);
    const outputSchemaJson =
      params.outputSchema !== undefined
        ? JSON.stringify(params.outputSchema)
        : null;
    const maxRuntimeSeconds = params.maxRuntimeSeconds ?? null;

    this.driver.transaction(() => {
      this.driver
        .prepareState(
          `INSERT INTO csv_agent_jobs (
            id, name, status, instruction, auto_export, max_runtime_seconds,
            output_schema_json, input_headers_json, input_csv_path,
            output_csv_path, created_at, updated_at, started_at,
            completed_at, last_error
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
        )
        .run(
          params.id,
          params.name,
          "pending",
          params.instruction,
          params.autoExport ? 1 : 0,
          maxRuntimeSeconds,
          outputSchemaJson,
          inputHeadersJson,
          params.inputCsvPath,
          params.outputCsvPath,
          now,
          now,
        );
      const insertItem = this.driver.prepareState(
        `INSERT INTO csv_agent_job_items (
          job_id, item_id, row_index, source_id, row_json, status,
          assigned_thread_id, attempt_count, result_json, last_error,
          created_at, updated_at, completed_at, reported_at
        ) VALUES (?, ?, ?, ?, ?, ?, NULL, 0, NULL, NULL, ?, ?, NULL, NULL)`,
      );
      for (const item of items) {
        insertItem.run(
          params.id,
          item.itemId,
          item.rowIndex,
          item.sourceId ?? null,
          JSON.stringify(item.row),
          "pending",
          now,
          now,
        );
      }
    });

    const created = this.getJob(params.id);
    if (!created) {
      throw new Error(`failed to load created agent job ${params.id}`);
    }
    return created;
  }

  getJob(jobId: string): CsvAgentJob | null {
    const row = this.driver
      .prepareState<[string], JobRow>(
        `SELECT * FROM csv_agent_jobs WHERE id = ?`,
      )
      .get(jobId);
    return row ? decodeJob(row) : null;
  }

  listJobs(opts: {
    readonly status?: CsvAgentJobStatus;
    readonly limit?: number;
  } = {}): ReadonlyArray<CsvAgentJob> {
    const where: string[] = [];
    const binds: unknown[] = [];
    if (opts.status !== undefined) {
      where.push("status = ?");
      binds.push(opts.status);
    }
    let sql = `SELECT * FROM csv_agent_jobs`;
    if (where.length > 0) sql += ` WHERE ${where.join(" AND ")}`;
    sql += ` ORDER BY updated_at DESC`;
    if (opts.limit !== undefined) {
      sql += ` LIMIT ?`;
      binds.push(opts.limit);
    }
    const rows = this.driver
      .prepareState<unknown[], JobRow>(sql)
      .all(...binds);
    return rows.map(decodeJob);
  }

  deleteJob(jobId: string): void {
    // CASCADE on csv_agent_job_items.job_id → csv_agent_jobs.id removes
    // the children automatically.
    this.driver
      .prepareState(`DELETE FROM csv_agent_jobs WHERE id = ?`)
      .run(jobId);
  }

  markJobRunning(jobId: string): void {
    const now = nowSeconds();
    this.driver
      .prepareState(
        `UPDATE csv_agent_jobs
         SET status = 'running',
             started_at = COALESCE(started_at, ?),
             updated_at = ?
         WHERE id = ?`,
      )
      .run(now, now, jobId);
  }

  markJobCompleted(jobId: string): void {
    const now = nowSeconds();
    this.driver
      .prepareState(
        `UPDATE csv_agent_jobs
         SET status = 'completed', completed_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(now, now, jobId);
  }

  markJobFailed(jobId: string, error: string): void {
    const now = nowSeconds();
    this.driver
      .prepareState(
        `UPDATE csv_agent_jobs
         SET status = 'failed', completed_at = ?, updated_at = ?, last_error = ?
         WHERE id = ?`,
      )
      .run(now, now, error, jobId);
  }

  markJobCancelled(jobId: string, reason: string): void {
    const now = nowSeconds();
    this.driver
      .prepareState(
        `UPDATE csv_agent_jobs
         SET status = 'cancelled', completed_at = ?, updated_at = ?, last_error = ?
         WHERE id = ?`,
      )
      .run(now, now, reason, jobId);
  }

  // ──────────────── items ────────────────

  getItem(jobId: string, itemId: string): CsvAgentJobItem | null {
    const row = this.driver
      .prepareState<[string, string], ItemRow>(
        `SELECT * FROM csv_agent_job_items WHERE job_id = ? AND item_id = ?`,
      )
      .get(jobId, itemId);
    return row ? decodeItem(row) : null;
  }

  listItems(opts: {
    readonly jobId: string;
    readonly status?: CsvAgentJobItemStatus;
    readonly limit?: number;
  }): ReadonlyArray<CsvAgentJobItem> {
    const where: string[] = ["job_id = ?"];
    const binds: unknown[] = [opts.jobId];
    if (opts.status !== undefined) {
      where.push("status = ?");
      binds.push(opts.status);
    }
    let sql = `SELECT * FROM csv_agent_job_items WHERE ${where.join(" AND ")} ORDER BY row_index ASC`;
    if (opts.limit !== undefined) {
      sql += ` LIMIT ?`;
      binds.push(opts.limit);
    }
    const rows = this.driver
      .prepareState<unknown[], ItemRow>(sql)
      .all(...binds);
    return rows.map(decodeItem);
  }

  markItemRunning(jobId: string, itemId: string): void {
    const now = nowSeconds();
    this.driver
      .prepareState(
        `UPDATE csv_agent_job_items
         SET status = 'running', attempt_count = attempt_count + 1, updated_at = ?
         WHERE job_id = ? AND item_id = ?`,
      )
      .run(now, jobId, itemId);
  }

  markItemRunningWithThread(
    jobId: string,
    itemId: string,
    threadId: string,
  ): void {
    const now = nowSeconds();
    this.driver
      .prepareState(
        `UPDATE csv_agent_job_items
         SET status = 'running',
             assigned_thread_id = ?,
             attempt_count = attempt_count + 1,
             updated_at = ?
         WHERE job_id = ? AND item_id = ?`,
      )
      .run(threadId, now, jobId, itemId);
  }

  markItemPending(jobId: string, itemId: string): void {
    const now = nowSeconds();
    this.driver
      .prepareState(
        `UPDATE csv_agent_job_items
         SET status = 'pending', updated_at = ?
         WHERE job_id = ? AND item_id = ?`,
      )
      .run(now, jobId, itemId);
  }

  setItemThread(jobId: string, itemId: string, threadId: string): void {
    const now = nowSeconds();
    this.driver
      .prepareState(
        `UPDATE csv_agent_job_items
         SET assigned_thread_id = ?, updated_at = ?
         WHERE job_id = ? AND item_id = ?`,
      )
      .run(threadId, now, jobId, itemId);
  }

  markItemCompleted(
    jobId: string,
    itemId: string,
    result: Record<string, unknown>,
  ): void {
    const now = nowSeconds();
    this.driver
      .prepareState(
        `UPDATE csv_agent_job_items
         SET status = 'completed',
             result_json = ?,
             completed_at = ?,
             reported_at = ?,
             updated_at = ?
         WHERE job_id = ? AND item_id = ?`,
      )
      .run(JSON.stringify(result), now, now, now, jobId, itemId);
  }

  markItemFailed(jobId: string, itemId: string, error: string): void {
    const now = nowSeconds();
    this.driver
      .prepareState(
        `UPDATE csv_agent_job_items
         SET status = 'failed',
             last_error = ?,
             completed_at = ?,
             reported_at = ?,
             updated_at = ?
         WHERE job_id = ? AND item_id = ?`,
      )
      .run(error, now, now, now, jobId, itemId);
  }

  markItemCancelled(jobId: string, itemId: string, reason: string): void {
    const now = nowSeconds();
    this.driver
      .prepareState(
        `UPDATE csv_agent_job_items
         SET status = 'cancelled',
             last_error = ?,
             completed_at = ?,
             updated_at = ?
         WHERE job_id = ? AND item_id = ?`,
      )
      .run(reason, now, now, jobId, itemId);
  }

  getJobProgress(jobId: string): CsvAgentJobProgress {
    const row = this.driver
      .prepareState<
        [string],
        {
          total: number;
          pending: number;
          running: number;
          completed: number;
          failed: number;
        }
      >(
        `SELECT
            COUNT(*) AS total,
            SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
            SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
            SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
            SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
         FROM csv_agent_job_items
         WHERE job_id = ?`,
      )
      .get(jobId);
    return {
      totalItems: row?.total ?? 0,
      pendingItems: row?.pending ?? 0,
      runningItems: row?.running ?? 0,
      completedItems: row?.completed ?? 0,
      failedItems: row?.failed ?? 0,
    };
  }
}
