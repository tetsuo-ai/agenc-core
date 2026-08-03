import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CsvAgentJobsRepository } from "./csv-agent-jobs.js";
import { STATE_DB_MIGRATIONS } from "./migrations/index.js";
import {
  STATE_PRE_V21_BACKUP_FILENAME,
  applyMigrations,
  openStateDatabases,
  resolveStateDatabasePaths,
  type StateSqliteDriver,
} from "./sqlite-driver.js";

let home: string;
let cwd: string;
let originalAgencHome: string | undefined;
let openDriver: StateSqliteDriver | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agenc-csv-scheduler-home-"));
  cwd = mkdtempSync(join(tmpdir(), "agenc-csv-scheduler-cwd-"));
  mkdirSync(join(cwd, ".git"));
  originalAgencHome = process.env.AGENC_HOME;
  process.env.AGENC_HOME = home;
});

afterEach(() => {
  openDriver?.close();
  openDriver = undefined;
  if (originalAgencHome === undefined) delete process.env.AGENC_HOME;
  else process.env.AGENC_HOME = originalAgencHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

function openRepository(): {
  readonly driver: StateSqliteDriver;
  readonly repository: CsvAgentJobsRepository;
} {
  const driver = openStateDatabases({ cwd });
  openDriver = driver;
  return { driver, repository: new CsvAgentJobsRepository(driver) };
}

function persistedItem(itemId: string, rowIndex: number) {
  const row = { id: `row-${rowIndex}`, value: `value-${rowIndex}` };
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

function createJob(
  repository: CsvAgentJobsRepository,
  jobId: string,
  itemCount: number,
): void {
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
      persistedItem(`${jobId}-item-${index}`, index),
    ),
  );
}

describe("CSV durable linear scheduler repository", () => {
  it("pages runnable jobs and items by immutable keysets", () => {
    const { driver, repository } = openRepository();
    createJob(repository, "job-c", 5);
    createJob(repository, "job-a", 1);
    createJob(repository, "job-b", 1);
    driver
      .prepareState("UPDATE csv_agent_jobs SET created_at_ms = ?")
      .run(1_000);

    const firstJobs = repository.listRunnableJobsPage({ limit: 2 });
    expect(firstJobs.jobs.map((job) => job.id)).toEqual(["job-a", "job-b"]);
    expect(firstJobs.nextCursor).toEqual({
      createdAtMs: 1_000,
      jobId: "job-b",
    });
    expect(
      repository
        .listRunnableJobsPage({ limit: 2, cursor: firstJobs.nextCursor })
        .jobs.map((job) => job.id),
    ).toEqual(["job-c"]);

    const firstItems = repository.listItemsForScheduler({
      jobId: "job-c",
      limit: 2,
    });
    expect(firstItems.items.map((item) => item.itemId)).toEqual([
      "job-c-item-0",
      "job-c-item-1",
    ]);
    expect(
      repository
        .listItemsForScheduler({
          jobId: "job-c",
          limit: 2,
          cursor: firstItems.nextCursor,
        })
        .items.map((item) => item.itemId),
    ).toEqual(["job-c-item-2", "job-c-item-3"]);
  });

  it("advances the durable item cursor in the dispatch transaction", () => {
    const { repository } = openRepository();
    createJob(repository, "job-a", 3);

    expect(repository.queueNextSupervisorJobPage(1)).toBe(1);
    const registration = repository.registerNextSupervisorJob();
    expect(registration).not.toBeNull();
    const claim = {
      jobId: registration!.jobId,
      supervisorEpoch: registration!.supervisorEpoch,
      registrationGeneration: registration!.registrationGeneration,
    };
    expect(
      repository
        .listReadyItemsForSupervisor(claim, 2)
        .items.map((item) => item.itemId),
    ).toEqual(["job-a-item-0", "job-a-item-1"]);

    repository.beginItemDispatch("job-a", "job-a-item-0", {
      supervisorClaim: claim,
    });
    expect(repository.getSupervisorRegistration("job-a")).toMatchObject({
      admittedItems: 1,
      itemCursor: { rowIndex: 0, itemId: "job-a-item-0" },
    });

    expect(() =>
      repository.beginItemDispatch("job-a", "job-a-item-1", {
        supervisorClaim: {
          ...claim,
          registrationGeneration: "stale-generation",
        },
      }),
    ).toThrow(/stale CSV supervisor claim/u);
    expect(repository.getItem("job-a", "job-a-item-1")?.status).toBe("pending");
    expect(repository.getJob("job-a")).toMatchObject({
      pendingItems: 2,
      runningItems: 1,
    });
    expect(repository.getSupervisorState().registeredJobs).toBe(1);
    expect(repository.finishSupervisorRegistration(claim)).toBe(true);
    expect(repository.getSupervisorState().registeredJobs).toBe(0);
  });

  it("persists the automatic full-scan budget across supervisor restarts", () => {
    const { repository } = openRepository();
    createJob(repository, "bounded-scans", 2);

    expect(
      repository.reconcileJobCounters("bounded-scans", "startup"),
    ).toMatchObject({
      matches: true,
      rowVisits: 2,
      automaticReconciliations: 1,
      integrityState: "ok",
    });
    expect(
      repository.reconcileJobCounters("bounded-scans", "startup"),
    ).toMatchObject({
      matches: true,
      rowVisits: 2,
      automaticReconciliations: 2,
      integrityState: "ok",
    });
    expect(
      repository.reconcileJobCounters("bounded-scans", "startup"),
    ).toMatchObject({
      matches: false,
      rowVisits: 0,
      automaticReconciliations: 2,
      integrityState: "poisoned",
    });
    expect(repository.getJob("bounded-scans")).toMatchObject({
      counterIntegrityState: "poisoned",
      automaticFullReconciliations: 2,
    });
    expect(repository.listRunnableJobsPage().jobs).toEqual([]);
  });

  it("poisons a mismatched counter projection instead of scheduling it", () => {
    const { driver, repository } = openRepository();
    createJob(repository, "bad-counters", 2);
    driver
      .prepareState(
        "UPDATE csv_agent_jobs SET pending_items = pending_items + 1 WHERE id = ?",
      )
      .run("bad-counters");

    const outcome = repository.reconcileJobCounters("bad-counters", "startup");
    expect(outcome).toMatchObject({
      matches: false,
      rowVisits: 2,
      integrityState: "poisoned",
    });
    expect(outcome.diagnostic).toContain("counter integrity mismatch");
    expect(repository.listRunnableJobsPage().jobs).toEqual([]);
  });
});

describe("CSV scheduler migration", () => {
  it("backs up the v19 database before applying the additive v21 schema", () => {
    const paths = resolveStateDatabasePaths({ cwd });
    mkdirSync(paths.projectDir, { recursive: true, mode: 0o700 });
    const legacy = new Database(paths.stateDbPath);
    try {
      applyMigrations(
        legacy,
        STATE_DB_MIGRATIONS.filter((migration) => migration.version < 21),
      );
    } finally {
      legacy.close();
    }

    const driver = openStateDatabases({ cwd });
    openDriver = driver;
    expect(
      driver
        .prepareState<[], { readonly version: number }>(
          "SELECT MAX(version) AS version FROM schema_migrations",
        )
        .get()?.version,
    ).toBe(21);
    expect(
      driver
        .prepareState<[], { readonly name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'csv_job_supervisor_state'",
        )
        .get()?.name,
    ).toBe("csv_job_supervisor_state");

    const backupPath = join(paths.projectDir, STATE_PRE_V21_BACKUP_FILENAME);
    expect(existsSync(backupPath)).toBe(true);
    const backup = new Database(backupPath, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      expect(
        backup
          .prepare("SELECT MAX(version) AS version FROM schema_migrations")
          .get(),
      ).toEqual({ version: 19 });
      expect(
        backup
          .prepare("PRAGMA table_info(csv_agent_jobs)")
          .all()
          .some(
            (column) =>
              (column as { readonly name?: unknown }).name === "created_at_ms",
          ),
      ).toBe(false);
    } finally {
      backup.close();
    }
  });
});
