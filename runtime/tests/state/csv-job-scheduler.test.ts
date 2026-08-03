import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runtimeRootPath } from "../helpers/source-path.ts";
import { MAX_CSV_JOB_REGISTRATION_HOLD_MS } from "../../src/contracts/csv-job-contract.js";
import { CsvAgentJobsRepository } from "./csv-agent-jobs.js";
import { SET_BASED_CANCELLATION_SCHEMA_VERSION } from "./migrations/023_set_based_cancellation_indexes.js";
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

  it("replays a refilled page after a crash before durable dispatch", () => {
    const { repository } = openRepository();
    createJob(repository, "refill-crash", 3);
    expect(repository.queueNextSupervisorJobPage(1)).toBe(1);
    const abandoned = repository.registerNextSupervisorJob()!;
    const abandonedClaim = {
      jobId: abandoned.jobId,
      supervisorEpoch: abandoned.supervisorEpoch,
      registrationGeneration: abandoned.registrationGeneration,
    };
    const refilled = repository.listReadyItemsForSupervisor(abandonedClaim, 2);
    expect(refilled.items.map((item) => item.itemId)).toEqual([
      "refill-crash-item-0",
      "refill-crash-item-1",
    ]);
    expect(repository.getSupervisorRegistration("refill-crash")?.itemCursor)
      .toBeUndefined;

    const nextOwner = repository.claimSupervisorOwnership();
    const adopted = repository.registerNextSupervisorJob()!;
    const adoptedClaim = {
      jobId: adopted.jobId,
      supervisorEpoch: adopted.supervisorEpoch,
      registrationGeneration: adopted.registrationGeneration,
    };
    expect(adopted.supervisorEpoch).toBe(nextOwner.epoch);
    expect(
      repository
        .listReadyItemsForSupervisor(adoptedClaim, 2)
        .items.map((item) => item.itemId),
    ).toEqual(["refill-crash-item-0", "refill-crash-item-1"]);

    repository.beginItemDispatch("refill-crash", "refill-crash-item-0", {
      supervisorClaim: adoptedClaim,
    });
    expect(repository.getSupervisorRegistration("refill-crash")).toMatchObject({
      itemCursor: { rowIndex: 0, itemId: "refill-crash-item-0" },
    });
  });

  it("atomically rewinds the durable cursor when a dispatch returns to pending", () => {
    const { driver, repository } = openRepository();
    createJob(repository, "rotation-retry", 3);
    createJob(repository, "rotation-wait", 1);
    expect(repository.queueNextSupervisorJobPage(2)).toBe(2);
    const registration = repository.registerNextSupervisorJob()!;
    expect(registration.jobId).toBe("rotation-retry");
    const claim = {
      jobId: registration.jobId,
      supervisorEpoch: registration.supervisorEpoch,
      registrationGeneration: registration.registrationGeneration,
    };

    repository.beginItemDispatch("rotation-retry", "rotation-retry-item-0", {
      supervisorClaim: claim,
    });
    repository.markItemPending(
      "rotation-retry",
      "rotation-retry-item-0",
      undefined,
      claim,
    );
    expect(
      repository.getSupervisorRegistration("rotation-retry")?.itemCursor,
    ).toBeUndefined();

    repository.beginItemDispatch("rotation-retry", "rotation-retry-item-0", {
      supervisorClaim: claim,
    });
    driver
      .prepareState(
        `UPDATE csv_job_supervisor_registrations
         SET registered_at_ms = ? WHERE job_id = ?`,
      )
      .run(Date.now() - MAX_CSV_JOB_REGISTRATION_HOLD_MS, "rotation-retry");
    expect(repository.rotateSupervisorRegistration(claim, false)).toBe(true);
    repository.markItemPending(
      "rotation-retry",
      "rotation-retry-item-0",
      undefined,
      claim,
    );
    expect(
      repository.getSupervisorRegistration("rotation-retry"),
    ).toMatchObject({ substate: "rotating" });
    expect(
      repository.getSupervisorRegistration("rotation-retry")?.itemCursor,
    ).toBeUndefined();

    expect(repository.completeSupervisorRotation(claim)).toBe(true);
    expect(repository.registerNextSupervisorJob()?.jobId).toBe("rotation-wait");
    const replacement = repository.registerNextSupervisorJob()!;
    expect(replacement.jobId).toBe("rotation-retry");
    expect(
      repository
        .listReadyItemsForSupervisor(
          {
            jobId: replacement.jobId,
            supervisorEpoch: replacement.supervisorEpoch,
            registrationGeneration: replacement.registrationGeneration,
          },
          1,
        )
        .items.map((item) => item.itemId),
    ).toEqual(["rotation-retry-item-0"]);
  });

  it("withholds a rotated job until its runtime releases ownership", () => {
    const { repository } = openRepository();
    createJob(repository, "rotation-release", 1);
    expect(repository.queueNextSupervisorJobPage(1)).toBe(1);
    const registration = repository.registerNextSupervisorJob()!;
    const claim = {
      jobId: registration.jobId,
      supervisorEpoch: registration.supervisorEpoch,
      registrationGeneration: registration.registrationGeneration,
    };

    expect(repository.rotateSupervisorRegistration(claim, true)).toBe(true);
    expect(
      repository.getSupervisorRegistration("rotation-release"),
    ).toMatchObject({ substate: "rotating" });
    expect(repository.getSupervisorState().registeredJobs).toBe(0);
    expect(repository.registerNextSupervisorJob()).toBeNull();

    expect(repository.completeSupervisorRotation(claim)).toBe(true);
    expect(
      repository.getSupervisorRegistration("rotation-release"),
    ).toMatchObject({ substate: "recovery_queued" });
    const replacement = repository.registerNextSupervisorJob()!;
    expect(replacement.registrationGeneration).not.toBe(
      registration.registrationGeneration,
    );
  });

  it("fences ownership in constant time and adopts stale claims in queue order", () => {
    const { driver, repository } = openRepository();
    createJob(repository, "owner-a", 1);
    createJob(repository, "owner-b", 1);
    createJob(repository, "owner-c", 1);
    driver
      .prepareState("UPDATE csv_agent_jobs SET created_at_ms = ?")
      .run(1_000);
    expect(repository.queueNextSupervisorJobPage(3)).toBe(3);
    const first = repository.registerNextSupervisorJob()!;
    const second = repository.registerNextSupervisorJob()!;
    const changesBefore = driver
      .prepareState<[], { readonly changes: number }>(
        "SELECT total_changes() AS changes",
      )
      .get()!.changes;

    const claimed = repository.claimSupervisorOwnership();
    const changesAfter = driver
      .prepareState<[], { readonly changes: number }>(
        "SELECT total_changes() AS changes",
      )
      .get()!.changes;

    expect(changesAfter - changesBefore).toBe(1);
    expect(claimed).toMatchObject({
      epoch: first.supervisorEpoch + 1,
      registeredJobs: 0,
    });
    expect(repository.getSupervisorRegistration(first.jobId)).toMatchObject({
      substate: "registered",
      supervisorEpoch: first.supervisorEpoch,
      registrationGeneration: first.registrationGeneration,
    });
    const adopted = repository.registerNextSupervisorJob()!;
    expect(adopted).toMatchObject({
      jobId: first.jobId,
      substate: "registered",
      supervisorEpoch: claimed.epoch,
    });
    expect(adopted.registrationGeneration).not.toBe(
      first.registrationGeneration,
    );
    expect(repository.getSupervisorRegistration(second.jobId)).toMatchObject({
      supervisorEpoch: second.supervisorEpoch,
      registrationGeneration: second.registrationGeneration,
    });
    expect(repository.getSupervisorState().registeredJobs).toBe(1);
  });

  it("keyset-sweeps physical registration pages before eligibility filtering", () => {
    const { driver, repository } = openRepository();
    for (const jobId of [
      "sweep-a",
      "sweep-b",
      "sweep-c",
      "sweep-d",
      "sweep-e",
      "sweep-f",
    ]) {
      createJob(repository, jobId, 1);
    }
    driver
      .prepareState("UPDATE csv_agent_jobs SET created_at_ms = ?")
      .run(1_000);
    expect(repository.queueNextSupervisorJobPage(6)).toBe(6);
    driver
      .prepareState(
        `UPDATE csv_agent_jobs SET status = 'failed'
         WHERE id >= 'sweep-c'`,
      )
      .run();

    const changesBefore = driver
      .prepareState<[], { readonly changes: number }>(
        "SELECT total_changes() AS changes",
      )
      .get()!.changes;
    expect(repository.sweepNextInvalidSupervisorRegistrationPage(2)).toEqual({
      inspected: 2,
      invalidated: 0,
      scanComplete: false,
    });
    const changesAfterEligiblePage = driver
      .prepareState<[], { readonly changes: number }>(
        "SELECT total_changes() AS changes",
      )
      .get()!.changes;
    expect(changesAfterEligiblePage - changesBefore).toBe(1);
    expect(repository.getSupervisorState().cleanupCursor).toEqual({
      queueSequence: 2,
      jobId: "sweep-b",
    });
    const cleanupPlan = driver
      .prepareState<
        [number, number, string, number],
        { readonly detail: string }
      >(
        `EXPLAIN QUERY PLAN
         SELECT registration.job_id, registration.queue_sequence
         FROM csv_job_supervisor_registrations AS registration
           INDEXED BY idx_csv_job_supervisor_registration_physical_keyset
         LEFT JOIN csv_agent_jobs AS job ON job.id = registration.job_id
         WHERE registration.substate IN (
           'recovery_queued', 'registered', 'rotating'
         ) AND (
           registration.substate = 'recovery_queued'
           OR registration.supervisor_epoch <> ?
         ) AND (registration.queue_sequence, registration.job_id) > (?, ?)
         ORDER BY registration.queue_sequence ASC, registration.job_id ASC
         LIMIT ?`,
      )
      .all(repository.getSupervisorState().epoch, 2, "sweep-b", 2)
      .map((row) => row.detail)
      .join("\n");
    expect(cleanupPlan).toContain(
      "idx_csv_job_supervisor_registration_physical_keyset",
    );
    expect(cleanupPlan).not.toContain("USE TEMP B-TREE");

    expect(repository.sweepNextInvalidSupervisorRegistrationPage(2)).toEqual({
      inspected: 2,
      invalidated: 2,
      scanComplete: false,
    });
    expect(repository.sweepNextInvalidSupervisorRegistrationPage(2)).toEqual({
      inspected: 2,
      invalidated: 2,
      scanComplete: false,
    });
    expect(repository.sweepNextInvalidSupervisorRegistrationPage(2)).toEqual({
      inspected: 0,
      invalidated: 0,
      scanComplete: true,
    });
    expect(
      driver
        .prepareState<
          [],
          { readonly substate: string; readonly count: number }
        >(
          `SELECT substate, COUNT(*) AS count
           FROM csv_job_supervisor_registrations
           GROUP BY substate ORDER BY substate`,
        )
        .all(),
    ).toEqual([
      { substate: "done", count: 4 },
      { substate: "recovery_queued", count: 2 },
    ]);
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
  it("backfills scheduler counters for a populated pre-v21 database", () => {
    const legacy = new Database(":memory:");
    try {
      applyMigrations(
        legacy,
        STATE_DB_MIGRATIONS.filter((migration) => migration.version <= 16),
      );
      const recipe = JSON.parse(
        readFileSync(
          join(
            runtimeRootPath,
            "tests/fnd/fixtures/csv/legacy-v2-on-state-v16.sqlite-seed.json",
          ),
          "utf8",
        ),
      ) as {
        readonly statements: ReadonlyArray<{
          readonly sql: string;
          readonly params: ReadonlyArray<unknown>;
        }>;
      };
      for (const statement of recipe.statements) {
        legacy.prepare(statement.sql).run(...statement.params);
      }
      applyMigrations(
        legacy,
        STATE_DB_MIGRATIONS.filter((migration) => migration.version < 21),
      );

      applyMigrations(legacy, STATE_DB_MIGRATIONS);

      expect(
        legacy
          .prepare(
            `SELECT total_items, pending_items, running_items,
                    completed_items, unknown_outcome_items,
                    review_pending_items, available_results,
                    unavailable_after_review_results, not_produced_results,
                    counter_integrity_state
             FROM csv_agent_jobs WHERE id = 'legacy-csv-v2'`,
          )
          .get(),
      ).toEqual({
        total_items: 3,
        pending_items: 1,
        running_items: 0,
        completed_items: 1,
        unknown_outcome_items: 1,
        review_pending_items: 1,
        available_results: 1,
        unavailable_after_review_results: 0,
        not_produced_results: 2,
        counter_integrity_state: "unchecked",
      });
    } finally {
      legacy.close();
    }
  });

  it("backs up the v20 database before applying the additive v21 schema", () => {
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
    ).toBe(SET_BASED_CANCELLATION_SCHEMA_VERSION);
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
      ).toEqual({ version: 20 });
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
