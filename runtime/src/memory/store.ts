/**
 * Ports the upstream Rust `state/src/runtime/memories.rs` and
 * `state/src/model/memories.rs` flows onto AgenC's SQLite state driver.
 *
 * This is a state facade only: stage1/phase2 job coordination lives in the
 * project-scoped state DB, while durable memory files are loaded from the
 * global and project filesystem paths in `paths.ts`.
 */
import { randomUUID } from "node:crypto";
import type { ThreadId } from "../agents/registry.js";
import type { StateSqliteDriver } from "../state/sqlite-driver.js";
import type { ThreadSource } from "../thread-store/store.js";

const JOB_KIND_MEMORY_STAGE1 = "memory_stage1";
const JOB_KIND_MEMORY_CONSOLIDATE_GLOBAL = "memory_consolidate_global";
const MEMORY_CONSOLIDATION_JOB_KEY = "global";
const PHASE2_SUCCESS_COOLDOWN_SECONDS = 6 * 60 * 60;
const DEFAULT_RETRY_REMAINING = 3;

export interface Stage1Output {
  readonly threadId: ThreadId;
  readonly rolloutPath: string;
  readonly sourceUpdatedAt: number;
  readonly rawMemory: string;
  readonly rolloutSummary: string;
  readonly rolloutSlug?: string;
  readonly cwd: string;
  readonly gitBranch?: string;
  readonly generatedAt: number;
}

export type Stage1JobClaimOutcome =
  | { readonly type: "claimed"; readonly ownershipToken: string }
  | { readonly type: "skipped_up_to_date" }
  | { readonly type: "skipped_running" }
  | { readonly type: "skipped_retry_backoff" }
  | { readonly type: "skipped_retry_exhausted" };

export interface Stage1JobClaim {
  readonly thread: {
    readonly threadId: ThreadId;
    readonly updatedAt: string;
    readonly cwd?: string;
    readonly rolloutPath?: string;
  };
  readonly ownershipToken: string;
}

export interface Stage1StartupClaimParams {
  readonly scanLimit: number;
  readonly maxClaimed: number;
  readonly maxAgeDays: number;
  readonly minRolloutIdleHours: number;
  readonly allowedSources?: readonly ThreadSource[];
  readonly leaseSeconds: number;
}

export type Phase2JobClaimOutcome =
  | {
      readonly type: "claimed";
      readonly ownershipToken: string;
      readonly inputWatermark: number;
    }
  | { readonly type: "skipped_retry_unavailable" }
  | { readonly type: "skipped_cooldown" }
  | { readonly type: "skipped_running" };

interface Stage1OutputRow {
  readonly thread_id: string;
  readonly rollout_path: string | null;
  readonly source_updated_at: number;
  readonly raw_memory: string;
  readonly rollout_summary: string;
  readonly rollout_slug: string | null;
  readonly cwd: string | null;
  readonly git_branch: string | null;
  readonly generated_at: number;
}

interface MemoryJobPipelineRow {
  readonly status: string;
  readonly lease_until: number | null;
  readonly retry_at: number | null;
  readonly retry_remaining: number | null;
  readonly input_watermark: number | null;
  readonly last_success_watermark: number | null;
  readonly finished_at: number | null;
}

interface StartupThreadRow {
  readonly thread_id: string;
  readonly updated_at: string;
  readonly cwd: string | null;
  readonly rollout_path: string | null;
}

export class MemoryStore {
  constructor(private readonly driver: StateSqliteDriver) {}

  clearMemoryData(): void {
    this.driver.transaction(() => {
      this.driver.prepareState("DELETE FROM stage1_outputs").run();
      this.driver
        .prepareState<[string, string]>(
          "DELETE FROM memory_jobs WHERE kind = ? OR kind = ?",
        )
        .run(JOB_KIND_MEMORY_STAGE1, JOB_KIND_MEMORY_CONSOLIDATE_GLOBAL);
    });
  }

  recordStage1OutputUsage(threadIds: readonly ThreadId[]): number {
    if (threadIds.length === 0) return 0;
    const now = epochSeconds();
    return this.driver.transaction(() => {
      const update = this.driver.prepareState<[number, ThreadId]>(
        `UPDATE stage1_outputs
         SET usage_count = COALESCE(usage_count, 0) + 1,
             last_usage = ?
         WHERE thread_id = ?`,
      );
      let updated = 0;
      for (const threadId of threadIds) {
        updated += update.run(now, threadId).changes;
      }
      return updated;
    });
  }

