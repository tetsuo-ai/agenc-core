import { once } from "node:events";
import { createWriteStream, mkdirSync, mkdtempSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_CSV_AUTOMATIC_FULL_RECONCILIATIONS_PER_JOB_LIFECYCLE,
  MAX_CSV_READY_ROWS_PER_JOB,
} from "../../../src/contracts/csv-job-contract.js";
import { CsvAgentJobsRepository } from "../../state/csv-agent-jobs.js";
import { openStateDatabases } from "../../state/sqlite-driver.js";
import {
  recordAgentJobResult,
  runAgentsOnCsv as runAgentsOnCsvWithCapability,
  type AgentJobSpawn,
  type AgentJobSpawnContext,
} from "./job-orchestrator.js";
import { createCsvInputRootCapability } from "./csv-reader.js";
import { createCsvOutputRootCapability } from "./csv-output.js";

let workDir: string;
const configuredSchedulerStressRows = Number(
  process.env.AGENC_CSV_SCHEDULER_STRESS_ROWS ?? 4_097,
);
const schedulerStressRows =
  Number.isSafeInteger(configuredSchedulerStressRows) &&
  configuredSchedulerStressRows > 0
    ? configuredSchedulerStressRows
    : 4_097;
// This contract measures paging and resident memory, not wall-clock latency.
// Loaded hosted shards can complete the same bounded work well after 20 seconds.
const schedulerStressTimeoutMs =
  process.env.AGENC_CSV_SCHEDULER_STRESS_ROWS === undefined
    ? 3 * 60_000
    : 10 * 60_000;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "agenc-job-test-"));
});

