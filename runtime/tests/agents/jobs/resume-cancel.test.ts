/**
 * Task 14: CSV fan-out survives a daemon restart and supports real
 * cancellation.
 *
 * Restart test: a 10-row job is killed mid-flight (4 completed, 2
 * orphaned `running`, 4 never dispatched — exactly the DB state a dead
 * daemon leaves behind), then resumed: all 10 rows complete with
 * exactly 10 output rows. Cancel test: a stop=true report terminates
 * outstanding workers and marks their rows cancelled — including rows
 * still queued, which previously stayed `pending` forever.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CsvAgentJobsRepository } from "../../state/csv-agent-jobs.js";
import { openStateDatabases } from "../../state/sqlite-driver.js";
import {
  recordAgentJobResult,
  resumeAgentJobsFromRepository,
  runAgentsOnCsv,
  type AgentJobSpawn,
} from "./job-orchestrator.js";

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "agenc-job-resume-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function openRepository(): CsvAgentJobsRepository {
  return new CsvAgentJobsRepository(openStateDatabases({ cwd: workDir }));
}

function reportingSpawn(): AgentJobSpawn & { spawned: string[] } {
  const spawned: string[] = [];
  return {
    spawned,
    async spawn(ctx) {
      spawned.push(ctx.itemId);
      queueMicrotask(() => {
        recordAgentJobResult({
          jobId: ctx.jobId,
          itemId: ctx.itemId,
          result: { echoed: ctx.row.value ?? "" },
        });
      });
    },
    async cancelOutstanding() {},
  };
}

describe("resume across daemon restart", () => {
  it("re-dispatches orphaned rows and completes all 10 with exactly 10 output rows", async () => {
    const repository = openRepository();
    const outputCsvPath = join(workDir, "out.csv");
    const jobId = "job_killed_mid_flight";
    const rows = Array.from({ length: 10 }, (_, i) => ({
      itemId: `item_${i}`,
      rowIndex: i,
      row: { id: `row${i}`, value: `v${i}` },
    }));
    repository.createJob(
      {
        id: jobId,
        name: "restart test",
        instruction: "process {value}",
        autoExport: true,
        inputHeaders: ["id", "value"],
        inputCsvPath: join(workDir, "input.csv"),
        outputCsvPath,
      },
      rows,
    );
    repository.markJobRunning(jobId);
    // The dead daemon's footprint: 4 rows finished, 2 were in flight
    // when the process died (their resolvers are gone), 4 untouched.
    for (let i = 0; i < 4; i++) {
      repository.markItemRunningWithThread(jobId, `item_${i}`, `thread_${i}`);
      repository.markItemCompleted(jobId, `item_${i}`, { echoed: `v${i}` });
    }
    repository.markItemRunningWithThread(jobId, "item_4", "thread_4");
    repository.markItemRunningWithThread(jobId, "item_5", "thread_5");

    const spawn = reportingSpawn();
    const results = await resumeAgentJobsFromRepository({ repository, spawn });

    expect(results).toHaveLength(1);
    const items = results[0]!.items;
    expect(items).toHaveLength(10);
    expect(items.every((item) => item.status === "completed")).toBe(true);
    // Only the 6 unfinished rows were re-dispatched.
    expect(spawn.spawned.sort()).toEqual(
      ["item_4", "item_5", "item_6", "item_7", "item_8", "item_9"].sort(),
    );
    // Completed rows kept their original results.
    expect(items.find((i) => i.itemId === "item_0")?.result).toEqual({
      echoed: "v0",
    });
    // Exactly 10 output rows — idempotent, no duplicates.
    const csv = await readFile(outputCsvPath, "utf8");
    const lines = csv.trim().split("\n");
    expect(lines).toHaveLength(11); // header + 10 rows
    expect(repository.getJob(jobId)?.status).toBe("completed");
    expect(
      repository
        .listItems({ jobId })
        .every((item) => item.status === "completed"),
    ).toBe(true);
  });

  it("is a no-op when no jobs are running", async () => {
    const repository = openRepository();
    const spawn = reportingSpawn();
    const results = await resumeAgentJobsFromRepository({ repository, spawn });
    expect(results).toEqual([]);
    expect(spawn.spawned).toEqual([]);
  });
});

describe("real cancellation", () => {
  it("stops outstanding rows and marks them cancelled", async () => {
    const csvPath = join(workDir, "input.csv");
    await writeFile(
      csvPath,
      ["id,value", ...Array.from({ length: 6 }, (_, i) => `row${i},v${i}`)].join(
        "\n",
      ) + "\n",
      "utf8",
    );
    const repository = openRepository();
    let cancelCalls = 0;
    const spawn: AgentJobSpawn = {
      async spawn(ctx) {
        if (ctx.itemId === "row0") {
          queueMicrotask(() => {
            recordAgentJobResult({
              jobId: ctx.jobId,
              itemId: ctx.itemId,
              result: { done: "yes" },
              stop: true,
            });
          });
        }
        // Every other worker hangs until cancelled.
      },
      async cancelOutstanding() {
        cancelCalls += 1;
      },
    };

    const result = await runAgentsOnCsv({
      csvPath,
      instruction: "do {value}",
      idColumn: "id",
      maxConcurrency: 2,
      spawn,
      repository,
    });

    expect(result.stoppedEarly).toBe(true);
    expect(cancelCalls).toBe(1);
    const byId = new Map(result.items.map((item) => [item.itemId, item]));
    expect(byId.get("row0")?.status).toBe("completed");
    // The in-flight worker (row1) and every queued row are cancelled.
    for (const id of ["row1", "row2", "row3", "row4", "row5"]) {
      expect(byId.get(id)?.status).toBe("cancelled");
    }
    // DB agrees — including the item-level cancelled status round-trip.
    const dbItems = repository.listItems({ jobId: result.jobId });
    expect(
      dbItems.filter((item) => item.status === "cancelled"),
    ).toHaveLength(5);
    expect(repository.getJob(result.jobId)?.status).toBe("cancelled");
  }, 15_000);
});