  claimStage1JobsForStartup(
    currentThreadId: ThreadId,
    params: Stage1StartupClaimParams,
  ): Stage1JobClaim[] {
    if (params.scanLimit <= 0 || params.maxClaimed <= 0) return [];
    const nowMs = Date.now();
    const maxAgeCutoff = nowMs - Math.max(0, params.maxAgeDays) * 86_400_000;
    const idleCutoff =
      nowMs - Math.max(0, params.minRolloutIdleHours) * 3_600_000;
    const allowedSourceJson = params.allowedSources?.map(serializeThreadSourceForState);
    const sourceFilter =
      allowedSourceJson && allowedSourceJson.length > 0
        ? `AND threads.source_json IN (${allowedSourceJson.map(() => "?").join(", ")})`
        : "";
    const rows = this.driver
      .prepareState<unknown[], StartupThreadRow>(
        `SELECT threads.thread_id, threads.updated_at, threads.cwd, threads.rollout_path
         FROM threads
         LEFT JOIN stage1_outputs ON stage1_outputs.thread_id = threads.thread_id
         LEFT JOIN memory_jobs
           ON memory_jobs.kind = ?
          AND memory_jobs.job_key = threads.thread_id
         WHERE threads.memory_mode = 'enabled'
           AND threads.thread_id != ?
           ${sourceFilter}
           AND CAST(strftime('%s', threads.updated_at) AS INTEGER) * 1000 >= ?
           AND CAST(strftime('%s', threads.updated_at) AS INTEGER) * 1000 <= ?
           AND ((COALESCE(stage1_outputs.source_updated_at, -1) + 1) * 1000)
                <= CAST(strftime('%s', threads.updated_at) AS INTEGER) * 1000
           AND ((COALESCE(memory_jobs.last_success_watermark, -1) + 1) * 1000)
                <= CAST(strftime('%s', threads.updated_at) AS INTEGER) * 1000
         ORDER BY threads.updated_at DESC
         LIMIT ?`,
      )
      .all(
        JOB_KIND_MEMORY_STAGE1,
        currentThreadId,
        ...(allowedSourceJson ?? []),
        maxAgeCutoff,
        idleCutoff,
        params.scanLimit,
      );
    const claimed: Stage1JobClaim[] = [];
    for (const row of rows) {
      if (claimed.length >= params.maxClaimed) break;
      const sourceUpdatedAt = secondsFromIso(row.updated_at);
      const outcome = this.tryClaimStage1Job({
        threadId: row.thread_id,
        workerId: currentThreadId,
        sourceUpdatedAt,
        leaseSeconds: params.leaseSeconds,
        maxRunningJobs: params.maxClaimed,
      });
      if (outcome.type === "claimed") {
        claimed.push({
          thread: {
            threadId: row.thread_id,
            updatedAt: row.updated_at,
            ...(row.cwd ? { cwd: row.cwd } : {}),
            ...(row.rollout_path ? { rolloutPath: row.rollout_path } : {}),
          },
          ownershipToken: outcome.ownershipToken,
        });
      }
    }
    return claimed;
  }

  tryClaimStage1Job(params: {
    readonly threadId: ThreadId;
    readonly workerId: ThreadId;
    readonly sourceUpdatedAt: number;
    readonly leaseSeconds: number;
    readonly maxRunningJobs: number;
  }): Stage1JobClaimOutcome {
    return this.driver.transaction(() => {
      const now = epochSeconds();
      const existingOutput = this.driver
        .prepareState<[ThreadId], { source_updated_at: number }>(
          "SELECT source_updated_at FROM stage1_outputs WHERE thread_id = ?",
        )
        .get(params.threadId);
      if (
        existingOutput &&
        existingOutput.source_updated_at >= params.sourceUpdatedAt
      ) {
        return { type: "skipped_up_to_date" };
      }

      const existingJob = this.getPipelineJob(
        JOB_KIND_MEMORY_STAGE1,
        params.threadId,
      );
      if (
        existingJob?.last_success_watermark !== null &&
        existingJob?.last_success_watermark !== undefined &&
        existingJob.last_success_watermark >= params.sourceUpdatedAt
      ) {
        return { type: "skipped_up_to_date" };
      }
      if (
        existingJob?.status === "running" &&
        existingJob.lease_until !== null &&
        existingJob.lease_until > now
      ) {
        return { type: "skipped_running" };
      }
      const priorInput = existingJob?.input_watermark ?? -1;
      if (
        existingJob?.retry_at !== null &&
        existingJob?.retry_at !== undefined &&
        existingJob.retry_at > now &&
        params.sourceUpdatedAt <= priorInput
      ) {
        return { type: "skipped_retry_backoff" };
      }
      if (
        existingJob?.retry_remaining !== null &&
        existingJob?.retry_remaining !== undefined &&
        existingJob.retry_remaining <= 0 &&
        params.sourceUpdatedAt <= priorInput
      ) {
        return { type: "skipped_retry_exhausted" };
      }
      if (
        this.runningJobCount(JOB_KIND_MEMORY_STAGE1, now, params.threadId) >=
        params.maxRunningJobs
      ) {
        return { type: "skipped_running" };
      }

      const ownershipToken = randomUUID();
      const retryRemaining =
        params.sourceUpdatedAt > priorInput
          ? DEFAULT_RETRY_REMAINING
          : (existingJob?.retry_remaining ?? DEFAULT_RETRY_REMAINING);
      const changed = this.tryUpsertStage1Claim({
        threadId: params.threadId,
        workerId: params.workerId,
        ownershipToken,
        now,
        leaseUntil: now + Math.max(0, params.leaseSeconds),
        retryRemaining,
        sourceUpdatedAt: params.sourceUpdatedAt,
        maxRunningJobs: params.maxRunningJobs,
      });
      if (changed === 0) {
        return this.classifyStage1ClaimSkip(params.threadId, params.sourceUpdatedAt, now);
      }
      return { type: "claimed", ownershipToken };
    });
  }

