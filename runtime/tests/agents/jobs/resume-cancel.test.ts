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
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CsvAgentJobsRepository } from "../../state/csv-agent-jobs.js";
import { openStateDatabases } from "../../state/sqlite-driver.js";
import {
  recordAgentJobResult,
  resumeAgentJobsFromRepository,
  runAgentsOnCsv as runAgentsOnCsvWithCapability,
  type AgentJobSpawn,
  type AgentJobSpawnContext,
  type CsvIdempotencyProfile,
} from "./job-orchestrator.js";
import { createCsvInputRootCapability } from "./csv-reader.js";
import { createCsvOutputRootCapability } from "./csv-output.js";

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "agenc-job-resume-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function runAgentsOnCsv(
  opts: Omit<
    Parameters<typeof runAgentsOnCsvWithCapability>[0],
    "inputRootCapability"
  >,
) {
  return runAgentsOnCsvWithCapability({
    ...opts,
    inputRootCapability: createCsvInputRootCapability(workDir),
  });
}

function openRepository(): CsvAgentJobsRepository {
  return new CsvAgentJobsRepository(openStateDatabases({ cwd: workDir }));
}

function reportingSpawn(): AgentJobSpawn & {
  spawned: string[];
  envelopes: AgentJobSpawnContext["invocationEnvelope"][];
} {
  const spawned: string[] = [];
  const envelopes: AgentJobSpawnContext["invocationEnvelope"][] = [];
  return {
    spawned,
    envelopes,
    async spawn(ctx) {
      spawned.push(ctx.itemId);
      envelopes.push(ctx.invocationEnvelope);
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

function persistedItem(itemId: string, rowIndex: number) {
  const row = { id: `row${rowIndex}`, value: `v${rowIndex}` };
  const contentSha256 = createHash("sha256")
    .update(JSON.stringify(row))
    .digest("hex");
  return {
    itemId,
    rowIndex,
    contentSha256,
    workerName: `csv_row_${rowIndex}_${contentSha256.slice(0, 16)}`,
    row,
  };
}

describe("resume across daemon restart", () => {
  it("holds orphaned dispatches for review instead of replaying them", async () => {
    const repository = openRepository();
    const outputCsvPath = join(workDir, "out.csv");
    const jobId = "job_killed_mid_flight";
    const rows = Array.from({ length: 10 }, (_, i) =>
      persistedItem(`item_${i}`, i),
    );
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
    const results = await resumeAgentJobsFromRepository({
      repository,
      spawn,
      outputRootCapability: createCsvOutputRootCapability(workDir),
    });

    expect(results).toHaveLength(1);
    expect(results[0]!.summary).toMatchObject({
      status: "needs_review",
      completedItems: 8,
      pendingItems: 0,
      unknownOutcomeItems: 2,
    });
    expect(spawn.spawned).toEqual(["item_6", "item_7", "item_8", "item_9"]);
    expect(spawn.envelopes).toHaveLength(4);
    expect(spawn.envelopes[0]!.task_instructions[0]).toMatchObject({
      inline_payload: "process {value}",
      source: { kind: "csv_job_instruction", item_id: "item_6" },
    });
    expect(spawn.envelopes[0]!.untrusted_data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          inline_payload: '"v6"',
          source: expect.objectContaining({
            kind: "csv_row_field",
            item_id: "item_6",
            row_index: 6,
            column: "value",
          }),
        }),
      ]),
    );
    const output = await readFile(outputCsvPath, "utf8");
    expect(output.trimEnd().split("\n")).toHaveLength(11);
    expect(repository.getJob(jobId)?.status).toBe("needs_review");
    expect(
      repository
        .listItems({ jobId, status: "unknown_outcome" })
        .map((item) => item.itemId),
    ).toEqual(["item_4", "item_5"]);
  });

  it("is a no-op when no jobs are running", async () => {
    const repository = openRepository();
    const spawn = reportingSpawn();
    const results = await resumeAgentJobsFromRepository({ repository, spawn });
    expect(results).toEqual([]);
    expect(spawn.spawned).toEqual([]);
  });

  it("preserves create_new output policy across restart", async () => {
    const repository = openRepository();
    const outputCsvPath = join(workDir, "create-new.csv");
    await writeFile(outputCsvPath, "concurrent owner\n", "utf8");
    repository.createJob(
      {
        id: "create-new-resume",
        name: "create-new resume",
        instruction: "process the row",
        autoExport: true,
        inputHeaders: ["id", "value"],
        inputCsvPath: join(workDir, "input.csv"),
        outputCsvPath,
        outputMode: "create_new",
      },
      [persistedItem("create-new-item", 0)],
    );

    await expect(
      resumeAgentJobsFromRepository({
        repository,
        spawn: reportingSpawn(),
        outputRootCapability: createCsvOutputRootCapability(workDir),
      }),
    ).rejects.toThrow(/already exists in create_new mode/u);
    expect(await readFile(outputCsvPath, "utf8")).toBe("concurrent owner\n");
    expect(repository.getJob("create-new-resume")?.outputMode).toBe(
      "create_new",
    );
  });

  it("replays only after an acknowledged operation key is authoritatively absent", async () => {
    const repository = openRepository();
    const row = persistedItem("opaque-item", 0);
    repository.createJob(
      {
        id: "idempotent-job",
        name: "idempotent job",
        instruction: "process {value}",
        autoExport: false,
        inputHeaders: ["id", "value"],
        inputCsvPath: join(workDir, "input.csv"),
        outputCsvPath: "",
      },
      [row],
    );
    repository.markJobRunning("idempotent-job");
    repository.beginItemDispatch("idempotent-job", "opaque-item", {
      idempotencyProfile: "synthetic-profile",
      idempotencyProfileVersion: 1,
      operationKey: "stable-operation-key",
    });
    repository.acknowledgeItemDispatch("idempotent-job", "opaque-item", {
      threadId: "dead-thread",
      providerAcknowledgedKey: "stable-operation-key",
    });
    let lookups = 0;
    const profile: CsvIdempotencyProfile = {
      name: "synthetic-profile",
      version: 1,
      deriveOperationKey: () => "stable-operation-key",
      async lookup() {
        lookups += 1;
        return { kind: "not_found", evidence: { lookup: "authoritative" } };
      },
    };
    const spawn = reportingSpawn();

    const results = await resumeAgentJobsFromRepository({
      repository,
      spawn,
      idempotencyProfiles: new Map([[profile.name, profile]]),
    });

    expect(lookups).toBe(1);
    expect(spawn.spawned).toEqual(["opaque-item"]);
    expect(results[0]!.summary).toMatchObject({
      status: "completed",
      completedItems: 1,
      unknownOutcomeItems: 0,
    });
    expect(repository.getItem("idempotent-job", "opaque-item")).toMatchObject({
      status: "completed",
      attemptCount: 2,
      operationKey: "stable-operation-key",
    });
  });
});

