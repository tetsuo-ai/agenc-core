import type { StateSqliteDriver } from "./sqlite-driver.js";

export type IndexedJobStatus = "queued" | "running" | "completed" | "failed";

export interface MemoryJobRecord {
  readonly id: string;
  readonly kind: string;
  readonly status: IndexedJobStatus;
  readonly priority?: number;
  readonly input: unknown;
  readonly result?: unknown;
  readonly error?: string;
  readonly workerId?: string;
  readonly attempts?: number;
  readonly availableAt?: string;
}

export class MemoryJobRepository {
  constructor(private readonly driver: StateSqliteDriver) {}

  upsert(job: MemoryJobRecord): void {
    const now = new Date().toISOString();
    this.driver
      .prepareState(
        `INSERT INTO memory_jobs (
          id, kind, status, priority, input_json, result_json, error,
          worker_id, attempts, created_at, updated_at, available_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          kind = excluded.kind,
          status = excluded.status,
          priority = excluded.priority,
          input_json = excluded.input_json,
          result_json = excluded.result_json,
          error = excluded.error,
          worker_id = excluded.worker_id,
          attempts = excluded.attempts,
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
        job.attempts ?? 0,
        now,
        now,
        job.availableAt ?? now,
      );
  }
}