  markStage1JobSucceeded(params: {
    readonly threadId: ThreadId;
    readonly ownershipToken: string;
    readonly sourceUpdatedAt: number;
    readonly rawMemory: string;
    readonly rolloutSummary: string;
    readonly rolloutSlug?: string;
    readonly rolloutPath?: string;
  }): boolean {
    return this.driver.transaction(() => {
      const claimedSourceUpdatedAt = this.getOwnedRunningInputWatermark(
        JOB_KIND_MEMORY_STAGE1,
        params.threadId,
        params.ownershipToken,
      );
      if (claimedSourceUpdatedAt === undefined) return false;
      if (params.sourceUpdatedAt !== claimedSourceUpdatedAt) return false;
      if (
        !this.completeOwnedPipelineJob({
          kind: JOB_KIND_MEMORY_STAGE1,
          jobKey: params.threadId,
          ownershipToken: params.ownershipToken,
          status: "completed",
          lastError: null,
          lastSuccessWatermark: claimedSourceUpdatedAt,
        })
      ) {
        return false;
      }
      this.driver
        .prepareState(
          `INSERT INTO stage1_outputs (
             thread_id, rollout_path, source_updated_at, raw_memory,
             rollout_summary, rollout_slug, generated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(thread_id) DO UPDATE SET
             rollout_path = excluded.rollout_path,
             source_updated_at = excluded.source_updated_at,
             raw_memory = excluded.raw_memory,
             rollout_summary = excluded.rollout_summary,
             rollout_slug = excluded.rollout_slug,
             generated_at = excluded.generated_at
           WHERE excluded.source_updated_at >= stage1_outputs.source_updated_at`,
        )
        .run(
          params.threadId,
          params.rolloutPath ?? "",
          claimedSourceUpdatedAt,
          params.rawMemory,
          params.rolloutSummary,
          params.rolloutSlug ?? null,
          epochSeconds(),
        );
      this.enqueueGlobalConsolidation(claimedSourceUpdatedAt);
      return true;
    });
  }

  markStage1JobNoOutput(params: {
    readonly threadId: ThreadId;
    readonly ownershipToken: string;
    readonly sourceUpdatedAt: number;
  }): boolean {
    return this.driver.transaction(() => {
      const claimedSourceUpdatedAt = this.getOwnedRunningInputWatermark(
        JOB_KIND_MEMORY_STAGE1,
        params.threadId,
        params.ownershipToken,
      );
      if (claimedSourceUpdatedAt === undefined) return false;
      if (params.sourceUpdatedAt !== claimedSourceUpdatedAt) return false;
      if (
        !this.completeOwnedPipelineJob({
          kind: JOB_KIND_MEMORY_STAGE1,
          jobKey: params.threadId,
          ownershipToken: params.ownershipToken,
          status: "completed",
          lastError: null,
          lastSuccessWatermark: claimedSourceUpdatedAt,
        })
      ) {
        return false;
      }
      const deleted = this.driver
        .prepareState<[ThreadId, number]>(
          `DELETE FROM stage1_outputs
           WHERE thread_id = ? AND source_updated_at <= ?`,
        )
        .run(params.threadId, claimedSourceUpdatedAt).changes;
      if (deleted > 0) {
        this.enqueueGlobalConsolidation(claimedSourceUpdatedAt);
      }
      return true;
    });
  }

  markStage1JobFailed(params: {
    readonly threadId: ThreadId;
    readonly ownershipToken: string;
    readonly error: string;
    readonly retryDelaySeconds: number;
  }): boolean {
    return this.failOwnedPipelineJob({
      kind: JOB_KIND_MEMORY_STAGE1,
      jobKey: params.threadId,
      ownershipToken: params.ownershipToken,
      error: params.error,
      retryDelaySeconds: params.retryDelaySeconds,
    });
  }

  listStage1OutputsForGlobal(limit: number): Stage1Output[] {
    if (limit <= 0) return [];
    return this.driver
      .prepareState<[number], Stage1OutputRow>(
        `SELECT
           so.thread_id,
           COALESCE(t.rollout_path, so.rollout_path, '') AS rollout_path,
           so.source_updated_at,
           so.raw_memory,
           so.rollout_summary,
           so.rollout_slug,
           COALESCE(t.cwd, '') AS cwd,
           NULL AS git_branch,
           so.generated_at
         FROM stage1_outputs AS so
         LEFT JOIN threads AS t ON t.thread_id = so.thread_id
         WHERE t.memory_mode = 'enabled'
           AND (length(trim(so.raw_memory)) > 0 OR length(trim(so.rollout_summary)) > 0)
         ORDER BY so.source_updated_at DESC, so.thread_id DESC
         LIMIT ?`,
      )
      .all(limit)
      .map(rowToStage1Output);
  }