describe("real cancellation", () => {
  it("cancels queued rows and holds dispatched rows with ambiguous outcomes", async () => {
    const csvPath = join(workDir, "input.csv");
    await writeFile(
      csvPath,
      [
        "id,value",
        ...Array.from({ length: 6 }, (_, i) => `row${i},v${i}`),
      ].join("\n") + "\n",
      "utf8",
    );
    const repository = openRepository();
    let cancelCalls = 0;
    const spawn: AgentJobSpawn = {
      async spawn(ctx) {
        if (ctx.row.id === "row0") {
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
    const bySourceId = new Map(
      result.itemPage.map((item) => [item.sourceId, item]),
    );
    expect(bySourceId.get("row0")?.status).toBe("completed");
    expect(bySourceId.get("row1")?.status).toBe("unknown_outcome");
    for (const id of ["row2", "row3", "row4", "row5"]) {
      expect(bySourceId.get(id)?.status).toBe("cancelled");
    }
    const dbItems = repository.listItems({ jobId: result.jobId });
    expect(dbItems.filter((item) => item.status === "cancelled")).toHaveLength(
      4,
    );
    expect(
      dbItems.filter((item) => item.status === "unknown_outcome"),
    ).toHaveLength(1);
    expect(repository.getJob(result.jobId)?.status).toBe("needs_review");
  }, 15_000);
});
