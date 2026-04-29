import type { StateSqliteDriver } from "./sqlite-driver.js";
import type { IndexedJobStatus } from "./memories.js";

export interface AgentJobRecord {
  readonly id: string;
  readonly kind: string;
  readonly status: IndexedJobStatus;
  readonly priority?: number;
  readonly input: unknown;
  readonly result?: unknown;
  readonly error?: string;
  readonly workerId?: string;
  readonly availableAt?: string;
}

export interface AgentJobItemRecord extends AgentJobRecord {
  readonly jobId: string;
  readonly ordinal: number;
  readonly attempts?: number;
}

export class AgentJobRepository {
  constructor(private readonly driver: StateSqliteDriver) {}

  upsertJob(job: AgentJobRecord): void {
    const now = new Date().toISOString();
    this.driver
      .prepareState(
        `INSERT INTO agent_jobs (
          id, kind, status, priority, input_json, result_json, error,
          worker_id, created_at, updated_at, available_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          kind = excluded.kind,
          status = excluded.status,
          priority = excluded.priority,
          input_json = excluded.input_json,
          result_json = excluded.result_json,
          error = excluded.error,
          worker_id = excluded.worker_id,
          updated_at = excluded.updated_at,
          available_at = excluded.available_at`,
      )
      .run(
        job.id,
        job.kind,
        job.status,
        job.priority ?? 0,
        JSON.stringify(job.input),
        job.result === undefined ? null : JSON.stringify(job.result),
        job.error ?? null,
        job.workerId ?? null,
        now,
        now,
        job.availableAt ?? now,
      );
  }

  upsertItem(item: AgentJobItemRecord): void {
    const now = new Date().toISOString();
    this.driver
      .prepareState(
        `INSERT INTO agent_job_items (
          id, job_id, kind, status, ordinal, input_json, result_json, error,
          worker_id, attempts, created_at, updated_at, available_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          kind = excluded.kind,
          status = excluded.status,
          ordinal = excluded.ordinal,
          input_json = excluded.input_json,
          result_json = excluded.result_json,
          error = excluded.error,
          worker_id = excluded.worker_id,
          attempts = excluded.attempts,
          updated_at = excluded.updated_at,
          available_at = excluded.available_at`,
      )
      .run(
        item.id,
        item.jobId,
        item.kind,
        item.status,
        item.ordinal,
        JSON.stringify(item.input),
        item.result === undefined ? null : JSON.stringify(item.result),
        item.error ?? null,
        item.workerId ?? null,
        item.attempts ?? 0,
        now,
        now,
        item.availableAt ?? now,
      );
  }
}