  getPhase2InputSelection(limit: number, maxUnusedDays: number): Stage1Output[] {
    if (limit <= 0) return [];
    const cutoff = epochSeconds() - Math.max(0, maxUnusedDays) * 86_400;
    return this.driver
      .prepareState<[number, number, number], Stage1OutputRow>(
        `SELECT
           selected.thread_id,
           selected.rollout_path,
           selected.source_updated_at,
           selected.raw_memory,
           selected.rollout_summary,
           selected.rollout_slug,
           selected.cwd,
           selected.git_branch,
           selected.generated_at
         FROM (
           SELECT
             so.thread_id,
             COALESCE(t.rollout_path, so.rollout_path, '') AS rollout_path,
             so.source_updated_at,
             so.raw_memory,
             so.rollout_summary,
             so.rollout_slug,
             COALESCE(t.cwd, '') AS cwd,
             NULL AS git_branch,
             so.generated_at
           FROM stage1_outputs AS so
           LEFT JOIN threads AS t ON t.thread_id = so.thread_id
           WHERE t.memory_mode = 'enabled'
             AND (length(trim(so.raw_memory)) > 0 OR length(trim(so.rollout_summary)) > 0)
             AND (
               (so.last_usage IS NOT NULL AND so.last_usage >= ?)
               OR (so.last_usage IS NULL AND so.source_updated_at >= ?)
             )
           ORDER BY
             COALESCE(so.usage_count, 0) DESC,
             COALESCE(so.last_usage, so.source_updated_at) DESC,
             so.source_updated_at DESC,
             so.thread_id DESC
           LIMIT ?
         ) AS selected
         ORDER BY selected.thread_id ASC`,
      )
      .all(cutoff, cutoff, limit)
      .map(rowToStage1Output);
  }

  pruneStage1OutputsForRetention(maxUnusedDays: number, limit: number): number {
    if (limit <= 0) return 0;
    const cutoff = epochSeconds() - Math.max(0, maxUnusedDays) * 86_400;
    return this.driver
      .prepareState<[number, number]>(
        `DELETE FROM stage1_outputs
         WHERE thread_id IN (
           SELECT thread_id
           FROM stage1_outputs
           WHERE selected_for_phase2 = 0
             AND COALESCE(last_usage, source_updated_at) < ?
           ORDER BY
             COALESCE(last_usage, source_updated_at) ASC,
             source_updated_at ASC,
             thread_id ASC
           LIMIT ?
         )`,
      )
      .run(cutoff, limit).changes;
  }

  markThreadMemoryModePolluted(threadId: ThreadId): boolean {
    return this.driver.transaction(() => {
      const changed = this.driver
        .prepareState<[ThreadId]>(
          `UPDATE threads
           SET memory_mode = 'polluted'
           WHERE thread_id = ? AND memory_mode != 'polluted'`,
        )
        .run(threadId).changes;
      if (changed === 0) return false;
      const selected = this.driver
        .prepareState<[ThreadId], { selected_for_phase2: number }>(
          "SELECT selected_for_phase2 FROM stage1_outputs WHERE thread_id = ?",
        )
        .get(threadId);
      if (selected && selected.selected_for_phase2 !== 0) {
        this.enqueueGlobalConsolidation(epochSeconds());
      }
      return true;
    });
  }

  tryClaimGlobalPhase2Job(
    workerId: ThreadId,
    leaseSeconds: number,
  ): Phase2JobClaimOutcome {
    return this.driver.transaction(() => {
      const now = epochSeconds();
      const existing = this.getPipelineJob(
        JOB_KIND_MEMORY_CONSOLIDATE_GLOBAL,
        MEMORY_CONSOLIDATION_JOB_KEY,
      );
      if (
        existing?.status === "running" &&
        existing.lease_until !== null &&
        existing.lease_until > now
      ) {
        return { type: "skipped_running" };
      }
      if (phase2SuccessCooldownActive(existing, now)) {
        return { type: "skipped_cooldown" };
      }
      if (
        existing?.retry_at !== null &&
        existing?.retry_at !== undefined &&
        existing.retry_at > now
      ) {
        return { type: "skipped_retry_unavailable" };
      }
      const inputWatermark = existing?.input_watermark ?? 0;
      const ownershipToken = randomUUID();
      const changed = this.tryUpsertPhase2Claim({
        workerId,
        ownershipToken,
        now,
        leaseUntil: now + Math.max(0, leaseSeconds),
        retryRemaining: existing?.retry_remaining ?? DEFAULT_RETRY_REMAINING,
        inputWatermark,
      });
      if (changed === 0) {
        return this.classifyPhase2ClaimSkip(now);
      }
      const claimed = this.getPipelineJob(
        JOB_KIND_MEMORY_CONSOLIDATE_GLOBAL,
        MEMORY_CONSOLIDATION_JOB_KEY,
      );
      return {
        type: "claimed",
        ownershipToken,
        inputWatermark: claimed?.input_watermark ?? inputWatermark,
      };
    });
  }

  heartbeatGlobalPhase2Job(
    ownershipToken: string,
    leaseSeconds: number,
  ): boolean {
    const now = epochSeconds();
    return (
      this.driver
        .prepareState(
          `UPDATE memory_jobs
           SET lease_until = ?, updated_at = ?
           WHERE kind = ?
             AND job_key = ?
             AND ownership_token = ?
             AND status = 'running'`,
        )
        .run(
          now + Math.max(0, leaseSeconds),
          new Date().toISOString(),
          JOB_KIND_MEMORY_CONSOLIDATE_GLOBAL,
          MEMORY_CONSOLIDATION_JOB_KEY,
          ownershipToken,
        ).changes > 0
    );
  }