afterEach(async () => {
  vi.useRealTimers();
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

async function writeLargeCsvFixture(
  path: string,
  rowCount: number,
): Promise<void> {
  const output = createWriteStream(path, { encoding: "utf8" });
  output.write("id,value\n");
  for (let index = 0; index < rowCount; index += 1) {
    if (!output.write(`row-${index},value-${index}\n`)) {
      await once(output, "drain");
    }
  }
  output.end();
  await once(output, "finish");
}

function fakeSpawnReporter(): AgentJobSpawn & {
  receivedPrompts: AgentJobSpawnContext[];
} {
  const receivedPrompts: AgentJobSpawnContext[] = [];
  return {
    receivedPrompts,
    async spawn(ctx) {
      receivedPrompts.push(ctx);
      // Auto-report on the next tick to simulate a worker that immediately
      // produces a result.
      queueMicrotask(() => {
        recordAgentJobResult({
          jobId: ctx.jobId,
          itemId: ctx.itemId,
          result: { echoed: ctx.row.value ?? "" },
        });
      });
    },
    async cancelOutstanding() {
      // No-op; in-memory orchestrator relies on workers self-terminating.
    },
  };
}

describe("runAgentsOnCsv", () => {
  it("does not impose a default runtime deadline on workers", async () => {
    const csvPath = join(workDir, "input.csv");
    await writeFile(csvPath, "id,value\nrow1,a\n", "utf8");
    vi.useFakeTimers();
    let markSpawned!: () => void;
    const spawned = new Promise<void>((resolve) => {
      markSpawned = resolve;
    });
    const spawn: AgentJobSpawn = {
      async spawn(ctx) {
        markSpawned();
        setTimeout(
          () => {
            recordAgentJobResult({
              jobId: ctx.jobId,
              itemId: ctx.itemId,
              result: { completedAfterHours: true },
            });
          },
          2 * 60 * 60_000,
        );
      },
      async cancelOutstanding() {},
    };

    const pending = runAgentsOnCsv({
      csvPath,
      instruction: "long analysis",
      idColumn: "id",
      spawn,
    });
    const outcome = pending.then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    await spawned;
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);

    expect(await outcome).toMatchObject({
      result: {
        summary: { completedItems: 1, availableResults: 1 },
        itemPage: [{ status: "completed", resultAvailability: "available" }],
      },
    });
  });

  it("spawns one worker per row and collects their results", async () => {
    const csvPath = join(workDir, "input.csv");
    await writeFile(csvPath, "id,value\nrow1,a\nrow2,b\n", "utf8");
    const spawn = fakeSpawnReporter();
    const result = await runAgentsOnCsv({
      csvPath,
      instruction: "process {value}",
      idColumn: "id",
      spawn,
    });
    expect(result.itemPage.map((item) => item.sourceId)).toEqual([
      "row1",
      "row2",
    ]);
    expect(result.itemPage.every((item) => item.status === "completed")).toBe(
      true,
    );
    expect(result.summary.availableResults).toBe(2);
    expect(result.itemPage[0]).not.toHaveProperty("result");
    const envelope = spawn.receivedPrompts[0]!.invocationEnvelope;
    expect(envelope.invocation_id).toMatch(
      /^csv-job:.+:csv_item_[0-9a-f]{64}$/u,
    );
    expect(envelope.task_instructions[0]).toMatchObject({
      inline_payload: "process {value}",
      source: { kind: "csv_job_instruction" },
    });
    expect(envelope.untrusted_data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          inline_payload: '"a"',
          source: expect.objectContaining({
            kind: "csv_row_field",
            column: "value",
            row_index: 0,
          }),
        }),
      ]),
    );
    expect(
      envelope.task_instructions.some(
        (block) =>
          "inline_payload" in block && block.inline_payload.includes('"a"'),
      ),
    ).toBe(false);
    expect(spawn.receivedPrompts[0]!.workerName).toMatch(
      /^csv_row_0_[0-9a-f]{16}$/u,
    );
  });

  it("preserves accepted headers larger than the envelope block-ID bound", async () => {
    const header = "h".repeat(513);
    const csvPath = join(workDir, "wide-header.csv");
    await writeFile(csvPath, `${header}\nvalue\n`, "utf8");
    const spawn = fakeSpawnReporter();

    const result = await runAgentsOnCsv({
      csvPath,
      instruction: "process the field",
      spawn,
    });

    expect(result.summary.status).toBe("completed");
    expect(
      spawn.receivedPrompts[0]!.invocationEnvelope.untrusted_data[0],
    ).toMatchObject({
      source: { kind: "csv_row_field", column: header },
      inline_payload: '"value"',
    });
  });

  it("writes an output CSV when output_csv_path is set", async () => {
    const csvPath = join(workDir, "input.csv");
    const outPath = join(workDir, "out.csv");
    await writeFile(csvPath, "id,value\nrow1,hi\n", "utf8");
    await runAgentsOnCsv({
      csvPath,
      instruction: "do",
      idColumn: "id",
      outputCsvPath: outPath,
      outputRootCapability: createCsvOutputRootCapability(workDir),
      spawn: fakeSpawnReporter(),
    });
    const written = await readFile(outPath, "utf8");
    // Header matches reference render_job_csv: input headers + fixed suffix
    expect(written).toContain(
      "id,value,job_id,item_id,row_index,source_id,status,attempt_count,last_error,result_json,result_availability,reported_at,completed_at",
    );
    const lines = written.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    const data = lines[1]!.split(",");
    // Input columns echo the row values
    expect(data[0]).toBe("row1"); // id column value
    expect(data[1]).toBe("hi"); // value column value
    // reference-shape suffix begins at index 2
    expect(data[3]).toMatch(/^csv_item_[0-9a-f]{64}$/u);
    expect(data[4]).toBe("0"); // row_index
    expect(data[5]).toBe("row1"); // source_id (echoes idColumn value)
    expect(data[6]).toBe("completed"); // status
    expect(data[7]).toBe("1"); // attempt_count
    // result_json column — quoted because of internal quotes
    expect(written).toContain('"{""echoed"":""hi""}"');
  });

  it("short-circuits the remaining items when a worker requests stop", async () => {
    const csvPath = join(workDir, "input.csv");
    await writeFile(csvPath, "id\nrow1\nrow2\nrow3\n", "utf8");
    const spawn: AgentJobSpawn = {
      async spawn(ctx) {
        queueMicrotask(() => {
          recordAgentJobResult({
            jobId: ctx.jobId,
            itemId: ctx.itemId,
            result: {},
            stop: ctx.row.id === "row1",
          });
        });
      },
      async cancelOutstanding() {},
    };
    const result = await runAgentsOnCsv({
      csvPath,
      instruction: "x",
      idColumn: "id",
      maxConcurrency: 1,
      spawn,
    });
    expect(result.stoppedEarly).toBe(true);
    expect(result.itemPage[0]!.status).toBe("completed");
    // Deliberate divergence from the reference loop (which left
    // never-dispatched items in `pending` forever): a cancelled job
    // marks its outstanding rows `cancelled` so the job's terminal
    // state is unambiguous. row2 and row3 never dispatch.
    expect(
      result.itemPage.slice(1).every((it) => it.status === "cancelled"),
    ).toBe(true);
  });

  it("rejects maxConcurrency outside the persisted job contract", async () => {
    const csvPath = join(workDir, "input.csv");
    await writeFile(csvPath, "id,value\nrow1,a\nrow2,b\n", "utf8");
    let activeWorkers = 0;
    let maxActiveWorkers = 0;
    const reports: Promise<void>[] = [];
    const spawn: AgentJobSpawn = {
      async spawn(ctx) {
        activeWorkers += 1;
        maxActiveWorkers = Math.max(maxActiveWorkers, activeWorkers);
        reports.push(
          new Promise<void>((resolve) => {
            setTimeout(() => {
              recordAgentJobResult({
                jobId: ctx.jobId,
                itemId: ctx.itemId,
                result: { echoed: ctx.row.value ?? "" },
              });
              activeWorkers -= 1;
              resolve();
            }, 5);
          }),
        );
      },
      async cancelOutstanding() {},
    };

    await expect(
      runAgentsOnCsv({
        csvPath,
        instruction: "process {value}",
        idColumn: "id",
        maxConcurrency: 0,
        spawn,
      }),
    ).rejects.toThrow(/between 1 and 64/u);
    await expect(
      runAgentsOnCsv({
        csvPath,
        instruction: "process {value}",
        idColumn: "id",
        maxConcurrency: 65,
        spawn,
      }),
    ).rejects.toThrow(/between 1 and 64/u);
    expect(reports).toEqual([]);
    expect(maxActiveWorkers).toBe(0);
  });

  it("rejects invalid result and runtime bounds before importing", async () => {
    const csvPath = join(workDir, "input.csv");
    await writeFile(csvPath, "id,value\nrow1,a\n", "utf8");
    const spawn = fakeSpawnReporter();
    await expect(
      runAgentsOnCsv({
        csvPath,
        instruction: "process",
        maxResultBytes: 0,
        spawn,
      }),
    ).rejects.toThrow(/maxResultBytes/u);
    await expect(
      runAgentsOnCsv({
        csvPath,
        instruction: "process",
        maxRuntimeSeconds: Number.MAX_SAFE_INTEGER,
        spawn,
      }),
    ).rejects.toThrow(/maxRuntimeSeconds/u);
    expect(spawn.receivedPrompts).toEqual([]);
  });

  it("retries capacity refusals at the FIFO head without cancelling the job", async () => {
    const csvPath = join(workDir, "input.csv");
    await writeFile(csvPath, "id\na\nb\nc\n", "utf8");
    const attempts: string[] = [];
    let refused = false;
    const spawn: AgentJobSpawn = {
      async spawn(ctx) {
        const sourceId = String(ctx.row.id);
        attempts.push(sourceId);
        if (!refused) {
          refused = true;
          return { kind: "capacity_unavailable", retryAfterMs: 1 };
        }
        queueMicrotask(() => {
          recordAgentJobResult({
            jobId: ctx.jobId,
            itemId: ctx.itemId,
            result: { sourceId },
          });
        });
      },
      async cancelOutstanding() {},
    };

    const result = await runAgentsOnCsv({
      csvPath,
      instruction: "x",
      idColumn: "id",
      maxConcurrency: 1,
      spawn,
    });

    expect(attempts).toEqual(["a", "a", "b", "c"]);
    expect(result.summary).toMatchObject({
      status: "completed",
      completedItems: 3,
    });
    expect(result.itemPage.map((entry) => entry.sourceId)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("consumes simultaneous success and capacity-retry outcomes exactly once", async () => {
    vi.useFakeTimers();
    const csvPath = join(workDir, "input.csv");
    await writeFile(csvPath, "id\nsuccess\nretry\n", "utf8");
    const attempts: string[] = [];
    let initialSpawns!: () => void;
    const initialSpawned = new Promise<void>((resolve) => {
      initialSpawns = resolve;
    });
    const spawn: AgentJobSpawn = {
      async spawn(ctx) {
        const sourceId = String(ctx.row.id);
        attempts.push(sourceId);
        if (attempts.length === 2) initialSpawns();
        if (
          sourceId === "retry" &&
          attempts.filter((id) => id === sourceId).length === 1
        ) {
          return { kind: "capacity_unavailable", retryAfterMs: 1 };
        }
        setTimeout(() => {
          recordAgentJobResult({
            jobId: ctx.jobId,
            itemId: ctx.itemId,
            result: { sourceId },
          });
        }, 1);
        return { kind: "launched" };
      },
      async cancelOutstanding() {},
    };

    const running = runAgentsOnCsv({
      csvPath,
      instruction: "x",
      idColumn: "id",
      maxConcurrency: 2,
      spawn,
    });
    await initialSpawned;
    await Promise.resolve();
    vi.runOnlyPendingTimers();
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();

    expect(attempts).toEqual(["success", "retry", "retry"]);
    await vi.runAllTimersAsync();
    const result = await running;
    expect(result.summary).toMatchObject({
      status: "completed",
      pendingItems: 0,
      completedItems: 2,
    });
  });

  it("propagates a repository-backed foreground report anomaly without stranding its waiter", async () => {
    const home = mkdtempSync(join(tmpdir(), "agenc-orchestrator-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "agenc-orchestrator-cwd-"));
    mkdirSync(join(cwd, ".git"));
    const originalAgencHome = process.env.AGENC_HOME;
    process.env.AGENC_HOME = home;
    const driver = openStateDatabases({ cwd });
    const repository = new CsvAgentJobsRepository(driver);
    const phases: string[] = [];
    const reconcile = repository.reconcileJobCounters.bind(repository);
    repository.reconcileJobCounters = (jobId, phase) => {
      phases.push(phase);
      return reconcile(jobId, phase);
    };
    const csvPath = join(workDir, "counter-anomaly.csv");
    await writeFile(csvPath, "id,value\nrow-0,value-0\n", "utf8");
    let reporterError: unknown;
    try {
      await expect(
        runAgentsOnCsv({
          csvPath,
          instruction: "process",
          idColumn: "id",
          repository,
          spawn: {
            async spawn(ctx) {
              driver
                .prepareState(
                  `UPDATE csv_agent_jobs SET
                     pending_items = pending_items + 1,
                     automatic_full_reconciliations = ?
                   WHERE id = ?`,
                )
                .run(
                  MAX_CSV_AUTOMATIC_FULL_RECONCILIATIONS_PER_JOB_LIFECYCLE,
                  ctx.jobId,
                );
              queueMicrotask(() => {
                try {
                  recordAgentJobResult({
                    jobId: ctx.jobId,
                    itemId: ctx.itemId,
                    result: { value: ctx.row.value },
                  });
                } catch (error) {
                  reporterError = error;
                }
              });
              return { kind: "launched" };
            },
            async cancelOutstanding() {},
          },
        }),
      ).rejects.toThrow(/counter integrity violation/u);

      expect(reporterError).toBeInstanceOf(Error);
      expect(phases).toEqual(["anomaly"]);
      const [job] = repository.listJobs();
      expect(job).toMatchObject({
        counterIntegrityState: "poisoned",
        automaticFullReconciliations:
          MAX_CSV_AUTOMATIC_FULL_RECONCILIATIONS_PER_JOB_LIFECYCLE,
      });
      expect(job?.counterIntegrityError).toContain(
        "reconciliation limit exhausted before anomaly",
      );
    } finally {
      driver.close();
      if (originalAgencHome === undefined) delete process.env.AGENC_HOME;
      else process.env.AGENC_HOME = originalAgencHome;
      await rm(home, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("holds capacity until a completed worker exits or is explicitly retired", async () => {
    vi.useFakeTimers();
    const csvPath = join(workDir, "input.csv");
    await writeFile(csvPath, "id\nrow1\n", "utf8");
    let spawned!: () => void;
    const didSpawn = new Promise<void>((resolve) => {
      spawned = resolve;
    });
    const retireItem = vi.fn(async () => {});
    const spawn: AgentJobSpawn = {
      async spawn(ctx) {
        spawned();
        queueMicrotask(() => {
          recordAgentJobResult({
            jobId: ctx.jobId,
            itemId: ctx.itemId,
            result: { ok: true },
          });
        });
        return {
          kind: "launched",
          threadId: "lingering-thread",
          threadFinished: new Promise<void>(() => {}),
        };
      },
      async cancelOutstanding() {},
      retireItem,
    };

    const running = runAgentsOnCsv({
      csvPath,
      instruction: "x",
      idColumn: "id",
      spawn,
    });
    await didSpawn;
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await running;

    expect(retireItem).toHaveBeenCalledWith(
      result.jobId,
      result.itemPage[0]!.itemId,
      "lingering-thread",
    );
    expect(result.summary.status).toBe("completed");
  });

  it("surfaces a completed worker that cannot be authoritatively retired", async () => {
    const csvPath = join(workDir, "input.csv");
    await writeFile(csvPath, "id\nrow1\n", "utf8");
    const retirementFailure = new Error("worker shutdown fence failed");
    const retireItem = vi.fn(async () => {
      throw retirementFailure;
    });
    const spawn: AgentJobSpawn = {
      async spawn(ctx) {
        queueMicrotask(() => {
          recordAgentJobResult({
            jobId: ctx.jobId,
            itemId: ctx.itemId,
            result: { ok: true },
          });
        });
        return {
          kind: "launched",
          threadId: "unretired-thread",
          threadFinished: Promise.resolve(),
        };
      },
      async cancelOutstanding() {},
      retireItem,
    };

    await expect(
      runAgentsOnCsv({
        csvPath,
        instruction: "x",
        idColumn: "id",
        spawn,
      }),
    ).rejects.toBe(retirementFailure);
    expect(retireItem).toHaveBeenCalledOnce();
  });

  it("returns only a bounded first item page and never embeds result bodies", async () => {
    const csvPath = join(workDir, "input.csv");
    await writeFile(
      csvPath,
      ["id", ...Array.from({ length: 60 }, (_, index) => `row-${index}`)].join(
        "\n",
      ) + "\n",
      "utf8",
    );
    const result = await runAgentsOnCsv({
      csvPath,
      instruction: "x",
      idColumn: "id",
      maxConcurrency: 8,
      spawn: fakeSpawnReporter(),
    });

    expect(result.summary.totalItems).toBe(60);
    expect(result.itemPage).toHaveLength(20);
    expect(result.nextItemCursor).toMatch(/^agenc-csv-items-v1:/u);
    expect(result.itemPage[0]).not.toHaveProperty("row");
    expect(result.itemPage[0]).not.toHaveProperty("result");
  });

  it("rejects when csv contains zero data rows", async () => {
    const csvPath = join(workDir, "empty.csv");
    await writeFile(csvPath, "id\n", "utf8");
    await expect(
      runAgentsOnCsv({
        csvPath,
        instruction: "x",
        spawn: fakeSpawnReporter(),
      }),
    ).rejects.toThrow(/zero data rows/);
  });

  it("rejects when id_column is not in the header", async () => {
    const csvPath = join(workDir, "input.csv");
    await writeFile(csvPath, "id\nrow1\n", "utf8");
    await expect(
      runAgentsOnCsv({
        csvPath,
        instruction: "x",
        idColumn: "missing",
        spawn: fakeSpawnReporter(),
      }),
    ).rejects.toThrow(/id_column/);
  });
});

describe("recordAgentJobResult", () => {
  it("returns unknown_job when the job id is not registered", () => {
    expect(
      recordAgentJobResult({
        jobId: "nope",
        itemId: "x",
        result: {},
      }),
    ).toEqual({ kind: "unknown_job" });
  });
});

describe("runAgentsOnCsv with SQLite repository", () => {
  it("persists job + item lifecycle to csv_agent_jobs tables", async () => {
    const home = mkdtempSync(join(tmpdir(), "agenc-orchestrator-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "agenc-orchestrator-cwd-"));
    mkdirSync(join(cwd, ".git"));
    const originalAgencHome = process.env.AGENC_HOME ?? "";
    process.env.AGENC_HOME = home;
    const driver = openStateDatabases({ cwd });
    const repository = new CsvAgentJobsRepository(driver);
    try {
      const csvPath = join(workDir, "input.csv");
      await writeFile(csvPath, "id,value\nrow1,a\nrow2,b\n", "utf8");
      const result = await runAgentsOnCsv({
        csvPath,
        instruction: "process {value}",
        idColumn: "id",
        spawn: fakeSpawnReporter(),
        repository,
        jobName: "smoke-test",
        outputRootCapability: createCsvOutputRootCapability(cwd),
      });
      const persisted = repository.getJob(result.jobId);
      expect(persisted?.status).toBe("completed");
      expect(persisted?.name).toBe("smoke-test");
      expect(persisted?.inputHeaders).toEqual(["id", "value"]);
      expect(persisted?.outputDigest).toMatch(/^[0-9a-f]{64}$/u);
      expect(persisted?.outputBytes).toBeGreaterThan(0);
      expect(result.outputArtifact?.sha256).toBe(persisted?.outputDigest);
      const items = repository.listItems({ jobId: result.jobId });
      expect(items).toHaveLength(2);
      expect(items.every((it) => it.status === "completed")).toBe(true);
      expect(items[0]!.result).toEqual({ echoed: "a" });
      const progress = repository.getJobProgress(result.jobId);
      expect(progress.completedItems).toBe(2);
      expect(
        driver
          .prepareState<
            [],
            {
              readonly intents: number;
              readonly files: number;
              readonly bytes: number;
            }
          >(
            `SELECT
               (SELECT COUNT(*) FROM csv_output_intents) AS intents,
               output_staging_files AS files,
               output_staging_bytes AS bytes
             FROM csv_storage_quota WHERE singleton = 1`,
          )
          .get(),
      ).toMatchObject({ intents: 0, files: 0, bytes: 0 });
    } finally {
      driver.close();
      if (originalAgencHome) process.env.AGENC_HOME = originalAgencHome;
      else delete process.env.AGENC_HOME;
      await rm(home, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  // Raise AGENC_CSV_SCHEDULER_STRESS_ROWS to 100000 or 1000000 for the
  // operation-count/RSS stress lane without slowing the required suite.
  it(
    "loads a large initial run through bounded keyset pages",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "agenc-orchestrator-home-"));
      const cwd = mkdtempSync(join(tmpdir(), "agenc-orchestrator-cwd-"));
      mkdirSync(join(cwd, ".git"));
      const originalAgencHome = process.env.AGENC_HOME;
      process.env.AGENC_HOME = home;
      const driver = openStateDatabases({ cwd });
      const repository = new CsvAgentJobsRepository(driver);
      const originalMapSet = Map.prototype.set;
      let residentItemHighWater = 0;
      const mapSetSpy = vi
        .spyOn(Map.prototype, "set")
        .mockImplementation(function (key: unknown, value: unknown) {
          const result = originalMapSet.call(this, key, value);
          if (
            typeof value === "object" &&
            value !== null &&
            "jobId" in value &&
            "itemId" in value &&
            "row" in value &&
            "status" in value
          ) {
            residentItemHighWater = Math.max(residentItemHighWater, this.size);
          }
          return result;
        });
      const originalPage = repository.listItemsForScheduler.bind(repository);
      const observedPageSizes: number[] = [];
      repository.listItemsForScheduler = (options) => {
        const page = originalPage(options);
        observedPageSizes.push(page.items.length);
        return page;
      };
      try {
        const rowCount = schedulerStressRows;
        const csvPath = join(workDir, "large-input.csv");
        await writeLargeCsvFixture(csvPath, rowCount);
        const spawn: AgentJobSpawn = {
          async spawn(ctx) {
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

        const result = await runAgentsOnCsv({
          csvPath,
          instruction: "process",
          idColumn: "id",
          maxConcurrency: 8,
          spawn,
          repository,
        });

        expect(result.summary).toMatchObject({
          totalItems: rowCount,
          completedItems: rowCount,
        });
        expect(observedPageSizes.length).toBeGreaterThanOrEqual(
          Math.ceil(rowCount / 1_000),
        );
        expect(Math.max(...observedPageSizes)).toBeLessThanOrEqual(1_000);
        expect(residentItemHighWater).toBeLessThanOrEqual(
          MAX_CSV_READY_ROWS_PER_JOB,
        );
      } finally {
        mapSetSpy.mockRestore();
        driver.close();
        if (originalAgencHome === undefined) delete process.env.AGENC_HOME;
        else process.env.AGENC_HOME = originalAgencHome;
        await rm(home, { recursive: true, force: true });
        await rm(cwd, { recursive: true, force: true });
      }
    },
    schedulerStressTimeoutMs,
  );
});
