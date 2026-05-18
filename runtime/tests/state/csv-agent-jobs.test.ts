import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CsvAgentJobsRepository } from "./csv-agent-jobs.js";
import { openStateDatabases, type StateSqliteDriver } from "./sqlite-driver.js";

let home = "";
let cwd = "";
let originalAgencHome = "";
let driver: StateSqliteDriver;
let repo: CsvAgentJobsRepository;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agenc-csv-jobs-home-"));
  cwd = mkdtempSync(join(tmpdir(), "agenc-csv-jobs-cwd-"));
  mkdirSync(join(cwd, ".git"));
  originalAgencHome = process.env.AGENC_HOME ?? "";
  process.env.AGENC_HOME = home;
  driver = openStateDatabases({ cwd });
  repo = new CsvAgentJobsRepository(driver);
});

afterEach(() => {
  driver.close();
  if (originalAgencHome) process.env.AGENC_HOME = originalAgencHome;
  else delete process.env.AGENC_HOME;
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

describe("CsvAgentJobsRepository", () => {
  it("createJob inserts a job with pending status and seeds items", () => {
    const job = repo.createJob(
      {
        id: "job-1",
        name: "test-job",
        instruction: "process {value}",
        autoExport: false,
        inputHeaders: ["id", "value"],
        inputCsvPath: "/tmp/input.csv",
        outputCsvPath: "",
      },
      [
        { itemId: "item_0", rowIndex: 0, row: { id: "row1", value: "a" } },
        {
          itemId: "item_1",
          rowIndex: 1,
          sourceId: "row2",
          row: { id: "row2", value: "b" },
        },
      ],
    );
    expect(job.id).toBe("job-1");
    expect(job.status).toBe("pending");
    expect(job.inputHeaders).toEqual(["id", "value"]);
    const items = repo.listItems({ jobId: "job-1" });
    expect(items).toHaveLength(2);
    expect(items[0]!.status).toBe("pending");
    expect(items[1]!.sourceId).toBe("row2");
  });

  it("transitions a job through running -> completed", () => {
    repo.createJob(
      {
        id: "j",
        name: "j",
        instruction: "x",
        autoExport: false,
        inputHeaders: ["id"],
        inputCsvPath: "/in",
        outputCsvPath: "",
      },
      [{ itemId: "i0", rowIndex: 0, row: { id: "r" } }],
    );
    repo.markJobRunning("j");
    expect(repo.getJob("j")?.status).toBe("running");
    expect(repo.getJob("j")?.startedAt).toBeGreaterThan(0);
    repo.markJobCompleted("j");
    const completed = repo.getJob("j")!;
    expect(completed.status).toBe("completed");
    expect(completed.completedAt).toBeGreaterThan(0);
  });

  it("transitions an item through running -> completed and stores result", () => {
    repo.createJob(
      {
        id: "j",
        name: "j",
        instruction: "x",
        autoExport: false,
        inputHeaders: ["id"],
        inputCsvPath: "/in",
        outputCsvPath: "",
      },
      [{ itemId: "i0", rowIndex: 0, row: { id: "r" } }],
    );
    repo.markItemRunningWithThread("j", "i0", "thread-7");
    let item = repo.getItem("j", "i0")!;
    expect(item.status).toBe("running");
    expect(item.assignedThreadId).toBe("thread-7");
    expect(item.attemptCount).toBe(1);

    repo.markItemCompleted("j", "i0", { score: 0.9, label: "ok" });
    item = repo.getItem("j", "i0")!;
    expect(item.status).toBe("completed");
    expect(item.result).toEqual({ score: 0.9, label: "ok" });
    expect(item.reportedAt).toBeGreaterThan(0);
  });

  it("getJobProgress returns per-status counts", () => {
    repo.createJob(
      {
        id: "p",
        name: "p",
        instruction: "x",
        autoExport: false,
        inputHeaders: ["id"],
        inputCsvPath: "/in",
        outputCsvPath: "",
      },
      [
        { itemId: "a", rowIndex: 0, row: {} },
        { itemId: "b", rowIndex: 1, row: {} },
        { itemId: "c", rowIndex: 2, row: {} },
      ],
    );
    repo.markItemRunning("p", "a");
    repo.markItemCompleted("p", "b", { ok: true });
    const progress = repo.getJobProgress("p");
    expect(progress.totalItems).toBe(3);
    expect(progress.pendingItems).toBe(1);
    expect(progress.runningItems).toBe(1);
    expect(progress.completedItems).toBe(1);
    expect(progress.failedItems).toBe(0);
  });

  it("deleteJob cascades to items via foreign key ON DELETE CASCADE", () => {
    repo.createJob(
      {
        id: "g",
        name: "g",
        instruction: "x",
        autoExport: false,
        inputHeaders: [],
        inputCsvPath: "/in",
        outputCsvPath: "",
      },
      [{ itemId: "x", rowIndex: 0, row: {} }],
    );
    expect(repo.listItems({ jobId: "g" })).toHaveLength(1);
    repo.deleteJob("g");
    expect(repo.getJob("g")).toBeNull();
    expect(repo.listItems({ jobId: "g" })).toHaveLength(0);
  });

  it("listJobs filters by status and orders by updated_at DESC", async () => {
    repo.createJob(
      {
        id: "older",
        name: "older",
        instruction: "x",
        autoExport: false,
        inputHeaders: [],
        inputCsvPath: "/in",
        outputCsvPath: "",
      },
      [],
    );
    // ensure distinct timestamp
    await new Promise((r) => setTimeout(r, 1100));
    repo.createJob(
      {
        id: "newer",
        name: "newer",
        instruction: "x",
        autoExport: false,
        inputHeaders: [],
        inputCsvPath: "/in",
        outputCsvPath: "",
      },
      [],
    );
    repo.markJobCompleted("newer");
    const completed = repo.listJobs({ status: "completed" });
    expect(completed.map((j) => j.id)).toEqual(["newer"]);
    const all = repo.listJobs();
    expect(all[0]!.id).toBe("newer");
    expect(all[1]!.id).toBe("older");
  });
});