  markGlobalPhase2JobSucceeded(params: {
    readonly ownershipToken: string;
    readonly completedWatermark: number;
    readonly selectedOutputs: readonly Stage1Output[];
  }): boolean {
    return this.driver.transaction(() => {
      if (
        !this.completeOwnedPipelineJob({
          kind: JOB_KIND_MEMORY_CONSOLIDATE_GLOBAL,
          jobKey: MEMORY_CONSOLIDATION_JOB_KEY,
          ownershipToken: params.ownershipToken,
          status: "completed",
          lastError: null,
          lastSuccessWatermark: params.completedWatermark,
        })
      ) {
        return false;
      }
      this.driver
        .prepareState(
          `UPDATE stage1_outputs
           SET selected_for_phase2 = 0,
               selected_for_phase2_source_updated_at = NULL
           WHERE selected_for_phase2 != 0
              OR selected_for_phase2_source_updated_at IS NOT NULL`,
        )
        .run();
      const mark = this.driver.prepareState<[number, ThreadId, number]>(
        `UPDATE stage1_outputs
         SET selected_for_phase2 = 1,
             selected_for_phase2_source_updated_at = ?
         WHERE thread_id = ? AND source_updated_at = ?`,
      );
      for (const output of params.selectedOutputs) {
        mark.run(
          output.sourceUpdatedAt,
          output.threadId,
          output.sourceUpdatedAt,
        );
      }
      return true;
    });
  }

  markGlobalPhase2JobFailed(params: {
    readonly ownershipToken: string;
    readonly error: string;
    readonly retryDelaySeconds: number;
  }): boolean {
    return this.failOwnedPipelineJob({
      kind: JOB_KIND_MEMORY_CONSOLIDATE_GLOBAL,
      jobKey: MEMORY_CONSOLIDATION_JOB_KEY,
      ownershipToken: params.ownershipToken,
      error: params.error,
      retryDelaySeconds: params.retryDelaySeconds,
    });
  }

  markGlobalPhase2JobFailedIfUnowned(params: {
    readonly ownershipToken?: string;
    readonly error: string;
    readonly retryDelaySeconds: number;
  }): boolean {
    const now = epochSeconds();
    return (
      this.driver
        .prepareState(
          `UPDATE memory_jobs
           SET status = 'failed',
               finished_at = ?,
               lease_until = NULL,
               retry_at = ?,
               retry_remaining = max(COALESCE(retry_remaining, ?), 1) - 1,
               last_error = ?,
               updated_at = ?
           WHERE kind = ?
             AND job_key = ?
             AND status = 'running'
             AND (
               ownership_token IS NULL
               OR (? IS NOT NULL AND ownership_token = ?)
             )`,
        )
        .run(
          now,
          now + Math.max(0, params.retryDelaySeconds),
          DEFAULT_RETRY_REMAINING,
          params.error,
          new Date().toISOString(),
          JOB_KIND_MEMORY_CONSOLIDATE_GLOBAL,
          MEMORY_CONSOLIDATION_JOB_KEY,
          params.ownershipToken ?? null,
          params.ownershipToken ?? null,
        ).changes > 0
    );
  }

  enqueueGlobalConsolidation(inputWatermark = epochSeconds()): void {
    const existing = this.getPipelineJob(
      JOB_KIND_MEMORY_CONSOLIDATE_GLOBAL,
      MEMORY_CONSOLIDATION_JOB_KEY,
    );
    const watermark = Math.max(
      inputWatermark,
      existing?.input_watermark ?? 0,
      (existing?.last_success_watermark ?? 0) + 1,
    );
    this.upsertPipelineJob({
      kind: JOB_KIND_MEMORY_CONSOLIDATE_GLOBAL,
      jobKey: MEMORY_CONSOLIDATION_JOB_KEY,
      status: existing?.status === "running" ? "running" : "queued",
      workerId: existing?.worker_id ?? null,
      ownershipToken: existing?.ownership_token ?? null,
      startedAt: existing?.started_at ?? null,
      finishedAt: existing?.finished_at ?? null,
      leaseUntil: existing?.lease_until ?? null,
      retryAt: existing?.status === "running" ? existing.retry_at : null,
      retryRemaining: Math.max(
        existing?.retry_remaining ?? DEFAULT_RETRY_REMAINING,
        DEFAULT_RETRY_REMAINING,
      ),
      lastError: existing?.status === "running" ? existing.last_error : null,
      inputWatermark: watermark,
      lastSuccessWatermark: existing?.last_success_watermark ?? null,
    });
  }

  private getPipelineJob(
    kind: string,
    jobKey: string,
  ): (MemoryJobPipelineRow & {
    readonly ownership_token: string | null;
    readonly worker_id: string | null;
    readonly started_at: number | null;
    readonly last_error: string | null;
  }) | undefined {
    return this.driver
      .prepareState<
        [string, string],
        MemoryJobPipelineRow & {
          readonly ownership_token: string | null;
          readonly worker_id: string | null;
          readonly started_at: number | null;
          readonly last_error: string | null;
        }
      >(
        `SELECT status, worker_id, ownership_token, started_at, finished_at,
                lease_until, retry_at, retry_remaining, last_error,
                input_watermark, last_success_watermark
         FROM memory_jobs
         WHERE kind = ? AND job_key = ?`,
      )
      .get(kind, jobKey);
  }

