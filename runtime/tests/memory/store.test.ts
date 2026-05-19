import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  openStateDatabases,
  type StateSqliteDriver,
} from "../state/sqlite-driver.js";
import { StateThreadRepository } from "../state/threads.js";
import type { ThreadSource } from "../thread-store/store.js";
import { MemoryStore } from "./store.js";

let home = "";
let cwd = "";
let oldAgencHome: string | undefined;
let driver: StateSqliteDriver;
let store: MemoryStore;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agenc-memory-store-home-"));
  cwd = mkdtempSync(join(tmpdir(), "agenc-memory-store-cwd-"));
  mkdirSync(join(cwd, ".git"));
  oldAgencHome = process.env.AGENC_HOME;
  process.env.AGENC_HOME = home;
  driver = openStateDatabases({ cwd });
  store = new MemoryStore(driver);
});

afterEach(() => {
  driver.close();
  if (oldAgencHome === undefined) delete process.env.AGENC_HOME;
  else process.env.AGENC_HOME = oldAgencHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

describe("MemoryStore", () => {
  it("claims stage1 work, blocks cross-driver double claims, and allows stale lease takeover", () => {
    const first = store.tryClaimStage1Job({
      threadId: "thread-1",
      workerId: "worker-a",
      sourceUpdatedAt: 100,
      leaseSeconds: 3600,
      maxRunningJobs: 1,
    });
    expect(first.type).toBe("claimed");

    const secondDriver = openStateDatabases({ cwd });
    try {
      const secondStore = new MemoryStore(secondDriver);
      const second = secondStore.tryClaimStage1Job({
        threadId: "thread-1",
        workerId: "worker-b",
        sourceUpdatedAt: 100,
        leaseSeconds: 3600,
        maxRunningJobs: 1,
      });
      expect(second.type).toBe("skipped_running");

      driver
        .prepareState("UPDATE memory_jobs SET lease_until = 0 WHERE kind = 'memory_stage1'")
        .run();
      const takeover = secondStore.tryClaimStage1Job({
        threadId: "thread-1",
        workerId: "worker-b",
        sourceUpdatedAt: 100,
        leaseSeconds: 3600,
        maxRunningJobs: 1,
      });
      expect(takeover.type).toBe("claimed");
    } finally {
      secondDriver.close();
    }
  });

  it("persists stage1 success, usage, selection, pruning, and no-output deletion", () => {
    seedThread("thread-1", { memoryMode: "enabled" });
    const claim = store.tryClaimStage1Job({
      threadId: "thread-1",
      workerId: "worker-a",
      sourceUpdatedAt: 100,
      leaseSeconds: 3600,
      maxRunningJobs: 4,
    });
    expect(claim.type).toBe("claimed");
    const token = claim.type === "claimed" ? claim.ownershipToken : "";

    expect(
      store.markStage1JobSucceeded({
        threadId: "thread-1",
        ownershipToken: token,
        sourceUpdatedAt: 100,
        rawMemory: "remember this",
        rolloutSummary: "summary",
      }),
    ).toBe(true);
    expect(
      store.tryClaimStage1Job({
        threadId: "thread-1",
        workerId: "worker-a",
        sourceUpdatedAt: 100,
        leaseSeconds: 3600,
        maxRunningJobs: 4,
      }).type,
    ).toBe("skipped_up_to_date");
    expect(store.recordStage1OutputUsage(["thread-1", "missing"])).toBe(1);
    expect(store.listStage1OutputsForGlobal(5)).toHaveLength(1);
    expect(store.getPhase2InputSelection(5, 36_500)).toHaveLength(1);
    expect(store.pruneStage1OutputsForRetention(0, 10)).toBeGreaterThanOrEqual(0);
    driver
      .prepareState("DELETE FROM memory_jobs WHERE kind = 'memory_consolidate_global'")
      .run();

    const secondClaim = store.tryClaimStage1Job({
      threadId: "thread-1",
      workerId: "worker-a",
      sourceUpdatedAt: 101,
      leaseSeconds: 3600,
      maxRunningJobs: 4,
    });
    const secondToken =
      secondClaim.type === "claimed" ? secondClaim.ownershipToken : "";
    expect(
      store.markStage1JobNoOutput({
        threadId: "thread-1",
        ownershipToken: secondToken,
        sourceUpdatedAt: 101,
      }),
    ).toBe(true);
    expect(store.listStage1OutputsForGlobal(5)).toHaveLength(0);
    const phase2 = driver
      .prepareState<[], { status: string; input_watermark: number }>(
        "SELECT status, input_watermark FROM memory_jobs WHERE kind = 'memory_consolidate_global'",
      )
      .get();
    expect(phase2?.status).toBe("queued");
    expect(phase2?.input_watermark).toBeGreaterThanOrEqual(101);

    driver
      .prepareState("DELETE FROM memory_jobs WHERE kind = 'memory_consolidate_global'")
      .run();
    const thirdClaim = store.tryClaimStage1Job({
      threadId: "thread-1",
      workerId: "worker-a",
      sourceUpdatedAt: 102,
      leaseSeconds: 3600,
      maxRunningJobs: 4,
    });
    expect(
      store.markStage1JobNoOutput({
        threadId: "thread-1",
        ownershipToken: thirdClaim.type === "claimed" ? thirdClaim.ownershipToken : "",
        sourceUpdatedAt: 102,
      }),
    ).toBe(true);
    expect(
      driver
        .prepareState("SELECT 1 FROM memory_jobs WHERE kind = 'memory_consolidate_global'")
        .get(),
    ).toBeUndefined();
  });

  it("coordinates a singleton phase2 job and marks exact selected rows", () => {
    seedThread("thread-1", { memoryMode: "enabled" });
    seedStage1("thread-1", 100);

    const claim = store.tryClaimGlobalPhase2Job("worker-a", 3600);
    expect(claim.type).toBe("claimed");
    const secondDriver = openStateDatabases({ cwd });
    const secondStore = new MemoryStore(secondDriver);
    expect(secondStore.tryClaimGlobalPhase2Job("worker-b", 3600).type).toBe(
      "skipped_running",
    );
    if (claim.type !== "claimed") throw new Error("phase2 was not claimed");

    expect(store.heartbeatGlobalPhase2Job(claim.ownershipToken, 3600)).toBe(true);
    driver
      .prepareState(
        "UPDATE memory_jobs SET lease_until = 0, last_success_watermark = 500 WHERE kind = 'memory_consolidate_global'",
      )
      .run();
    const takeover = secondStore.tryClaimGlobalPhase2Job("worker-b", 3600);
    secondDriver.close();
    expect(takeover.type).toBe("claimed");
    if (takeover.type !== "claimed") throw new Error("phase2 takeover was not claimed");

    const selected = store.getPhase2InputSelection(1, 36_500);
    expect(selected).toHaveLength(1);
    expect(
      store.markGlobalPhase2JobSucceeded({
        ownershipToken: takeover.ownershipToken,
        completedWatermark: 100,
        selectedOutputs: selected,
      }),
    ).toBe(true);
    expect(store.tryClaimGlobalPhase2Job("worker-b", 3600).type).toBe(
      "skipped_cooldown",
    );
    const row = driver
      .prepareState<[], {
        selected_for_phase2: number;
        selected_for_phase2_source_updated_at: number;
        last_success_watermark: number;
      }>(
        `SELECT
           selected_for_phase2,
           selected_for_phase2_source_updated_at,
           (SELECT last_success_watermark
            FROM memory_jobs
            WHERE kind = 'memory_consolidate_global') AS last_success_watermark
         FROM stage1_outputs`,
      )
      .get();
    expect(row?.selected_for_phase2).toBe(1);
    expect(row?.selected_for_phase2_source_updated_at).toBe(100);
    expect(row?.last_success_watermark).toBe(500);
    store.enqueueGlobalConsolidation(900);
    expect(store.tryClaimGlobalPhase2Job("worker-c", 3600).type).toBe(
      "skipped_cooldown",
    );
  });

  it("rejects stage1 completion when the source watermark mismatches the claim", () => {
    seedThread("thread-1", { memoryMode: "enabled" });
    const claim = store.tryClaimStage1Job({
      threadId: "thread-1",
      workerId: "worker-a",
      sourceUpdatedAt: 100,
      leaseSeconds: 3600,
      maxRunningJobs: 4,
    });
    if (claim.type !== "claimed") throw new Error("stage1 was not claimed");

    expect(
      store.markStage1JobSucceeded({
        threadId: "thread-1",
        ownershipToken: claim.ownershipToken,
        sourceUpdatedAt: 1000,
        rawMemory: "remember this",
        rolloutSummary: "summary",
      }),
    ).toBe(false);
    expect(
      driver
        .prepareState("SELECT 1 FROM stage1_outputs WHERE thread_id = 'thread-1'")
        .get(),
    ).toBeUndefined();
    expect(
      store.markStage1JobSucceeded({
        threadId: "thread-1",
        ownershipToken: claim.ownershipToken,
        sourceUpdatedAt: 100,
        rawMemory: "remember this",
        rolloutSummary: "summary",
      }),
    ).toBe(true);
    const successRow = driver
      .prepareState<[], {
        source_updated_at: number;
        last_success_watermark: number;
        input_watermark: number;
      }>(
        `SELECT
           so.source_updated_at,
           mj.last_success_watermark,
           phase2.input_watermark
         FROM stage1_outputs AS so
         JOIN memory_jobs AS mj
           ON mj.kind = 'memory_stage1' AND mj.job_key = so.thread_id
         JOIN memory_jobs AS phase2
           ON phase2.kind = 'memory_consolidate_global'`,
      )
      .get();
    expect(successRow?.source_updated_at).toBe(100);
    expect(successRow?.last_success_watermark).toBe(100);
    expect(successRow?.input_watermark).toBe(100);

    driver.prepareState("DELETE FROM memory_jobs WHERE kind = 'memory_consolidate_global'").run();
    const noOutputClaim = store.tryClaimStage1Job({
      threadId: "thread-1",
      workerId: "worker-a",
      sourceUpdatedAt: 101,
      leaseSeconds: 3600,
      maxRunningJobs: 4,
    });
    if (noOutputClaim.type !== "claimed") throw new Error("stage1 no-output was not claimed");
    expect(
      store.markStage1JobNoOutput({
        threadId: "thread-1",
        ownershipToken: noOutputClaim.ownershipToken,
        sourceUpdatedAt: 1000,
      }),
    ).toBe(false);
    expect(
      store.markStage1JobNoOutput({
        threadId: "thread-1",
        ownershipToken: noOutputClaim.ownershipToken,
        sourceUpdatedAt: 101,
      }),
    ).toBe(true);
    const noOutputRow = driver
      .prepareState<[], { last_success_watermark: number; input_watermark: number }>(
        `SELECT
           stage1.last_success_watermark,
           phase2.input_watermark
         FROM memory_jobs AS stage1
         JOIN memory_jobs AS phase2
           ON phase2.kind = 'memory_consolidate_global'
         WHERE stage1.kind = 'memory_stage1'
           AND stage1.job_key = 'thread-1'`,
      )
      .get();
    expect(noOutputRow?.last_success_watermark).toBe(101);
    expect(noOutputRow?.input_watermark).toBe(101);
  });

  it("fails phase2 jobs with owned-token fallback or null ownership only", () => {
    const claim = store.tryClaimGlobalPhase2Job("worker-a", 3600);
    if (claim.type !== "claimed") throw new Error("phase2 was not claimed");

    expect(
      store.markGlobalPhase2JobFailedIfUnowned({
        ownershipToken: "wrong-token",
        error: "wrong",
        retryDelaySeconds: 1,
      }),
    ).toBe(false);
    expect(
      store.markGlobalPhase2JobFailedIfUnowned({
        ownershipToken: claim.ownershipToken,
        error: "owned failure",
        retryDelaySeconds: 1,
      }),
    ).toBe(true);

    driver
      .prepareState(
        `UPDATE memory_jobs
         SET status = 'running',
             ownership_token = NULL,
             retry_at = NULL,
             lease_until = ?
         WHERE kind = 'memory_consolidate_global'`,
      )
      .run(Math.floor(Date.now() / 1000) + 3600);
    expect(
      store.markGlobalPhase2JobFailedIfUnowned({
        error: "null owner failure",
        retryDelaySeconds: 1,
      }),
    ).toBe(true);
  });

  it("claims startup jobs only for allowed serialized thread sources", () => {
    const threads = new StateThreadRepository(driver);
    const allowed = { kind: "cli", lane: "primary" } satisfies ThreadSource;
    const denied = { kind: "cli", lane: "secondary" } satisfies ThreadSource;
    const updatedAt = new Date(Date.now() - 2 * 3_600_000).toISOString();
    threads.upsertThread({
      threadId: "source-a",
      name: "source-a",
      createdAt: updatedAt,
      updatedAt,
      cwd,
      memoryMode: "enabled",
      source: allowed,
      rolloutPath: join(cwd, "source-a.jsonl"),
    });
    threads.upsertThread({
      threadId: "source-b",
      name: "source-b",
      createdAt: updatedAt,
      updatedAt,
      cwd,
      memoryMode: "enabled",
      source: denied,
      rolloutPath: join(cwd, "source-b.jsonl"),
    });

    const claims = store.claimStage1JobsForStartup("current", {
      scanLimit: 10,
      maxClaimed: 5,
      maxAgeDays: 10,
      minRolloutIdleHours: 1,
      allowedSources: [allowed],
      leaseSeconds: 3600,
    });

    expect(claims.map((claim) => claim.thread.threadId)).toEqual(["source-a"]);
  });

  it("preserves legacy MemoryJobRepository rows with null job keys", () => {
    driver
      .prepareState(
        `INSERT INTO memory_jobs (
          id, kind, status, priority, input_json, worker_id, attempts,
          created_at, updated_at, available_at
        ) VALUES ('legacy-1', 'extract', 'queued', 0, '{}', NULL, 0, ?, ?, ?)`,
      )
      .run(nowIso(), nowIso(), nowIso());
    const claim = store.tryClaimStage1Job({
      threadId: "thread-2",
      workerId: "worker-a",
      sourceUpdatedAt: 200,
      leaseSeconds: 3600,
      maxRunningJobs: 4,
    });
    expect(claim.type).toBe("claimed");
    const count = driver
      .prepareState<[], { count: number }>(
        "SELECT COUNT(*) AS count FROM memory_jobs WHERE job_key IS NULL",
      )
      .get()?.count;
    expect(count).toBe(1);
  });
});

function seedThread(
  threadId: string,
  options: { readonly memoryMode: "enabled" | "disabled" },
): void {
  driver
    .prepareState(
      `INSERT INTO threads (
        thread_id, name, created_at, updated_at, cwd, memory_mode, rollout_path
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      threadId,
      threadId,
      "2026-05-01T00:00:00.000Z",
      "2026-05-01T00:00:00.000Z",
      cwd,
      options.memoryMode,
      join(cwd, `${threadId}.jsonl`),
    );
}

function seedStage1(threadId: string, sourceUpdatedAt: number): void {
  driver
    .prepareState(
      `INSERT INTO stage1_outputs (
        thread_id, rollout_path, source_updated_at, raw_memory,
        rollout_summary, generated_at
      ) VALUES (?, '', ?, 'memory', 'summary', ?)`,
    )
    .run(threadId, sourceUpdatedAt, sourceUpdatedAt);
}

function nowIso(): string {
  return new Date().toISOString();
}
