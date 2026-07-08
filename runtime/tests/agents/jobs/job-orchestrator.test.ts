import { mkdirSync, mkdtempSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CsvAgentJobsRepository } from "../../state/csv-agent-jobs.js";
import { openStateDatabases } from "../../state/sqlite-driver.js";
import {
  recordAgentJobResult,
  runAgentsOnCsv,
  type AgentJobSpawn,
  type AgentJobSpawnContext,
} from "./job-orchestrator.js";

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "agenc-job-test-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

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
    expect(result.items.map((item) => item.itemId)).toEqual(["row1", "row2"]);
    expect(result.items.every((item) => item.status === "completed")).toBe(true);
    expect(result.items[0]!.result).toEqual({ echoed: "a" });
    expect(spawn.receivedPrompts[0]!.workerPrompt).toContain("Job ID: ");
    expect(spawn.receivedPrompts[0]!.workerPrompt).toContain("Item ID: row1");
    expect(spawn.receivedPrompts[0]!.workerPrompt).toContain("process a");
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
      spawn: fakeSpawnReporter(),
    });
    const written = await readFile(outPath, "utf8");
    // Header matches reference render_job_csv: input headers + fixed suffix
    expect(written).toContain(
      "id,value,job_id,item_id,row_index,source_id,status,attempt_count,last_error,result_json,reported_at,completed_at",
    );
    const lines = written.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    const data = lines[1]!.split(",");
    // Input columns echo the row values
    expect(data[0]).toBe("row1"); // id column value
    expect(data[1]).toBe("hi"); // value column value
    // reference-shape suffix begins at index 2
    expect(data[3]).toBe("row1"); // item_id (idColumn=id resolved to "row1")
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
            stop: ctx.itemId === "row1",
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
    expect(result.items[0]!.status).toBe("completed");
    // Deliberate divergence from the reference loop (which left
    // never-dispatched items in `pending` forever): a cancelled job
    // marks its outstanding rows `cancelled` so the job's terminal
    // state is unambiguous. row2 and row3 never dispatch.
    expect(result.items.slice(1).every((it) => it.status === "cancelled")).toBe(
      true,
    );
  });

  it("normalizes zero maxConcurrency to one worker", async () => {
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

    const result = await runAgentsOnCsv({
      csvPath,
      instruction: "process {value}",
      idColumn: "id",
      maxConcurrency: 0,
      spawn,
    });

    await Promise.all(reports);
    expect(result.items.map((item) => item.status)).toEqual([
      "completed",
      "completed",
    ]);
    expect(maxActiveWorkers).toBe(1);
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
      });
      const persisted = repository.getJob(result.jobId);
      expect(persisted?.status).toBe("completed");
      expect(persisted?.name).toBe("smoke-test");
      expect(persisted?.inputHeaders).toEqual(["id", "value"]);
      const items = repository.listItems({ jobId: result.jobId });
      expect(items).toHaveLength(2);
      expect(items.every((it) => it.status === "completed")).toBe(true);
      expect(items[0]!.result).toEqual({ echoed: "a" });
      const progress = repository.getJobProgress(result.jobId);
      expect(progress.completedItems).toBe(2);
    } finally {
      driver.close();
      if (originalAgencHome) process.env.AGENC_HOME = originalAgencHome;
      else delete process.env.AGENC_HOME;
      await rm(home, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