  private getOwnedRunningInputWatermark(
    kind: string,
    jobKey: string,
    ownershipToken: string,
  ): number | undefined {
    const row = this.driver
      .prepareState<[string, string, string], { input_watermark: number | null }>(
        `SELECT input_watermark
         FROM memory_jobs
         WHERE kind = ?
           AND job_key = ?
           AND ownership_token = ?
           AND status = 'running'`,
      )
      .get(kind, jobKey, ownershipToken);
    return row?.input_watermark ?? undefined;
  }

  private runningJobCount(
    kind: string,
    now: number,
    excludingJobKey?: string,
  ): number {
    const row = this.driver
      .prepareState<[string, number, string, string], { count: number }>(
        `SELECT COUNT(*) AS count
         FROM memory_jobs
         WHERE kind = ?
           AND status = 'running'
           AND lease_until IS NOT NULL
           AND lease_until > ?
           AND (? = '' OR job_key != ?)`,
      )
      .get(kind, now, excludingJobKey ?? "", excludingJobKey ?? "");
    return row?.count ?? 0;
  }

  private classifyStage1ClaimSkip(
    threadId: ThreadId,
    sourceUpdatedAt: number,
    now: number,
  ): Exclude<Stage1JobClaimOutcome, { readonly type: "claimed"; readonly ownershipToken: string }> {
    const existingOutput = this.driver
      .prepareState<[ThreadId], { source_updated_at: number }>(
        "SELECT source_updated_at FROM stage1_outputs WHERE thread_id = ?",
      )
      .get(threadId);
    if (existingOutput && existingOutput.source_updated_at >= sourceUpdatedAt) {
      return { type: "skipped_up_to_date" };
    }
    const existingJob = this.getPipelineJob(JOB_KIND_MEMORY_STAGE1, threadId);
    if (
      existingJob?.last_success_watermark !== null &&
      existingJob?.last_success_watermark !== undefined &&
      existingJob.last_success_watermark >= sourceUpdatedAt
    ) {
      return { type: "skipped_up_to_date" };
    }
    const priorInput = existingJob?.input_watermark ?? -1;
    if (
      existingJob?.retry_at !== null &&
      existingJob?.retry_at !== undefined &&
      existingJob.retry_at > now &&
      sourceUpdatedAt <= priorInput
    ) {
      return { type: "skipped_retry_backoff" };
    }
    if (
      existingJob?.retry_remaining !== null &&
      existingJob?.retry_remaining !== undefined &&
      existingJob.retry_remaining <= 0 &&
      sourceUpdatedAt <= priorInput
    ) {
      return { type: "skipped_retry_exhausted" };
    }
    return { type: "skipped_running" };
  }

  private classifyPhase2ClaimSkip(now: number): Exclude<
    Phase2JobClaimOutcome,
    { readonly type: "claimed"; readonly ownershipToken: string; readonly inputWatermark: number }
  > {
    const existing = this.getPipelineJob(
      JOB_KIND_MEMORY_CONSOLIDATE_GLOBAL,
      MEMORY_CONSOLIDATION_JOB_KEY,
    );
    if (phase2SuccessCooldownActive(existing, now)) {
      return { type: "skipped_cooldown" };
    }
    if (
      existing?.retry_at !== null &&
      existing?.retry_at !== undefined &&
      existing.retry_at > now
    ) {
      return { type: "skipped_retry_unavailable" };
    }
    return { type: "skipped_running" };
  }

