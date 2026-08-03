import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CsvAgentJobsRepository } from "../../state/csv-agent-jobs.js";
import {
  openStateDatabases,
  type StateSqliteDriver,
} from "../../state/sqlite-driver.js";
import {
  CsvJobCompactingQueue,
  CsvJobRecoverySupervisor,
  recordAgentJobResult,
  type AgentJobSpawn,
} from "./job-orchestrator.js";

let home: string;
let cwd: string;
let originalAgencHome: string | undefined;
let driver: StateSqliteDriver;
let repository: CsvAgentJobsRepository;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agenc-linear-scheduler-home-"));
  cwd = mkdtempSync(join(tmpdir(), "agenc-linear-scheduler-cwd-"));
  mkdirSync(join(cwd, ".git"));
  originalAgencHome = process.env.AGENC_HOME;
  process.env.AGENC_HOME = home;
  driver = openStateDatabases({ cwd });
  repository = new CsvAgentJobsRepository(driver);
});

afterEach(() => {
  driver.close();
  if (originalAgencHome === undefined) delete process.env.AGENC_HOME;
  else process.env.AGENC_HOME = originalAgencHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

function persistedItem(jobId: string, rowIndex: number) {
  const row = { id: `${jobId}-row-${rowIndex}`, value: `${jobId}-${rowIndex}` };
  const contentSha256 = createHash("sha256")
    .update(JSON.stringify(row))
    .digest("hex");
  return {
    itemId: `${jobId}-item-${rowIndex}`,
    rowIndex,
    contentSha256,
    workerName: `csv_row_${rowIndex}_${contentSha256.slice(0, 16)}`,
    row,
  };
}

function createJob(jobId: string, itemCount: number): void {
  repository.createJob(
    {
      id: jobId,
      name: jobId,
      instruction: "process {value}",
      autoExport: false,
      inputHeaders: ["id", "value"],
      inputCsvPath: join(cwd, `${jobId}.csv`),
      outputCsvPath: "",
      requestedMaxConcurrency: 1,
    },
    Array.from({ length: itemCount }, (_, index) =>
      persistedItem(jobId, index),
    ),
  );
}

describe("CsvJobCompactingQueue", () => {
  it("preserves FIFO order while compacting consumed storage geometrically", () => {
    const queue = new CsvJobCompactingQueue<number>();
    for (let value = 0; value < 20_000; value += 1) queue.enqueue(value);

    for (let expected = 0; expected < 15_000; expected += 1) {
      expect(queue.dequeue()).toBe(expected);
    }

    expect(queue.size).toBe(5_000);
    expect(queue.retainedSlots).toBeLessThanOrEqual(queue.size + 4_096);
    for (let expected = 15_000; expected < 20_000; expected += 1) {
      expect(queue.dequeue()).toBe(expected);
    }
    expect(queue.size).toBe(0);
    expect(queue.retainedSlots).toBe(0);
  });

  it("retries the refused FIFO head before later entries", () => {
    const queue = new CsvJobCompactingQueue<string>();
    queue.enqueue("first");
    queue.enqueue("second");
    const refused = queue.dequeue();
    expect(refused).toBe("first");
    queue.enqueueFront(refused!);
    expect(queue.dequeue()).toBe("first");
    expect(queue.dequeue()).toBe("second");
  });
});

describe("CsvJobRecoverySupervisor", () => {
  it("adopts a crash-left registration without replaying its ambiguous item", async () => {
    createJob("restart-job", 2);
    expect(repository.queueNextSupervisorJobPage(1)).toBe(1);
    const abandoned = repository.registerNextSupervisorJob();
    expect(abandoned).not.toBeNull();
    expect(repository.getSupervisorState().registeredJobs).toBe(1);
    repository.beginItemDispatch("restart-job", "restart-job-item-0", {
      supervisorClaim: {
        jobId: abandoned!.jobId,
        supervisorEpoch: abandoned!.supervisorEpoch,
        registrationGeneration: abandoned!.registrationGeneration,
      },
    });
    const spawned: string[] = [];
    const spawn: AgentJobSpawn = {
      async spawn(ctx) {
        spawned.push(ctx.itemId);
        queueMicrotask(() => {
          recordAgentJobResult({
            jobId: ctx.jobId,
            itemId: ctx.itemId,
            result: { value: ctx.row.value },
          });
        });
      },
      async cancelOutstanding() {},
    };

    const supervisor = new CsvJobRecoverySupervisor({ repository, spawn });
    expect(await supervisor.start()).toBe(1);
    const results = await supervisor.waitForCompletion();

    expect(results[0]?.summary).toMatchObject({
      status: "needs_review",
      completedItems: 1,
      unknownOutcomeItems: 1,
    });
    expect(spawned).toEqual(["restart-job-item-1"]);
    expect(
      repository.getItem("restart-job", "restart-job-item-0"),
    ).toMatchObject({
      status: "unknown_outcome",
      reviewStatus: "pending",
    });
    expect(repository.getSupervisorRegistration("restart-job")).toMatchObject({
      substate: "done",
    });
    expect(repository.getSupervisorState().registeredJobs).toBe(0);
  });

  it("keeps jobs progressing fairly while retrying a refused FIFO head", async () => {
    createJob("job-a", 3);
    createJob("job-b", 2);
    driver
      .prepareState("UPDATE csv_agent_jobs SET created_at_ms = ?")
      .run(1_000);
    const capacityAttempts: string[] = [];
    const spawned: string[] = [];
    let refusedFirst = false;
    const spawn: AgentJobSpawn = {
      async acquireCapacity({ itemId }) {
        capacityAttempts.push(itemId);
        if (itemId === "job-a-item-0" && !refusedFirst) {
          refusedFirst = true;
          return { kind: "capacity_unavailable", retryAfterMs: 1 };
        }
        return undefined;
      },
      async spawn(ctx) {
        spawned.push(ctx.itemId);
        queueMicrotask(() => {
          recordAgentJobResult({
            jobId: ctx.jobId,
            itemId: ctx.itemId,
            result: { value: ctx.row.value },
          });
        });
      },
      async cancelOutstanding() {},
    };

    const supervisor = new CsvJobRecoverySupervisor({ repository, spawn });
    const started = await supervisor.start();
    const results = await supervisor.waitForCompletion();

    expect(started).toBe(2);
    expect(results).toHaveLength(2);
    expect(results.map((result) => result.summary.status)).toEqual([
      "completed",
      "completed",
    ]);
    expect(capacityAttempts.filter((id) => id === "job-a-item-0")).toHaveLength(
      2,
    );
    expect(spawned.indexOf("job-a-item-0")).toBeLessThan(
      spawned.indexOf("job-a-item-1"),
    );
    expect(spawned.indexOf("job-b-item-0")).toBeLessThan(
      spawned.indexOf("job-a-item-2"),
    );
    expect(repository.getJob("job-a")).toMatchObject({
      status: "completed",
      completedItems: 3,
      automaticFullReconciliations: 2,
    });
    expect(repository.getJob("job-b")).toMatchObject({
      status: "completed",
      completedItems: 2,
      automaticFullReconciliations: 2,
    });
  });

  it("owns cancellation and waits for its launched worker during shutdown", async () => {
    createJob("shutdown-job", 1);
    let resolveWorker!: () => void;
    const workerFinished = new Promise<void>((resolve) => {
      resolveWorker = resolve;
    });
    let markSpawned!: () => void;
    const workerSpawned = new Promise<void>((resolve) => {
      markSpawned = resolve;
    });
    const cancelled: string[] = [];
    const spawn: AgentJobSpawn = {
      async spawn(ctx) {
        markSpawned();
        return {
          kind: "launched",
          threadId: "owned-thread",
          threadFinished: workerFinished,
        };
      },
      async cancelOutstanding(jobId) {
        cancelled.push(jobId);
        resolveWorker();
      },
    };
    const supervisor = new CsvJobRecoverySupervisor({ repository, spawn });

    await supervisor.start();
    await workerSpawned;
    await supervisor.shutdown("test shutdown");

    expect(cancelled).toContain("shutdown-job");
    expect(
      repository.getItem("shutdown-job", "shutdown-job-item-0"),
    ).toMatchObject({
      status: "unknown_outcome",
      assignedThreadId: "owned-thread",
      reviewStatus: "pending",
    });
  });
});