  private tryUpsertStage1Claim(params: {
    readonly threadId: ThreadId;
    readonly workerId: ThreadId;
    readonly ownershipToken: string;
    readonly now: number;
    readonly leaseUntil: number;
    readonly retryRemaining: number;
    readonly sourceUpdatedAt: number;
    readonly maxRunningJobs: number;
  }): number {
    const isoNow = new Date().toISOString();
    return this.driver
      .prepareState(
        `INSERT INTO memory_jobs (
           id, kind, job_key, status, priority, input_json, result_json, error,
           worker_id, attempts, created_at, updated_at, available_at,
           ownership_token, started_at, finished_at, lease_until, retry_at,
           retry_remaining, last_error, input_watermark, last_success_watermark
         )
         SELECT ?, ?, ?, 'running', 0, '{}', NULL, NULL, ?, 0, ?, ?, ?,
                ?, ?, NULL, ?, NULL, ?, NULL, ?, NULL
         WHERE (
           SELECT COUNT(*)
           FROM memory_jobs AS running
           WHERE running.kind = ?
             AND running.status = 'running'
             AND running.lease_until IS NOT NULL
             AND running.lease_until > ?
             AND running.job_key != ?
         ) < ?
         ON CONFLICT(kind, job_key) WHERE job_key IS NOT NULL DO UPDATE SET
           status = excluded.status,
           worker_id = excluded.worker_id,
           updated_at = excluded.updated_at,
           available_at = excluded.available_at,
           ownership_token = excluded.ownership_token,
           started_at = excluded.started_at,
           finished_at = excluded.finished_at,
           lease_until = excluded.lease_until,
           retry_at = excluded.retry_at,
           retry_remaining = CASE
             WHEN excluded.input_watermark > COALESCE(memory_jobs.input_watermark, -1)
               THEN ?
             ELSE COALESCE(memory_jobs.retry_remaining, ?)
           END,
           last_error = excluded.last_error,
           input_watermark = excluded.input_watermark,
           last_success_watermark = memory_jobs.last_success_watermark
         WHERE (memory_jobs.last_success_watermark IS NULL
                OR memory_jobs.last_success_watermark < excluded.input_watermark)
           AND NOT (
             memory_jobs.status = 'running'
             AND memory_jobs.lease_until IS NOT NULL
             AND memory_jobs.lease_until > ?
           )
           AND NOT (
             memory_jobs.retry_at IS NOT NULL
             AND memory_jobs.retry_at > ?
             AND excluded.input_watermark <= COALESCE(memory_jobs.input_watermark, -1)
           )
           AND NOT (
             memory_jobs.retry_remaining IS NOT NULL
             AND memory_jobs.retry_remaining <= 0
             AND excluded.input_watermark <= COALESCE(memory_jobs.input_watermark, -1)
           )
           AND (
             SELECT COUNT(*)
             FROM memory_jobs AS running
             WHERE running.kind = excluded.kind
               AND running.status = 'running'
               AND running.lease_until IS NOT NULL
               AND running.lease_until > ?
               AND running.job_key != excluded.job_key
           ) < ?`,
      )
      .run(
        `${JOB_KIND_MEMORY_STAGE1}:${params.threadId}`,
        JOB_KIND_MEMORY_STAGE1,
        params.threadId,
        params.workerId,
        isoNow,
        isoNow,
        isoNow,
        params.ownershipToken,
        params.now,
        params.leaseUntil,
        params.retryRemaining,
        params.sourceUpdatedAt,
        JOB_KIND_MEMORY_STAGE1,
        params.now,
        params.threadId,
        params.maxRunningJobs,
        DEFAULT_RETRY_REMAINING,
        DEFAULT_RETRY_REMAINING,
        params.now,
        params.now,
        params.now,
        params.maxRunningJobs,
      ).changes;
  }

  private tryUpsertPhase2Claim(params: {
    readonly workerId: ThreadId;
    readonly ownershipToken: string;
    readonly now: number;
    readonly leaseUntil: number;
    readonly retryRemaining: number;
    readonly inputWatermark: number;
  }): number {
    const isoNow = new Date().toISOString();
    return this.driver
      .prepareState(
        `INSERT INTO memory_jobs (
           id, kind, job_key, status, priority, input_json, result_json, error,
           worker_id, attempts, created_at, updated_at, available_at,
           ownership_token, started_at, finished_at, lease_until, retry_at,
           retry_remaining, last_error, input_watermark, last_success_watermark
         ) VALUES (?, ?, ?, 'running', 0, '{}', NULL, NULL, ?, 0, ?, ?, ?,
                   ?, ?, NULL, ?, NULL, ?, NULL, ?, NULL)
         ON CONFLICT(kind, job_key) WHERE job_key IS NOT NULL DO UPDATE SET
           status = excluded.status,
           worker_id = excluded.worker_id,
           updated_at = excluded.updated_at,
           available_at = excluded.available_at,
           ownership_token = excluded.ownership_token,
           started_at = excluded.started_at,
           finished_at = excluded.finished_at,
           lease_until = excluded.lease_until,
           retry_at = excluded.retry_at,
           retry_remaining = excluded.retry_remaining,
           last_error = excluded.last_error,
           input_watermark = max(COALESCE(memory_jobs.input_watermark, 0), excluded.input_watermark),
           last_success_watermark = memory_jobs.last_success_watermark
         WHERE NOT (
             memory_jobs.status = 'running'
             AND memory_jobs.lease_until IS NOT NULL
             AND memory_jobs.lease_until > ?
           )
           AND NOT (
             memory_jobs.finished_at IS NOT NULL
             AND memory_jobs.last_error IS NULL
             AND memory_jobs.finished_at + ? > ?
           )
           AND NOT (
             memory_jobs.retry_at IS NOT NULL
             AND memory_jobs.retry_at > ?
           )`,
      )
      .run(
        `${JOB_KIND_MEMORY_CONSOLIDATE_GLOBAL}:${MEMORY_CONSOLIDATION_JOB_KEY}`,
        JOB_KIND_MEMORY_CONSOLIDATE_GLOBAL,
        MEMORY_CONSOLIDATION_JOB_KEY,
        params.workerId,
        isoNow,
        isoNow,
        isoNow,
        params.ownershipToken,
        params.now,
        params.leaseUntil,
        params.retryRemaining,
        params.inputWatermark,
        params.now,
        PHASE2_SUCCESS_COOLDOWN_SECONDS,
        params.now,
        params.now,
      ).changes;
  }

  private upsertPipelineJob(params: {
    readonly kind: string;
    readonly jobKey: string;
    readonly status: string;
    readonly workerId: string | null;
    readonly ownershipToken: string | null;
    readonly startedAt: number | null;
    readonly finishedAt: number | null;
    readonly leaseUntil: number | null;
    readonly retryAt: number | null;
    readonly retryRemaining: number;
    readonly lastError: string | null;
    readonly inputWatermark: number;
    readonly lastSuccessWatermark: number | null;
  }): void {
    const isoNow = new Date().toISOString();
    this.driver
      .prepareState(
        `INSERT INTO memory_jobs (
           id, kind, job_key, status, priority, input_json, result_json, error,
           worker_id, attempts, created_at, updated_at, available_at,
           ownership_token, started_at, finished_at, lease_until, retry_at,
           retry_remaining, last_error, input_watermark, last_success_watermark
         ) VALUES (?, ?, ?, ?, 0, '{}', NULL, NULL, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(kind, job_key) WHERE job_key IS NOT NULL DO UPDATE SET
           status = excluded.status,
           worker_id = excluded.worker_id,
           updated_at = excluded.updated_at,
           ownership_token = excluded.ownership_token,
           started_at = excluded.started_at,
           finished_at = excluded.finished_at,
           lease_until = excluded.lease_until,
           retry_at = excluded.retry_at,
           retry_remaining = excluded.retry_remaining,
           last_error = excluded.last_error,
           input_watermark = excluded.input_watermark,
           last_success_watermark = excluded.last_success_watermark`,
      )
      .run(
        `${params.kind}:${params.jobKey}`,
        params.kind,
        params.jobKey,
        params.status,
        params.workerId,
        isoNow,
        isoNow,
        isoNow,
        params.ownershipToken,
        params.startedAt,
        params.finishedAt,
        params.leaseUntil,
        params.retryAt,
        params.retryRemaining,
        params.lastError,
        params.inputWatermark,
        params.lastSuccessWatermark,
      );
  }

  private completeOwnedPipelineJob(params: {
    readonly kind: string;
    readonly jobKey: string;
    readonly ownershipToken: string;
    readonly status: "completed";
    readonly lastError: string | null;
    readonly lastSuccessWatermark: number;
  }): boolean {
    const now = epochSeconds();
    return (
      this.driver
        .prepareState(
          `UPDATE memory_jobs
           SET status = ?,
               finished_at = ?,
               lease_until = NULL,
               retry_at = NULL,
               last_error = ?,
               last_success_watermark = CASE
                 WHEN last_success_watermark IS NULL OR last_success_watermark < ?
                   THEN ?
                 ELSE last_success_watermark
               END,
               updated_at = ?
           WHERE kind = ?
             AND job_key = ?
             AND ownership_token = ?
             AND status = 'running'`,
        )
        .run(
          params.status,
          now,
          params.lastError,
          params.lastSuccessWatermark,
          params.lastSuccessWatermark,
          new Date().toISOString(),
          params.kind,
          params.jobKey,
          params.ownershipToken,
        ).changes > 0
    );
  }

  private failOwnedPipelineJob(params: {
    readonly kind: string;
    readonly jobKey: string;
    readonly ownershipToken: string;
    readonly error: string;
    readonly retryDelaySeconds: number;
  }): boolean {
    const now = epochSeconds();
    return (
      this.driver
        .prepareState(
          `UPDATE memory_jobs
           SET status = 'failed',
               finished_at = ?,
               lease_until = NULL,
               retry_at = ?,
               retry_remaining = max(COALESCE(retry_remaining, ?), 1) - 1,
               last_error = ?,
               updated_at = ?
           WHERE kind = ?
             AND job_key = ?
             AND ownership_token = ?
             AND status = 'running'`,
        )
        .run(
          now,
          now + Math.max(0, params.retryDelaySeconds),
          DEFAULT_RETRY_REMAINING,
          params.error,
          new Date().toISOString(),
          params.kind,
          params.jobKey,
          params.ownershipToken,
        ).changes > 0
    );
  }
}

function rowToStage1Output(row: Stage1OutputRow): Stage1Output {
  return {
    threadId: row.thread_id,
    rolloutPath: row.rollout_path ?? "",
    sourceUpdatedAt: row.source_updated_at,
    rawMemory: row.raw_memory,
    rolloutSummary: row.rollout_summary,
    ...(row.rollout_slug ? { rolloutSlug: row.rollout_slug } : {}),
    cwd: row.cwd ?? "",
    ...(row.git_branch ? { gitBranch: row.git_branch } : {}),
    generatedAt: row.generated_at,
  };
}

function phase2SuccessCooldownActive(
  job: (MemoryJobPipelineRow & { readonly last_error: string | null }) | undefined,
  now: number,
): boolean {
  return (
    job?.finished_at !== null &&
    job?.finished_at !== undefined &&
    job.last_error === null &&
    job.finished_at + PHASE2_SUCCESS_COOLDOWN_SECONDS > now
  );
}

function epochSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function serializeThreadSourceForState(source: ThreadSource): string {
  return JSON.stringify(source);
}

function secondsFromIso(value: string): number {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
}
