import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import {
  link,
  lstat,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Event } from "../session/event-log.js";
import { RolloutStore } from "../session/rollout-store.js";
import {
  CSV_RECOVERY_CANDIDATE_PAGE_SIZE,
  CSV_RECOVERY_DEFERRED_PROCESS_IDENTITY_COARSE,
  CSV_RECOVERY_DEFERRED_PROCESS_IDENTITY_UNPROVEN,
  CSV_RECOVERY_DEFERRED_PROCESS_PROBE_UNAVAILABLE,
  CSV_RECOVERY_MAX_PROCESS_PROBES_PER_PASS,
  createCsvProcessIdentityProbe,
  CsvAgentJobsRepository,
  type CsvProcessIdentityProbe,
} from "./csv-agent-jobs.js";
import {
  createCsvOutputRootCapability,
  recoverCsvOutputIntents,
} from "../agents/jobs/csv-output.js";
import {
  canonicalizeCsvResult,
  compileCsvOutputSchema,
  validateCsvResultForPersistence,
} from "../agents/jobs/csv-schema.js";
import {
  CSV_MAX_DURABLE_BYTES,
  CSV_MAX_RESULT_BLOB_BYTES_GLOBAL,
  CSV_MAX_STAGING_ROWS_GLOBAL,
} from "../contracts/csv-job-contract.js";
import { createOperatorEffectReviewResolution } from "./effect-review.js";
import { StateRunDurabilityRepository } from "./run-durability.js";
import { openStateDatabases, type StateSqliteDriver } from "./sqlite-driver.js";

let home = "";
let cwd = "";
let originalAgencHome = "";
let driver: StateSqliteDriver;
let repo: CsvAgentJobsRepository;

function item(
  itemId: string,
  rowIndex: number,
  row: Record<string, unknown>,
  sourceId?: string,
) {
  const contentSha256 = createHash("sha256")
    .update(JSON.stringify(row))
    .digest("hex");
  return {
    itemId,
    rowIndex,
    ...(sourceId !== undefined ? { sourceId } : {}),
    contentSha256,
    workerName: `csv_row_${rowIndex}_${contentSha256.slice(0, 16)}`,
    row,
  };
}

function deadOwnerProbe(currentPid: number): CsvProcessIdentityProbe {
  return {
    current: { pid: currentPid },
    inspect() {
      return { kind: "dead" };
    },
  };
}

function seedUnknownEffect(runId: string): {
  readonly rolloutPath: string;
  readonly effect: {
    readonly runId: string;
    readonly stepId: string;
    readonly epoch: 1;
  };
} {
  const createStore = (resume: boolean) =>
    new RolloutStore({
      cwd,
      sessionId: runId,
      agencVersion: "0.13.0",
      autoStartScheduler: false,
      ...(resume ? { resume: true } : {}),
    });
  const original = createStore(false);
  original.open({
    sessionId: runId,
    timestamp: "2026-08-03T00:00:00.000Z",
    cwd,
    originator: "csv-review-test",
    agencVersion: "0.13.0",
  });
  const intent: Event = {
    eventId: `${runId}:intent`,
    id: `${runId}:intent`,
    seq: 1,
    msg: {
      type: "effect_intent",
      payload: {
        runId,
        stepId: "tool:turn-1:call-1",
        callId: "call-1",
        toolName: "csv_worker",
        recoveryCategory: "side-effecting",
        intentDigest: `${runId}:intent-digest`,
        attempt: 1,
        recordedAt: "2026-08-03T00:00:00.000Z",
      },
    },
  };
  expect(original.append(intent, { durable: true })).toBe(true);
  original.close();
  const recovered = createStore(true);
  recovered.open({
    sessionId: runId,
    timestamp: "2026-08-03T00:00:01.000Z",
    cwd,
    originator: "csv-review-test",
    agencVersion: "0.13.0",
  });
  const rolloutPath = recovered.rolloutPath;
  recovered.close();
  return {
    rolloutPath,
    effect: { runId, stepId: "tool:turn-1:call-1", epoch: 1 },
  };
}

function operatorCompletion(reviewedAt = "2026-08-03T00:01:00.000Z") {
  return createOperatorEffectReviewResolution({
    disposition: "confirmed_committed",
    actorId: "test-operator",
    evidenceRef: "ticket:csv-review",
    evidenceSha256: "a".repeat(64),
    reviewedAt,
  });
}

function operatorRetry(reviewedAt = "2026-08-03T00:01:00.000Z") {
  return createOperatorEffectReviewResolution({
    disposition: "confirmed_no_effect",
    actorId: "test-operator",
    evidenceRef: "ticket:csv-review",
    evidenceSha256: "a".repeat(64),
    reviewedAt,
  });
}

function operatorAbandon(reviewedAt = "2026-08-03T00:01:00.000Z") {
  return createOperatorEffectReviewResolution({
    disposition: "remains_unknown",
    actorId: "test-operator",
    evidenceRef: "ticket:csv-review",
    evidenceSha256: "a".repeat(64),
    reviewedAt,
  });
}

function terminalReviewEventCount(rolloutPath: string): number {
  return (
    readFileSync(rolloutPath, "utf8").match(/"type":"effect_review_resolved"/g)
      ?.length ?? 0
  );
}

function seedAdditionalPendingEffect(options: {
  readonly sessionId: string;
  readonly runId: string;
  readonly stepId: string;
  readonly callId?: string;
}): StateRunDurabilityRepository {
  const runs = new StateRunDurabilityRepository(driver);
  runs.ensureInitialEpoch({
    runId: options.runId,
    openedAt: "2026-08-03T00:00:00.000Z",
    openedEventId: `${options.runId}:opened`,
  });
  runs.beginEffect({
    runId: options.runId,
    epoch: 1,
    stepId: options.stepId,
    sessionId: options.sessionId,
    callId: options.callId ?? "call-1",
    toolName: "csv_worker",
    recoveryCategory: "side-effecting",
    intentDigest: `${options.runId}:intent-digest`,
    eventId: `${options.runId}:intent`,
    eventSequence: 1,
    intentAt: "2026-08-03T00:00:00.000Z",
  });
  runs.markEffectUnknown({
    runId: options.runId,
    stepId: options.stepId,
    eventId: `${options.runId}:unknown`,
    eventSequence: 2,
    reason: "ambiguous",
    observedAt: "2026-08-03T00:00:01.000Z",
  });
  return runs;
}

function prepareEffectBackedCsvReview(options: {
  readonly jobId: string;
  readonly runId: string;
  readonly outputSchema?: Record<string, unknown>;
  readonly maxResultBytes?: number;
  readonly maxResultBytesPerJob?: number;
}): ReturnType<typeof seedUnknownEffect> {
  const seeded = seedUnknownEffect(options.runId);
  repo.createJob(
    {
      id: options.jobId,
      name: options.jobId,
      instruction: "x",
      autoExport: false,
      inputHeaders: ["value"],
      inputCsvPath: "/in",
      outputCsvPath: "",
      ...(options.outputSchema !== undefined
        ? { outputSchema: options.outputSchema }
        : {}),
      ...(options.maxResultBytes !== undefined
        ? { maxResultBytes: options.maxResultBytes }
        : {}),
      ...(options.maxResultBytesPerJob !== undefined
        ? { maxResultBytesPerJob: options.maxResultBytesPerJob }
        : {}),
    },
    [item("row-a", 0, { value: "input" })],
  );
  repo.markJobRunning(options.jobId);
  repo.beginItemDispatch(options.jobId, "row-a", { effect: seeded.effect });
  repo.acknowledgeItemDispatch(options.jobId, "row-a", {});
  repo.markItemUnknownOutcome(options.jobId, "row-a", "ambiguous", {
    kind: "idempotency_lookup",
    reference: "lookup-1",
  });
  return seeded;
}

function seedExpiredStagedImport(
  id: string,
  ownerProcessStart: string | null,
): void {
  driver
    .prepareState(
      `INSERT INTO csv_agent_jobs (
         id, name, status, instruction, input_headers_json, input_csv_path,
         output_csv_path, auto_export, import_id, import_state,
         import_lease_owner, import_lease_expires_at, import_owner_pid,
         import_owner_boot_id, import_owner_process_start,
         import_lease_generation, execution_gate,
         requested_max_concurrency, identity_format_version, input_bytes,
         max_items, max_result_bytes, max_result_bytes_per_job,
         created_at, updated_at
       ) VALUES (
         ?, ?, 'pending', 'x', '["id"]', '/in', '', 0, ?, 'staging',
         'old-owner', 1, 4242, NULL, ?, 'old-generation', 'ready',
         16, 1, 0, 10, 1024, 4096, 1, 1
       )`,
    )
    .run(id, id, `${id}-import`, ownerProcessStart);
  driver
    .prepareState(
      `UPDATE csv_storage_quota SET active_imports = active_imports + 1
       WHERE singleton = 1`,
    )
    .run();
}

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
  it.each(["darwin", "win32"] as const)(
    "binds %s process liveness to an exact OS start token",
    async (platform) => {
      const missing = Object.assign(new Error("missing process"), {
        code: "ESRCH",
      });
      const probe = await createCsvProcessIdentityProbe({
        platform,
        pid: 41,
        signalProcess(pid) {
          if (pid === 41) return;
          throw missing;
        },
        inspectProcessStart(_platform, targetPid) {
          return `${platform}-start-${targetPid}`;
        },
      });

      expect(probe.current).toEqual({
        pid: 41,
        processStart:
          platform === "darwin"
            ? `darwin-lstart-seconds:${platform}-start-41`
            : `win32-creation-time:${platform}-start-41`,
      });
      await expect(probe.inspect(42)).resolves.toEqual({ kind: "dead" });

      const denied = await createCsvProcessIdentityProbe({
        platform,
        pid: 41,
        signalProcess(targetPid) {
          if (targetPid === 41) return;
          throw Object.assign(new Error("permission denied"), {
            code: "EPERM",
          });
        },
        inspectProcessStart(_platform, targetPid) {
          return `${platform}-start-${targetPid}`;
        },
      });
      await expect(denied.inspect(42)).resolves.toEqual({
        kind: "alive",
        processStart:
          platform === "darwin"
            ? `darwin-lstart-seconds:${platform}-start-42`
            : `win32-creation-time:${platform}-start-42`,
      });

      const unavailable = await createCsvProcessIdentityProbe({
        platform,
        pid: 41,
        signalProcess(targetPid) {
          if (targetPid === 41) return;
          throw Object.assign(new Error("probe unavailable"), { code: "EIO" });
        },
        inspectProcessStart() {
          return undefined;
        },
      });
      await expect(unavailable.inspect(42)).resolves.toEqual({
        kind: "unknown",
      });
    },
  );

  it.each(["darwin", "win32"] as const)(
    "detects PID reuse and fails permission-limited %s identity checks closed",
    async (platform) => {
      const reused = await createCsvProcessIdentityProbe({
        platform,
        pid: 41,
        signalProcess() {},
        inspectProcessStart(_platform, targetPid) {
          return targetPid === 41 ? "current-generation" : "reused-generation";
        },
      });
      await expect(reused.inspect(42)).resolves.toEqual({
        kind: "alive",
        processStart:
          platform === "darwin"
            ? "darwin-lstart-seconds:reused-generation"
            : "win32-creation-time:reused-generation",
      });

      const permissionLimited = await createCsvProcessIdentityProbe({
        platform,
        pid: 41,
        signalProcess(targetPid) {
          if (targetPid === 41) return;
          throw Object.assign(new Error("permission denied"), {
            code: "EPERM",
          });
        },
        inspectProcessStart(_platform, targetPid) {
          return targetPid === 41 ? "current-generation" : undefined;
        },
      });
      await expect(permissionLimited.inspect(42)).resolves.toEqual({
        kind: "unknown",
      });
    },
  );

  it("defers a same-second macOS start token as a typed coarse identity", async () => {
    seedExpiredStagedImport("darwin-same-second", "same-second-start");
    const probe = await createCsvProcessIdentityProbe({
      platform: "darwin",
      pid: 41,
      signalProcess() {},
      inspectProcessStart(_platform, targetPid) {
        return targetPid === 41 ? "current-start" : "same-second-start";
      },
    });

    await CsvAgentJobsRepository.open(driver, { processIdentityProbe: probe });

    expect(
      driver
        .prepareState<
          [string],
          { readonly import_state: string; readonly last_error: string | null }
        >("SELECT import_state, last_error FROM csv_agent_jobs WHERE id = ?")
        .get("darwin-same-second"),
    ).toEqual({
      import_state: "staging",
      last_error: CSV_RECOVERY_DEFERRED_PROCESS_IDENTITY_COARSE,
    });
  });

  it("bounds unavailable import probes and advances a fair recovery cursor", async () => {
    const candidateCount = CSV_RECOVERY_CANDIDATE_PAGE_SIZE + 5;
    for (let index = 0; index < candidateCount; index += 1) {
      seedExpiredStagedImport(
        `bounded-import-${String(index).padStart(2, "0")}`,
        "old-start",
      );
    }
    let inspectCalls = 0;
    const unavailableProbe: CsvProcessIdentityProbe = {
      current: { pid: 41, processStart: "current-start" },
      inspect() {
        inspectCalls += 1;
        return { kind: "unknown" };
      },
    };

    const recovering = new CsvAgentJobsRepository(driver, {
      processIdentityProbe: unavailableProbe,
    });
    const recovery = recovering.recoverAbandonedImports();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(inspectCalls).toBeLessThanOrEqual(
      CSV_RECOVERY_MAX_PROCESS_PROBES_PER_PASS,
    );
    await recovery;

    expect(
      driver
        .prepareState<[string, string], { readonly count: number }>(
          `SELECT COUNT(*) AS count FROM csv_agent_jobs
           WHERE id LIKE ? AND last_error = ?`,
        )
        .get(
          "bounded-import-%",
          CSV_RECOVERY_DEFERRED_PROCESS_PROBE_UNAVAILABLE,
        )?.count,
    ).toBe(candidateCount);
  });

  it("continues bounded import slices until a later proven-dead owner is reached", async () => {
    const candidateCount = CSV_RECOVERY_CANDIDATE_PAGE_SIZE + 5;
    const finalId = `continued-import-${String(candidateCount - 1).padStart(2, "0")}`;
    for (let index = 0; index < candidateCount; index += 1) {
      seedExpiredStagedImport(
        `continued-import-${String(index).padStart(2, "0")}`,
        "old-start",
      );
    }
    driver
      .prepareState(
        "UPDATE csv_agent_jobs SET import_owner_pid = 5252 WHERE id = ?",
      )
      .run(finalId);
    let inspectCalls = 0;
    const mixedProbe: CsvProcessIdentityProbe = {
      current: { pid: 41, processStart: "current-start" },
      inspect(pid) {
        inspectCalls += 1;
        return pid === 5252 ? { kind: "dead" } : { kind: "unknown" };
      },
    };

    const recovering = new CsvAgentJobsRepository(driver, {
      processIdentityProbe: mixedProbe,
    });
    const recovery = recovering.recoverAbandonedImports();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(inspectCalls).toBeLessThanOrEqual(
      CSV_RECOVERY_MAX_PROCESS_PROBES_PER_PASS,
    );
    await recovery;
    expect(
      driver
        .prepareState<[string], { readonly id: string }>(
          "SELECT id FROM csv_agent_jobs WHERE id = ?",
        )
        .get(finalId),
    ).toBeUndefined();
  });

  it("rechecks cancellation after an import owner probe ignores its signal", async () => {
    seedExpiredStagedImport("aborted-import-probe", "old-start");
    const controller = new AbortController();
    const reason = new Error("import recovery cancelled during owner probe");
    const ignoringProbe: CsvProcessIdentityProbe = {
      current: { pid: 41, processStart: "current-start" },
      inspect() {
        controller.abort(reason);
        return { kind: "dead" };
      },
    };
    const recovering = new CsvAgentJobsRepository(driver, {
      processIdentityProbe: ignoringProbe,
    });

    await expect(
      recovering.recoverAbandonedImports({ signal: controller.signal }),
    ).rejects.toBe(reason);

    expect(
      driver
        .prepareState<
          [string],
          { readonly import_state: string; readonly last_error: string | null }
        >(`SELECT import_state, last_error FROM csv_agent_jobs WHERE id = ?`)
        .get("aborted-import-probe"),
    ).toEqual({ import_state: "staging", last_error: null });
    expect(
      driver
        .prepareState<[], { readonly active_imports: number }>(
          `SELECT active_imports FROM csv_storage_quota WHERE singleton = 1`,
        )
        .get()?.active_imports,
    ).toBe(1);
  });

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
        item("item_0", 0, { id: "row1", value: "a" }),
        item("item_1", 1, { id: "row2", value: "b" }),
      ],
    );
    expect(job.id).toBe("job-1");
    expect(job.status).toBe("pending");
    expect(job.inputHeaders).toEqual(["id", "value"]);
    const items = repo.listItems({ jobId: "job-1" });
    expect(items).toHaveLength(2);
    expect(items[0]!.status).toBe("pending");
    expect(items[1]!.sourceId).toBeUndefined();
    expect(job.importState).toBe("visible");
    expect(job.importId).not.toBe("");
    expect(job.requestedMaxConcurrency).toBe(16);
  });

  it("persists the concurrency contract and rejects values above its cap", () => {
    const job = repo.createJob(
      {
        id: "concurrency",
        name: "concurrency",
        instruction: "x",
        autoExport: false,
        inputHeaders: ["value"],
        inputCsvPath: "/in",
        outputCsvPath: "",
        requestedMaxConcurrency: 64,
      },
      [item("opaque", 0, { value: "x" })],
    );
    expect(job.requestedMaxConcurrency).toBe(64);
    expect(repo.getJob("concurrency")?.requestedMaxConcurrency).toBe(64);
    expect(() =>
      repo.beginJobImport({
        id: "too-wide",
        name: "too-wide",
        instruction: "x",
        autoExport: false,
        inputHeaders: ["value"],
        inputCsvPath: "/in",
        outputCsvPath: "",
        requestedMaxConcurrency: 65,
      }),
    ).toThrow(/between 1 and 64/u);
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
      [item("i0", 0, { id: "r" })],
    );
    repo.markJobRunning("j");
    expect(repo.getJob("j")?.status).toBe("running");
    expect(repo.getJob("j")?.startedAt).toBeGreaterThan(0);
    repo.markItemRunning("j", "i0");
    repo.markItemCompleted("j", "i0", { ok: true });
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
      [item("i0", 0, { id: "r" })],
    );
    repo.markItemRunningWithThread("j", "i0", "thread-7");
    let storedItem = repo.getItem("j", "i0")!;
    expect(storedItem.status).toBe("running");
    expect(storedItem.assignedThreadId).toBe("thread-7");
    expect(storedItem.attemptCount).toBe(1);

    repo.markItemCompleted("j", "i0", { score: 0.9, label: "ok" });
    storedItem = repo.getItem("j", "i0")!;
    expect(storedItem.status).toBe("completed");
    expect(storedItem.result).toEqual({ score: 0.9, label: "ok" });
    expect(storedItem.reportedAt).toBeGreaterThan(0);
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
      [item("a", 0, {}), item("b", 1, {}), item("c", 2, {})],
    );
    repo.markItemRunning("p", "a");
    repo.markItemRunning("p", "b");
    repo.markItemCompleted("p", "b", { ok: true });
    const progress = repo.getJobProgress("p");
    expect(progress.totalItems).toBe(3);
    expect(progress.pendingItems).toBe(1);
    expect(progress.runningItems).toBe(1);
    expect(progress.completedItems).toBe(1);
    expect(progress.failedItems).toBe(0);
  });

  it("tombstones a retired job before bounded payload deletion", () => {
    repo.createJob(
      {
        id: "g",
        name: "g",
        instruction: "x",
        autoExport: false,
        inputHeaders: ["value"],
        inputCsvPath: "/in",
        outputCsvPath: "",
      },
      [item("x", 0, {})],
    );
    expect(repo.listItems({ jobId: "g" })).toHaveLength(1);
    expect(() => repo.deleteJob("g")).toThrow(/retired/);
    repo.markItemCancelled("g", "x", "test retirement");
    repo.refreshJobOutcome("g");
    repo.retireJob("g");
    repo.deleteJob("g");
    expect(repo.getJob("g")).toBeNull();
    expect(repo.listItems({ jobId: "g" })).toHaveLength(0);
    expect(
      driver
        .prepareState<[string], { readonly final_status: string }>(
          "SELECT final_status FROM csv_job_tombstones WHERE job_id = ?",
        )
        .get("g")?.final_status,
    ).toBe("cancelled");
  });

  it("listJobs filters by status and orders by updated_at DESC", async () => {
    repo.createJob(
      {
        id: "older",
        name: "older",
        instruction: "x",
        autoExport: false,
        inputHeaders: ["value"],
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
        inputHeaders: ["value"],
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

  it("keeps live staging imports invisible and never expires them by wall time", () => {
    const handle = repo.beginJobImport({
      id: "staged",
      name: "staged",
      instruction: "x",
      autoExport: false,
      inputHeaders: ["id"],
      inputCsvPath: "/in",
      outputCsvPath: "",
      importId: "unguessable-import",
      maxItems: 10,
      maxResultBytes: 1_024,
      maxResultBytesPerJob: 4_096,
    });
    repo.appendJobImportItems(handle, [item("opaque", 0, { id: "one" })]);

    expect(repo.getJob("staged")).toBeNull();
    expect(repo.listJobs()).toEqual([]);
    expect(repo.cleanupExpiredStagedImport("other-import", 10)).toBe(false);
    expect(repo.cleanupExpiredStagedImport("unguessable-import", 10)).toBe(
      false,
    );
    repo.abortJobImport(handle, "test cleanup");
    repo.deleteAbortedImport(handle);
    expect(
      driver
        .prepareState<[string], { readonly count: number }>(
          "SELECT COUNT(*) AS count FROM csv_agent_jobs WHERE import_id = ?",
        )
        .get("unguessable-import")?.count,
    ).toBe(0);
  });

  it("serves keyset pages without rows/results and chunks result blobs by bytes", () => {
    const rows = Array.from({ length: 205 }, (_, rowIndex) =>
      item(`opaque-${rowIndex}`, rowIndex, { value: `row-${rowIndex}` }),
    );
    repo.createJob(
      {
        id: "paged",
        name: "paged",
        instruction: "x",
        autoExport: false,
        inputHeaders: ["value"],
        inputCsvPath: "/in",
        outputCsvPath: "",
      },
      rows,
    );
    repo.markItemRunning("paged", "opaque-0");
    repo.markItemCompleted("paged", "opaque-0", {
      message: "snowman ☃ survives byte paging",
    });

    const first = repo.listItemsPage({ jobId: "paged", limit: 500 });
    expect(first.items).toHaveLength(100);
    expect(first.nextCursor).toMatch(/^agenc-csv-items-v1:/u);
    expect(first.items[0]).not.toHaveProperty("row");
    expect(first.items[0]).not.toHaveProperty("result");
    const second = repo.listItemsPage({
      jobId: "paged",
      cursor: first.nextCursor,
      limit: 100,
    });
    expect(second.items.map((entry) => entry.rowIndex)).toEqual([
      ...Array.from({ length: 100 }, (_, index) => index + 100),
    ]);
    expect(second.nextCursor).toMatch(/^agenc-csv-items-v1:/u);
    expect(() =>
      repo.listItemsPage({
        jobId: "paged",
        cursor: `${first.nextCursor}forged`,
      }),
    ).toThrow(/invalid or stale CSV item page cursor/u);

    const pending = repo.listItemsPage({
      jobId: "paged",
      status: "pending",
      limit: 1,
    });
    expect(pending.nextCursor).toBeDefined();
    repo.markItemRunning("paged", pending.items[0]!.itemId);
    expect(() =>
      repo.listItemsPage({
        jobId: "paged",
        status: "pending",
        cursor: pending.nextCursor,
      }),
    ).toThrow(/invalid or stale CSV item page cursor/u);
    expect(() =>
      repo.listItemsPage({
        jobId: "paged",
        status: "completed",
        cursor: pending.nextCursor,
      }),
    ).toThrow(/invalid or stale CSV item page cursor/u);

    const chunks: Buffer[] = [];
    let byteOffset = 0;
    for (;;) {
      const chunk = repo.readResultBlob({
        jobId: "paged",
        itemId: "opaque-0",
        byteOffset,
        maxBytes: 5,
      })!;
      chunks.push(Buffer.from(chunk.dataBase64, "base64"));
      if (chunk.nextByteOffset === undefined) break;
      byteOffset = chunk.nextByteOffset;
    }
    expect(JSON.parse(Buffer.concat(chunks).toString("utf8"))).toEqual({
      message: "snowman ☃ survives byte paging",
    });
  });

  it("fenced output recovery removes only exact temporaries and finalizes a published inode", async () => {
    repo.createJob(
      {
        id: "output-recovery",
        name: "output-recovery",
        instruction: "x",
        autoExport: false,
        inputHeaders: ["value"],
        inputCsvPath: "/in",
        outputCsvPath: "",
      },
      [item("output-item", 0, { value: "one" })],
    );
    const capability = createCsvOutputRootCapability(cwd);
    const abandonedTemporary = join(
      cwd,
      ".output-recovery.abandoned.agenc-csv.tmp",
    );
    const abandonedTarget = join(cwd, "abandoned.csv");
    await writeFile(abandonedTemporary, "partial", { mode: 0o600 });
    const abandonedStats = await lstat(abandonedTemporary, { bigint: true });
    const abandonedIntent = repo.beginCsvOutputIntent({
      jobId: "output-recovery",
      rootPath: cwd,
      targetPath: abandonedTarget,
      temporaryPath: abandonedTemporary,
      temporaryDev: abandonedStats.dev.toString(),
      temporaryIno: abandonedStats.ino.toString(),
      reservedBytes: 128,
    });
    repo.abandonCsvOutputIntent(abandonedIntent, true);

    expect(await recoverCsvOutputIntents(capability, repo)).toEqual({
      recovered: 1,
      deferred: 0,
    });
    await expect(readFile(abandonedTemporary)).rejects.toMatchObject({
      code: "ENOENT",
    });

    const publishedTemporary = join(
      cwd,
      ".output-recovery.published.agenc-csv.tmp",
    );
    const publishedTarget = join(cwd, "published.csv");
    const publishedBody = "value\none\n";
    await writeFile(publishedTemporary, publishedBody, { mode: 0o600 });
    const publishedStats = await lstat(publishedTemporary, { bigint: true });
    const publishedIntent = repo.beginCsvOutputIntent({
      jobId: "output-recovery",
      rootPath: cwd,
      targetPath: publishedTarget,
      temporaryPath: publishedTemporary,
      temporaryDev: publishedStats.dev.toString(),
      temporaryIno: publishedStats.ino.toString(),
      reservedBytes: 128,
    });
    repo.markCsvOutputIntentFlushed(publishedIntent);
    await rename(publishedTemporary, publishedTarget);
    repo.markCsvOutputIntentPublished(publishedIntent);
    repo.abandonCsvOutputIntent(publishedIntent, true);

    expect(await recoverCsvOutputIntents(capability, repo)).toEqual({
      recovered: 1,
      deferred: 0,
    });
    expect(await readFile(publishedTarget, "utf8")).toBe(publishedBody);
    expect(repo.getJob("output-recovery")?.outputDigest).toBe(
      createHash("sha256").update(publishedBody).digest("hex"),
    );
    expect(
      driver
        .prepareState<[], { readonly count: number }>(
          "SELECT COUNT(*) AS count FROM csv_output_intents",
        )
        .get()?.count,
    ).toBe(0);
  });

  it("retains an output intent instead of unlinking a replaced temporary", async () => {
    repo.createJob(
      {
        id: "output-recovery-race",
        name: "output-recovery-race",
        instruction: "x",
        autoExport: false,
        inputHeaders: ["value"],
        inputCsvPath: "/in",
        outputCsvPath: "",
      },
      [item("output-race-item", 0, { value: "one" })],
    );
    const capability = createCsvOutputRootCapability(cwd);
    const temporary = join(cwd, ".output-race.changed.agenc-csv.tmp");
    const target = join(cwd, "changed.csv");
    await writeFile(temporary, "owned", { mode: 0o600 });
    const recorded = await lstat(temporary, { bigint: true });
    const intentId = repo.beginCsvOutputIntent({
      jobId: "output-recovery-race",
      rootPath: cwd,
      targetPath: target,
      temporaryPath: temporary,
      temporaryDev: recorded.dev.toString(),
      temporaryIno: recorded.ino.toString(),
      reservedBytes: 64,
    });
    repo.abandonCsvOutputIntent(intentId, true);
    await unlink(temporary);
    await writeFile(temporary, "unrelated", { mode: 0o600 });

    expect(await recoverCsvOutputIntents(capability, repo)).toEqual({
      recovered: 0,
      deferred: 1,
    });
    expect(await readFile(temporary, "utf8")).toBe("unrelated");
    expect(
      driver
        .prepareState<[], { readonly count: number }>(
          "SELECT COUNT(*) AS count FROM csv_output_intents",
        )
        .get()?.count,
    ).toBe(1);
  });

  it("retains recovery evidence when a published target inode changes", async () => {
    repo.createJob(
      {
        id: "output-published-race",
        name: "output-published-race",
        instruction: "x",
        autoExport: false,
        inputHeaders: ["value"],
        inputCsvPath: "/in",
        outputCsvPath: "",
      },
      [item("output-published-item", 0, { value: "one" })],
    );
    const capability = createCsvOutputRootCapability(cwd);
    const temporary = join(cwd, ".output-published.changed.agenc-csv.tmp");
    const target = join(cwd, "published-changed.csv");
    const displaced = join(cwd, "published-displaced.csv");
    await writeFile(temporary, "owned\n", { mode: 0o600 });
    const recorded = await lstat(temporary, { bigint: true });
    const intentId = repo.beginCsvOutputIntent({
      jobId: "output-published-race",
      rootPath: cwd,
      targetPath: target,
      temporaryPath: temporary,
      temporaryDev: recorded.dev.toString(),
      temporaryIno: recorded.ino.toString(),
      reservedBytes: 64,
    });
    repo.markCsvOutputIntentFlushed(intentId);
    await rename(temporary, target);
    repo.markCsvOutputIntentPublished(intentId);
    repo.abandonCsvOutputIntent(intentId, true);
    await rename(target, displaced);
    await writeFile(target, "unrelated\n", { mode: 0o600 });

    expect(await recoverCsvOutputIntents(capability, repo)).toEqual({
      recovered: 0,
      deferred: 1,
    });
    expect(await readFile(target, "utf8")).toBe("unrelated\n");
    expect(await readFile(displaced, "utf8")).toBe("owned\n");
    expect(repo.getJob("output-published-race")?.outputDigest).toBeUndefined();
    expect(
      driver
        .prepareState<[], { readonly count: number }>(
          "SELECT COUNT(*) AS count FROM csv_output_intents",
        )
        .get()?.count,
    ).toBe(1);
  });

  it("retains the last known inode when create-new publication is displaced", async () => {
    repo.createJob(
      {
        id: "output-linked-race",
        name: "output-linked-race",
        instruction: "x",
        autoExport: false,
        inputHeaders: ["value"],
        inputCsvPath: "/in",
        outputCsvPath: "",
      },
      [item("output-linked-item", 0, { value: "one" })],
    );
    const capability = createCsvOutputRootCapability(cwd);
    const temporary = join(cwd, ".output-linked.changed.agenc-csv.tmp");
    const target = join(cwd, "linked-changed.csv");
    await writeFile(temporary, "owned\n", { mode: 0o600 });
    const recorded = await lstat(temporary, { bigint: true });
    const intentId = repo.beginCsvOutputIntent({
      jobId: "output-linked-race",
      rootPath: cwd,
      targetPath: target,
      temporaryPath: temporary,
      temporaryDev: recorded.dev.toString(),
      temporaryIno: recorded.ino.toString(),
      reservedBytes: 64,
    });
    repo.markCsvOutputIntentFlushed(intentId);
    await link(temporary, target);
    repo.markCsvOutputIntentPublished(intentId);
    repo.abandonCsvOutputIntent(intentId, true);
    await unlink(target);
    await writeFile(target, "unrelated\n", { mode: 0o600 });

    expect(await recoverCsvOutputIntents(capability, repo)).toEqual({
      recovered: 0,
      deferred: 1,
    });
    expect(await readFile(temporary, "utf8")).toBe("owned\n");
    expect(await readFile(target, "utf8")).toBe("unrelated\n");
    expect(repo.getJob("output-linked-race")?.outputDigest).toBeUndefined();
    expect(
      driver
        .prepareState<[], { readonly count: number }>(
          "SELECT COUNT(*) AS count FROM csv_output_intents",
        )
        .get()?.count,
    ).toBe(1);
  });

  it("holds ambiguous outcomes for evidence-backed review and abandons terminally", async () => {
    repo.createJob(
      {
        id: "review",
        name: "review",
        instruction: "x",
        autoExport: false,
        inputHeaders: ["value"],
        inputCsvPath: "/in",
        outputCsvPath: "",
      },
      [item("opaque", 0, { value: "x" })],
    );
    repo.markJobRunning("review");
    repo.beginItemDispatch("review", "opaque", {});
    repo.acknowledgeItemDispatch("review", "opaque", {
      threadId: "lost-thread",
    });
    repo.markItemUnknownOutcome(
      "review",
      "opaque",
      "restart_dispatch_ambiguous",
    );

    expect(repo.getJob("review")?.status).toBe("needs_review");
    expect(repo.getItem("review", "opaque")).toMatchObject({
      status: "unknown_outcome",
      reviewStatus: "pending",
      reviewReason: "restart_dispatch_ambiguous",
    });
    await expect(
      repo.resolveUnknownOutcome({
        jobId: "review",
        itemId: "opaque",
        disposition: "remains_unknown",
        domainAction: "abandon_item",
        evidence: { kind: "operator_evidence", reference: "ticket-1" },
        actor: "test-operator",
        reason: "authoritative review remains unknown",
        effectReview: {
          version: 1,
          kind: "effect_review_resolution",
          disposition: "remains_unknown",
          actorKind: "operator",
          actorId: "test-operator",
          evidenceKind: "operator_evidence",
          evidenceRef: "ticket-1",
          evidenceSha256: "0".repeat(64),
          reviewedAt: new Date().toISOString(),
          workflowStatus: "abandoned",
          domainAction: "abandon_item",
        },
      }),
    ).rejects.toThrow(/no canonical effect identity/u);
    await repo.resolveUnknownOutcome({
      jobId: "review",
      itemId: "opaque",
      disposition: "remains_unknown",
      domainAction: "abandon_item",
      evidence: { kind: "operator_evidence", reference: "ticket-1" },
      actor: "test-operator",
      reason: "authoritative review remains unknown",
    });
    expect(repo.getJob("review")?.status).toBe(
      "finished_with_unknown_outcomes",
    );
    expect(repo.getItem("review", "opaque")).toMatchObject({
      status: "unknown_outcome",
      reviewStatus: "abandoned",
      reviewDomainAction: "abandon_item",
    });
    expect(() =>
      driver
        .prepareState(
          `UPDATE csv_agent_job_items
           SET status = 'completed',
               result_availability = 'unavailable_after_review'
           WHERE job_id = 'review' AND item_id = 'opaque'`,
        )
        .run(),
    ).toThrow();
  });

  it("keeps runnable work ahead of review and failed ahead of cancelled", () => {
    repo.createJob(
      {
        id: "precedence",
        name: "precedence",
        instruction: "x",
        autoExport: false,
        inputHeaders: ["value"],
        inputCsvPath: "/in",
        outputCsvPath: "",
      },
      [item("ambiguous", 0, { value: "a" }), item("queued", 1, { value: "b" })],
    );
    repo.markJobRunning("precedence");
    repo.beginItemDispatch("precedence", "ambiguous", {});
    repo.acknowledgeItemDispatch("precedence", "ambiguous", {
      threadId: "lost-thread",
    });
    repo.markItemUnknownOutcome("precedence", "ambiguous", "ambiguous");
    expect(repo.getJob("precedence")?.status).toBe("running");
    repo.markItemCancelled("precedence", "queued", "cancelled");
    expect(repo.refreshJobOutcome("precedence")).toBe("needs_review");

    repo.createJob(
      {
        id: "terminal-precedence",
        name: "terminal-precedence",
        instruction: "x",
        autoExport: false,
        inputHeaders: ["value"],
        inputCsvPath: "/in",
        outputCsvPath: "",
      },
      [item("failed", 0, { value: "a" }), item("cancelled", 1, { value: "b" })],
    );
    repo.markItemFailed("terminal-precedence", "failed", "failed");
    repo.markItemCancelled("terminal-precedence", "cancelled", "cancelled");
    expect(repo.refreshJobOutcome("terminal-precedence")).toBe("failed");
  });

  it("refuses to advance a CSV review when its canonical effect is missing", async () => {
    repo.createJob(
      {
        id: "missing-effect",
        name: "missing-effect",
        instruction: "x",
        autoExport: false,
        inputHeaders: ["value"],
        inputCsvPath: "/in",
        outputCsvPath: "",
      },
      [item("opaque", 0, { value: "x" })],
    );
    repo.beginItemDispatch("missing-effect", "opaque", {
      effect: { runId: "missing-run", stepId: "missing-step", epoch: 1 },
    });
    repo.acknowledgeItemDispatch("missing-effect", "opaque", {});
    repo.markItemUnknownOutcome("missing-effect", "opaque", "ambiguous");
    await expect(
      repo.resolveUnknownOutcome({
        jobId: "missing-effect",
        itemId: "opaque",
        disposition: "remains_unknown",
        domainAction: "abandon_item",
        evidence: { reference: "ticket-2" },
        actor: "test-operator",
        reason: "abandon",
        effectReview: {
          version: 1,
          kind: "effect_review_resolution",
          disposition: "remains_unknown",
          actorKind: "operator",
          actorId: "test-operator",
          evidenceKind: "operator_evidence",
          evidenceRef: "ticket-2",
          evidenceSha256: "1".repeat(64),
          reviewedAt: new Date().toISOString(),
          workflowStatus: "abandoned",
          domainAction: "abandon_item",
        },
      }),
    ).rejects.toThrow(/missing or stale/u);
    expect(repo.getItem("missing-effect", "opaque")).toMatchObject({
      status: "unknown_outcome",
      reviewStatus: "pending",
    });
  });

  it("persists one validated result with canonical review and separate lookup evidence", async () => {
    const jobId = "canonical-review-result";
    const seeded = prepareEffectBackedCsvReview({
      jobId,
      runId: "run-canonical-review-result",
      outputSchema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
    });
    const effectReview = operatorCompletion();

    await repo.resolveUnknownOutcome({
      jobId,
      itemId: "row-a",
      disposition: "confirmed_committed",
      domainAction: "mark_completed",
      evidence: { reference: "requested-review" },
      actor: "test-operator",
      reason: "confirmed",
      effectReview,
      result: { value: "complete" },
    });

    expect(repo.getItem(jobId, "row-a")).toMatchObject({
      status: "completed",
      result: { value: "complete" },
      reviewStatus: "resolved",
      reviewEvidence: effectReview,
      lookupEvidence: {
        kind: "idempotency_lookup",
        reference: "lookup-1",
      },
    });
    expect(terminalReviewEventCount(seeded.rolloutPath)).toBe(1);
    const history = driver
      .prepareState<
        [string, string],
        { readonly review_status: string; readonly evidence_json: string }
      >(
        `SELECT review_status, evidence_json
         FROM csv_agent_job_review_history
         WHERE job_id = ? AND item_id = ? ORDER BY sequence ASC`,
      )
      .all(jobId, "row-a");
    expect(history.map((row) => row.review_status)).toEqual([
      "pending",
      "resolved",
    ]);
    expect(JSON.parse(history[0]!.evidence_json)).toEqual({
      kind: "idempotency_lookup",
      reference: "lookup-1",
    });
    expect(JSON.parse(history[1]!.evidence_json)).toEqual(effectReview);
  });

  it("reuses the first canonical effect review after CSV projection failure", async () => {
    const jobId = "review-projection-retry";
    const seeded = prepareEffectBackedCsvReview({
      jobId,
      runId: "run-review-projection-retry",
    });
    const firstReview = operatorCompletion("2026-08-03T00:01:00.000Z");
    driver
      .prepareState(
        `CREATE TRIGGER test_abort_csv_review_projection
         BEFORE UPDATE ON csv_agent_job_items
         WHEN OLD.review_status = 'pending' AND NEW.review_status = 'resolved'
         BEGIN
           SELECT RAISE(ABORT, 'simulated CSV review projection failure');
         END`,
      )
      .run();
    await expect(
      repo.resolveUnknownOutcome({
        jobId,
        itemId: "row-a",
        disposition: "confirmed_committed",
        domainAction: "mark_completed",
        evidence: { reference: "first-request" },
        actor: "test-operator",
        reason: "confirmed",
        effectReview: firstReview,
      }),
    ).rejects.toThrow(/simulated CSV review projection failure/u);
    expect(terminalReviewEventCount(seeded.rolloutPath)).toBe(1);
    expect(repo.getItem(jobId, "row-a")).toMatchObject({
      status: "unknown_outcome",
      reviewStatus: "pending",
    });
    driver.prepareState("DROP TRIGGER test_abort_csv_review_projection").run();

    await repo.resolveUnknownOutcome({
      jobId,
      itemId: "row-a",
      disposition: "confirmed_committed",
      domainAction: "mark_completed",
      evidence: { reference: "second-request" },
      actor: "test-operator",
      reason: "confirmed",
      effectReview: operatorCompletion("2026-08-03T00:02:00.000Z"),
    });
    expect(terminalReviewEventCount(seeded.rolloutPath)).toBe(1);
    expect(repo.getItem(jobId, "row-a")).toMatchObject({
      status: "completed",
      resultAvailability: "unavailable_after_review",
      reviewEvidence: firstReview,
      lookupEvidence: {
        kind: "idempotency_lookup",
        reference: "lookup-1",
      },
    });
    const resolvedEvidence = driver
      .prepareState<[string, string], { readonly evidence_json: string }>(
        `SELECT evidence_json FROM csv_agent_job_review_history
         WHERE job_id = ? AND item_id = ? AND review_status = 'resolved'`,
      )
      .get(jobId, "row-a")!.evidence_json;
    expect(JSON.parse(resolvedEvidence)).toEqual(firstReview);
  });

  it.each([
    {
      name: "retry",
      disposition: "confirmed_no_effect" as const,
      domainAction: "retry_new_attempt" as const,
      reviewStatus: "resolved" as const,
      firstReview: operatorRetry("2026-08-03T00:01:00.000Z"),
      laterReview: operatorRetry("2026-08-03T00:02:00.000Z"),
      expected: { status: "pending", reviewStatus: "resolved" },
    },
    {
      name: "abandon",
      disposition: "remains_unknown" as const,
      domainAction: "abandon_item" as const,
      reviewStatus: "abandoned" as const,
      firstReview: operatorAbandon("2026-08-03T00:01:00.000Z"),
      laterReview: operatorAbandon("2026-08-03T00:02:00.000Z"),
      expected: { status: "unknown_outcome", reviewStatus: "abandoned" },
    },
  ])(
    "reuses the first canonical $name review after projection failure",
    async ({
      name,
      disposition,
      domainAction,
      reviewStatus,
      firstReview,
      laterReview,
      expected,
    }) => {
      const jobId = `review-projection-${name}`;
      const seeded = prepareEffectBackedCsvReview({
        jobId,
        runId: `run-review-projection-${name}`,
      });
      driver
        .prepareState(
          `CREATE TRIGGER test_abort_csv_${name}_projection
           BEFORE UPDATE ON csv_agent_job_items
           WHEN OLD.review_status = 'pending'
             AND NEW.review_status = '${reviewStatus}'
           BEGIN
             SELECT RAISE(ABORT, 'simulated CSV ${name} projection failure');
           END`,
        )
        .run();
      await expect(
        repo.resolveUnknownOutcome({
          jobId,
          itemId: "row-a",
          disposition,
          domainAction,
          evidence: { reference: "first-request" },
          actor: "test-operator",
          reason: name,
          effectReview: firstReview,
        }),
      ).rejects.toThrow(
        new RegExp(`simulated CSV ${name} projection failure`, "u"),
      );
      expect(terminalReviewEventCount(seeded.rolloutPath)).toBe(1);
      expect(repo.getItem(jobId, "row-a")).toMatchObject({
        status: "unknown_outcome",
        reviewStatus: "pending",
      });
      driver
        .prepareState(`DROP TRIGGER test_abort_csv_${name}_projection`)
        .run();

      await repo.resolveUnknownOutcome({
        jobId,
        itemId: "row-a",
        disposition,
        domainAction,
        evidence: { reference: "second-request" },
        actor: "test-operator",
        reason: name,
        effectReview: laterReview,
      });
      expect(terminalReviewEventCount(seeded.rolloutPath)).toBe(1);
      expect(repo.getItem(jobId, "row-a")).toMatchObject({
        ...expected,
        reviewEvidence: firstReview,
        lookupEvidence: {
          kind: "idempotency_lookup",
          reference: "lookup-1",
        },
      });
      const evidenceJson = driver
        .prepareState<
          [string, string, string],
          { readonly evidence_json: string }
        >(
          `SELECT evidence_json FROM csv_agent_job_review_history
           WHERE job_id = ? AND item_id = ? AND review_status = ?`,
        )
        .get(jobId, "row-a", reviewStatus)!.evidence_json;
      expect(JSON.parse(evidenceJson)).toEqual(firstReview);
    },
  );

  it("rejects ignored results and supports effectless result omission", async () => {
    repo.createJob(
      {
        id: "effectless-result-contract",
        name: "effectless-result-contract",
        instruction: "x",
        autoExport: false,
        inputHeaders: ["value"],
        inputCsvPath: "/in",
        outputCsvPath: "",
      },
      [item("row-a", 0, { value: "input" })],
    );
    repo.markItemRunning("effectless-result-contract", "row-a");
    repo.markItemUnknownOutcome(
      "effectless-result-contract",
      "row-a",
      "ambiguous",
    );
    await expect(
      repo.resolveUnknownOutcome({
        jobId: "effectless-result-contract",
        itemId: "row-a",
        disposition: "confirmed_no_effect",
        domainAction: "retry_new_attempt",
        evidence: { reference: "retry" },
        actor: "test-operator",
        reason: "retry",
        result: { ignored: true },
      }),
    ).rejects.toThrow(/only valid for confirmed committed completion/u);
    await repo.resolveUnknownOutcome({
      jobId: "effectless-result-contract",
      itemId: "row-a",
      disposition: "confirmed_committed",
      domainAction: "mark_completed",
      evidence: { reference: "legacy-review" },
      actor: "test-operator",
      reason: "confirmed without recoverable result",
    });
    expect(repo.getItem("effectless-result-contract", "row-a")).toMatchObject({
      status: "completed",
      resultAvailability: "unavailable_after_review",
      reviewEvidence: { reference: "legacy-review" },
    });
  });

  it("rejects reservation corruption before appending a review", async () => {
    const jobId = "review-accounting-corruption";
    const seeded = prepareEffectBackedCsvReview({
      jobId,
      runId: "run-review-accounting-corruption",
    });
    driver
      .prepareState(
        "UPDATE csv_agent_jobs SET result_reserved_bytes = 0 WHERE id = ?",
      )
      .run(jobId);
    const rolloutBefore = readFileSync(seeded.rolloutPath, "utf8");
    await expect(
      repo.resolveUnknownOutcome({
        jobId,
        itemId: "row-a",
        disposition: "confirmed_committed",
        domainAction: "mark_completed",
        evidence: { reference: "review" },
        actor: "test-operator",
        reason: "confirmed",
        effectReview: operatorCompletion(),
      }),
    ).rejects.toThrow(/reservation accounting is inconsistent/u);
    expect(readFileSync(seeded.rolloutPath, "utf8")).toBe(rolloutBefore);
    expect(terminalReviewEventCount(seeded.rolloutPath)).toBe(0);
    expect(repo.getItem(jobId, "row-a")).toMatchObject({
      status: "unknown_outcome",
      reviewStatus: "pending",
    });
  });

  it.each([
    {
      name: "result completion",
      disposition: "confirmed_committed" as const,
      domainAction: "mark_completed" as const,
      effectReview: operatorCompletion(),
      result: { value: "complete" },
    },
    {
      name: "resultless completion",
      disposition: "confirmed_committed" as const,
      domainAction: "mark_completed" as const,
      effectReview: operatorCompletion(),
    },
    {
      name: "retry",
      disposition: "confirmed_no_effect" as const,
      domainAction: "retry_new_attempt" as const,
      effectReview: operatorRetry(),
    },
  ])(
    "rejects corrupt status counters before A1 for $name",
    async ({ name, disposition, domainAction, effectReview, result }) => {
      const jobId = `counter-${name.replaceAll(" ", "-")}`;
      const seeded = prepareEffectBackedCsvReview({
        jobId,
        runId: `run-${jobId}`,
      });
      driver
        .prepareState(
          "UPDATE csv_agent_jobs SET unknown_outcome_items = 0 WHERE id = ?",
        )
        .run(jobId);
      const itemBefore = repo.getItem(jobId, "row-a");
      const jobBefore = repo.getJob(jobId);
      const rolloutBefore = readFileSync(seeded.rolloutPath, "utf8");
      const historyBefore = driver
        .prepareState<[string, string], { readonly count: number }>(
          `SELECT COUNT(*) AS count FROM csv_agent_job_review_history
           WHERE job_id = ? AND item_id = ?`,
        )
        .get(jobId, "row-a")!.count;
      await expect(
        repo.resolveUnknownOutcome({
          jobId,
          itemId: "row-a",
          disposition,
          domainAction,
          evidence: { reference: "review" },
          actor: "test-operator",
          reason: "confirmed",
          effectReview,
          ...(result !== undefined ? { result } : {}),
        }),
      ).rejects.toThrow(/status accounting is inconsistent/u);
      expect(readFileSync(seeded.rolloutPath, "utf8")).toBe(rolloutBefore);
      expect(repo.getItem(jobId, "row-a")).toEqual(itemBefore);
      expect(repo.getJob(jobId)).toEqual(jobBefore);
      expect(
        driver
          .prepareState<[string, string], { readonly count: number }>(
            `SELECT COUNT(*) AS count FROM csv_agent_job_review_history
             WHERE job_id = ? AND item_id = ?`,
          )
          .get(jobId, "row-a")!.count,
      ).toBe(historyBefore);
    },
  );

  it("allows resolved call history but rejects multiple pending call effects", async () => {
    const allowedJob = "review-with-call-history";
    const allowed = prepareEffectBackedCsvReview({
      jobId: allowedJob,
      runId: "run-review-with-call-history",
    });
    const historical = seedAdditionalPendingEffect({
      sessionId: "run-review-with-call-history",
      runId: "historical-call-attempt",
      stepId: "tool:historical:call-1",
    });
    historical.resolveEffectReview({
      runId: "historical-call-attempt",
      stepId: "tool:historical:call-1",
      resolution: operatorCompletion("2026-08-03T00:00:30.000Z"),
      eventId: "historical-review",
    });
    await expect(
      repo.resolveUnknownOutcome({
        jobId: allowedJob,
        itemId: "row-a",
        disposition: "confirmed_committed",
        domainAction: "mark_completed",
        evidence: { reference: "review" },
        actor: "test-operator",
        reason: "confirmed",
        effectReview: operatorCompletion(),
      }),
    ).resolves.toBeUndefined();
    expect(terminalReviewEventCount(allowed.rolloutPath)).toBe(1);

    const blockedJob = "review-with-two-pending-effects";
    const blocked = prepareEffectBackedCsvReview({
      jobId: blockedJob,
      runId: "run-review-with-two-pending-effects",
    });
    seedAdditionalPendingEffect({
      sessionId: "run-review-with-two-pending-effects",
      runId: "competing-pending-attempt",
      stepId: "tool:competing:call-1",
    });
    const rolloutBefore = readFileSync(blocked.rolloutPath, "utf8");
    await expect(
      repo.resolveUnknownOutcome({
        jobId: blockedJob,
        itemId: "row-a",
        disposition: "confirmed_committed",
        domainAction: "mark_completed",
        evidence: { reference: "review" },
        actor: "test-operator",
        reason: "confirmed",
        effectReview: operatorCompletion(),
      }),
    ).rejects.toThrow(/call identity is ambiguous or stale/u);
    expect(readFileSync(blocked.rolloutPath, "utf8")).toBe(rolloutBefore);
    expect(terminalReviewEventCount(blocked.rolloutPath)).toBe(0);
  });

  it.each([
    {
      name: "schema-invalid",
      jobLimits: {},
      result: { value: 42 },
      error: /does not match/u,
    },
    {
      name: "per-item-quota",
      jobLimits: { maxResultBytes: 16 },
      result: { value: "x".repeat(64) },
      error: /limit is 16/u,
    },
    {
      name: "per-job-quota",
      jobLimits: { maxResultBytes: 1_024, maxResultBytesPerJob: 1_024 },
      result: { value: "x".repeat(64) },
      mutateQuota: (jobId: string) =>
        driver
          .prepareState(
            "UPDATE csv_agent_jobs SET max_result_bytes_per_job = 16 WHERE id = ?",
          )
          .run(jobId),
      error: /limit is 16/u,
    },
    {
      name: "global-result-quota",
      jobLimits: {},
      result: { value: "valid" },
      mutateQuota: (_jobId: string) =>
        driver
          .prepareState(
            "UPDATE csv_storage_quota SET result_blob_bytes = ? WHERE singleton = 1",
          )
          .run(CSV_MAX_RESULT_BLOB_BYTES_GLOBAL),
      error: /result blob byte quota/u,
    },
    {
      name: "global-durable-quota",
      jobLimits: {},
      result: { value: "valid" },
      mutateQuota: (_jobId: string) =>
        driver
          .prepareState(
            "UPDATE csv_storage_quota SET durable_bytes = ? WHERE singleton = 1",
          )
          .run(CSV_MAX_DURABLE_BYTES),
      error: /durable byte quota/u,
    },
  ])(
    "rejects recovered $name results before A1 or CSV projection",
    async ({ name, jobLimits, result, mutateQuota, error }) => {
      const jobId = `review-${name}`;
      const seeded = seedUnknownEffect(`run-${name}`);
      repo.createJob(
        {
          id: jobId,
          name: jobId,
          instruction: "x",
          autoExport: false,
          inputHeaders: ["value"],
          inputCsvPath: "/in",
          outputCsvPath: "",
          outputSchema: {
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"],
            additionalProperties: false,
          },
          ...jobLimits,
        },
        [item("row-a", 0, { value: "input" })],
      );
      repo.markJobRunning(jobId);
      repo.beginItemDispatch(jobId, "row-a", { effect: seeded.effect });
      repo.acknowledgeItemDispatch(jobId, "row-a", {});
      repo.markItemUnknownOutcome(jobId, "row-a", "ambiguous", {
        kind: "idempotency_lookup",
        reference: "lookup-1",
      });
      mutateQuota?.(jobId);

      const itemBefore = repo.getItem(jobId, "row-a");
      const jobBefore = repo.getJob(jobId);
      const rolloutBefore = readFileSync(seeded.rolloutPath, "utf8");
      const historyBefore = driver
        .prepareState<[string, string], { readonly count: number }>(
          `SELECT COUNT(*) AS count FROM csv_agent_job_review_history
           WHERE job_id = ? AND item_id = ?`,
        )
        .get(jobId, "row-a")!.count;
      await expect(
        repo.resolveUnknownOutcome({
          jobId,
          itemId: "row-a",
          disposition: "confirmed_committed",
          domainAction: "mark_completed",
          evidence: { reference: "requested-review" },
          actor: "test-operator",
          reason: "confirmed",
          effectReview: operatorCompletion(),
          result,
        }),
      ).rejects.toThrow(error);
      expect(repo.getItem(jobId, "row-a")).toEqual(itemBefore);
      expect(repo.getJob(jobId)).toEqual(jobBefore);
      expect(readFileSync(seeded.rolloutPath, "utf8")).toBe(rolloutBefore);
      expect(terminalReviewEventCount(seeded.rolloutPath)).toBe(0);
      expect(
        driver
          .prepareState<[string, string], { readonly count: number }>(
            `SELECT COUNT(*) AS count FROM csv_agent_job_review_history
             WHERE job_id = ? AND item_id = ?`,
          )
          .get(jobId, "row-a")!.count,
      ).toBe(historyBefore);
    },
  );

  it("rejects result blobs beyond the persisted per-item quota", () => {
    repo.createJob(
      {
        id: "bounded-result",
        name: "bounded-result",
        instruction: "x",
        autoExport: false,
        inputHeaders: ["value"],
        inputCsvPath: "/in",
        outputCsvPath: "",
        maxResultBytes: 16,
      },
      [item("opaque", 0, { value: "x" })],
    );
    repo.markItemRunning("bounded-result", "opaque");
    expect(() =>
      repo.markItemCompleted("bounded-result", "opaque", {
        value: "this is too large",
      }),
    ).toThrow(/limit is 16/);
    expect(repo.getItem("bounded-result", "opaque")?.status).toBe("running");
  });

  it("does not consume a validation token when accounting preflight fails", async () => {
    const schema = {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    } as const;
    repo.createJob(
      {
        id: "preflight-token-retry",
        name: "preflight-token-retry",
        instruction: "x",
        autoExport: false,
        inputHeaders: ["value"],
        inputCsvPath: "/in",
        outputCsvPath: "",
        outputSchema: schema,
      },
      [item("row-a", 0, { value: "input" })],
    );
    repo.markItemRunning("preflight-token-retry", "row-a");
    const validated = await validateCsvResultForPersistence(
      "preflight-token-retry",
      "row-a",
      compileCsvOutputSchema(schema),
      canonicalizeCsvResult({ value: "complete" }),
    );
    expect(typeof validated).not.toBe("string");
    if (typeof validated === "string") throw new Error(validated);
    const originalResultBytes = driver
      .prepareState<[], { readonly result_blob_bytes: number }>(
        "SELECT result_blob_bytes FROM csv_storage_quota WHERE singleton = 1",
      )
      .get()!.result_blob_bytes;
    driver
      .prepareState(
        "UPDATE csv_storage_quota SET result_blob_bytes = ? WHERE singleton = 1",
      )
      .run(CSV_MAX_RESULT_BLOB_BYTES_GLOBAL);
    expect(() =>
      repo.markItemCompletedValidated(
        "preflight-token-retry",
        "row-a",
        validated,
      ),
    ).toThrow(/result blob byte quota/u);
    driver
      .prepareState(
        "UPDATE csv_storage_quota SET result_blob_bytes = ? WHERE singleton = 1",
      )
      .run(originalResultBytes);
    expect(() =>
      repo.markItemCompletedValidated(
        "preflight-token-retry",
        "row-a",
        validated,
      ),
    ).not.toThrow();
    expect(repo.getItem("preflight-token-retry", "row-a")).toMatchObject({
      status: "completed",
      result: { value: "complete" },
    });
  });

  it("applies typed staging and result reservations without leaking quota", () => {
    const handle = repo.beginJobImport({
      id: "quota-import",
      name: "quota-import",
      instruction: "x",
      autoExport: false,
      inputHeaders: ["id"],
      inputCsvPath: "/in",
      outputCsvPath: "",
    });
    driver
      .prepareState(
        "UPDATE csv_storage_quota SET staging_rows = ? WHERE singleton = 1",
      )
      .run(CSV_MAX_STAGING_ROWS_GLOBAL);
    expect(() =>
      repo.appendJobImportItems(handle, [item("one", 0, { id: "one" })]),
    ).toThrow(/staging row quota/u);
    driver
      .prepareState(
        "UPDATE csv_storage_quota SET staging_rows = 0 WHERE singleton = 1",
      )
      .run();
    repo.abortJobImport(handle, "quota test");
    repo.deleteAbortedImport(handle);

    repo.createJob(
      {
        id: "result-reservation",
        name: "result-reservation",
        instruction: "x",
        autoExport: false,
        inputHeaders: ["id"],
        inputCsvPath: "/in",
        outputCsvPath: "",
        maxResultBytes: 1_024,
        maxResultBytesPerJob: 4_096,
      },
      [item("a", 0, { id: "a" }), item("b", 1, { id: "b" })],
    );
    driver
      .prepareState(
        "UPDATE csv_storage_quota SET result_blob_bytes = ? WHERE singleton = 1",
      )
      .run(CSV_MAX_RESULT_BLOB_BYTES_GLOBAL - 1_024);
    repo.markItemRunning("result-reservation", "a");
    expect(() => repo.markItemRunning("result-reservation", "b")).toThrow(
      /result blob byte quota/u,
    );
    repo.markItemFailed("result-reservation", "a", "settled");
    expect(() => repo.markItemRunning("result-reservation", "b")).not.toThrow();
  });

  it("reclaims crashed import quota without Linux boot/start metadata", async () => {
    driver
      .prepareState(
        `INSERT INTO csv_agent_jobs (
           id, name, status, instruction, input_headers_json, input_csv_path,
           output_csv_path, auto_export, import_id, import_state,
           import_lease_owner, import_lease_expires_at, import_owner_pid,
           import_owner_boot_id, import_owner_process_start,
           import_lease_generation, execution_gate,
           requested_max_concurrency, identity_format_version, input_bytes,
           max_items, max_result_bytes, max_result_bytes_per_job,
           created_at, updated_at
         ) VALUES (
           'portable-dead-import', 'portable-dead-import', 'pending', 'x',
           '["id"]', '/in', '', 0, 'portable-dead-import-id', 'staging',
           'dead-owner', 1, 4242, NULL, NULL, 'portable-dead-generation',
           'ready', 16, 1, 0, 10, 1024, 4096, 1, 1
         )`,
      )
      .run();
    driver
      .prepareState(
        `UPDATE csv_storage_quota SET active_imports = active_imports + 1
         WHERE singleton = 1`,
      )
      .run();

    const recovered = await CsvAgentJobsRepository.open(driver, {
      processIdentityProbe: deadOwnerProbe(41),
    });
    expect(recovered.listJobs()).toEqual([]);
    expect(
      driver
        .prepareState<[], { readonly active_imports: number }>(
          "SELECT active_imports FROM csv_storage_quota WHERE singleton = 1",
        )
        .get()?.active_imports,
    ).toBe(0);
  });

  it("defers an expired lease when PID reuse prevents exact owner proof", async () => {
    driver
      .prepareState(
        `INSERT INTO csv_agent_jobs (
           id, name, status, instruction, input_headers_json, input_csv_path,
           output_csv_path, auto_export, import_id, import_state,
           import_lease_owner, import_lease_expires_at, import_owner_pid,
           import_owner_boot_id, import_owner_process_start,
           import_lease_generation, execution_gate,
           requested_max_concurrency, identity_format_version, input_bytes,
           max_items, max_result_bytes, max_result_bytes_per_job,
           created_at, updated_at
         ) VALUES (
           'reused-pid-import', 'reused-pid-import', 'pending', 'x', '["id"]',
           '/in', '', 0, 'reused-pid-import-id', 'staging', 'old-owner', 1,
           4242, NULL, NULL, 'reused-pid-generation', 'ready', 16, 1, 0,
           10, 1024, 4096, 1, 1
         )`,
      )
      .run();
    driver
      .prepareState(
        `UPDATE csv_storage_quota SET active_imports = active_imports + 1
         WHERE singleton = 1`,
      )
      .run();
    const reusedPidProbe: CsvProcessIdentityProbe = {
      current: { pid: 41 },
      inspect() {
        return { kind: "alive" };
      },
    };

    await CsvAgentJobsRepository.open(driver, {
      processIdentityProbe: reusedPidProbe,
    });
    expect(
      driver
        .prepareState<
          [],
          { readonly import_state: string; readonly last_error: string | null }
        >(
          `SELECT import_state, last_error FROM csv_agent_jobs
           WHERE id = 'reused-pid-import'`,
        )
        .get(),
    ).toEqual({
      import_state: "staging",
      last_error: CSV_RECOVERY_DEFERRED_PROCESS_IDENTITY_UNPROVEN,
    });
    expect(
      driver
        .prepareState<[], { readonly active_imports: number }>(
          "SELECT active_imports FROM csv_storage_quota WHERE singleton = 1",
        )
        .get()?.active_imports,
    ).toBe(1);
  });

  it.each(["darwin", "win32"] as const)(
    "reclaims an expired import after exact %s PID-generation mismatch",
    async (platform) => {
      seedExpiredStagedImport(`${platform}-reused-generation`, "old-start");
      const exactProbe = await createCsvProcessIdentityProbe({
        platform,
        pid: 41,
        signalProcess() {},
        inspectProcessStart(_platform, targetPid) {
          return targetPid === 41 ? "current-start" : "new-start";
        },
      });

      await CsvAgentJobsRepository.open(driver, {
        processIdentityProbe: exactProbe,
      });

      expect(
        driver
          .prepareState<[], { readonly active_imports: number }>(
            "SELECT active_imports FROM csv_storage_quota WHERE singleton = 1",
          )
          .get()?.active_imports,
      ).toBe(0);
      expect(
        driver
          .prepareState<[string], { readonly import_state: string }>(
            "SELECT import_state FROM csv_agent_jobs WHERE id = ?",
          )
          .get(`${platform}-reused-generation`),
      ).toBeUndefined();
    },
  );

  it.each(["darwin", "win32"] as const)(
    "defers %s recovery when permissions hide the exact process generation",
    async (platform) => {
      const id = `${platform}-permission-limited`;
      seedExpiredStagedImport(id, "old-start");
      const permissionLimitedProbe = await createCsvProcessIdentityProbe({
        platform,
        pid: 41,
        signalProcess(targetPid) {
          if (targetPid === 41) return;
          throw Object.assign(new Error("permission denied"), {
            code: "EPERM",
          });
        },
        inspectProcessStart(_platform, targetPid) {
          return targetPid === 41 ? "current-start" : undefined;
        },
      });

      await CsvAgentJobsRepository.open(driver, {
        processIdentityProbe: permissionLimitedProbe,
      });

      expect(
        driver
          .prepareState<
            [string],
            {
              readonly import_state: string;
              readonly last_error: string | null;
            }
          >("SELECT import_state, last_error FROM csv_agent_jobs WHERE id = ?")
          .get(id),
      ).toEqual({
        import_state: "staging",
        last_error: CSV_RECOVERY_DEFERRED_PROCESS_PROBE_UNAVAILABLE,
      });
    },
  );

  it("rotates an exclusive import recovery generation against a stale second daemon", () => {
    const first = new CsvAgentJobsRepository(driver, {
      processIdentityProbe: deadOwnerProbe(51),
    });
    const second = new CsvAgentJobsRepository(driver, {
      processIdentityProbe: deadOwnerProbe(52),
    });
    driver
      .prepareState(
        `INSERT INTO csv_agent_jobs (
           id, name, status, instruction, input_headers_json, input_csv_path,
           output_csv_path, auto_export, import_id, import_state,
           import_lease_owner, import_lease_expires_at, import_owner_pid,
           import_owner_boot_id, import_owner_process_start,
           import_lease_generation, execution_gate,
           requested_max_concurrency, identity_format_version, input_bytes,
           max_items, max_result_bytes, max_result_bytes_per_job,
           created_at, updated_at
         ) VALUES (
           'raced-import', 'raced-import', 'pending', 'x', '["id"]', '/in',
           '', 0, 'raced-import-id', 'staging', 'dead-owner', 1, 4242,
           NULL, NULL, 'stale-generation', 'ready', 16, 1, 0,
           10, 1024, 4096, 1, 1
         )`,
      )
      .run();
    driver
      .prepareState(
        `UPDATE csv_storage_quota SET active_imports = active_imports + 1
         WHERE singleton = 1`,
      )
      .run();
    const candidate = driver
      .prepareState<
        [],
        {
          readonly id: string;
          readonly import_id: string;
          readonly import_lease_owner: string;
          readonly import_lease_generation: string;
          readonly import_owner_pid: number;
          readonly import_owner_boot_id: string | null;
          readonly import_owner_process_start: string | null;
          readonly total_items: number;
          readonly staging_bytes: number;
        }
      >(
        `SELECT id, import_id, import_lease_owner, import_lease_generation,
                import_owner_pid, import_owner_boot_id,
                import_owner_process_start, total_items, staging_bytes
         FROM csv_agent_jobs WHERE id = 'raced-import'`,
      )
      .get()!;
    type Claim = {
      readonly leaseOwner: string;
      readonly leaseGeneration: string;
    };
    const firstRecovery = first as unknown as {
      claimAbandonedImportRecovery(value: typeof candidate): Claim | null;
      finishAbandonedImportRecovery(
        value: typeof candidate,
        claim: Claim,
      ): void;
      releaseImportRecoveryClaim(claim: Claim): void;
      cleanupAbortedImport(jobId: string, importId: string): void;
    };
    const secondRecovery = second as unknown as {
      claimAbandonedImportRecovery(value: typeof candidate): Claim | null;
    };

    const firstClaim = firstRecovery.claimAbandonedImportRecovery(candidate);
    expect(firstClaim).not.toBeNull();
    expect(secondRecovery.claimAbandonedImportRecovery(candidate)).toBeNull();
    firstRecovery.finishAbandonedImportRecovery(candidate, firstClaim!);
    firstRecovery.releaseImportRecoveryClaim(firstClaim!);
    firstRecovery.cleanupAbortedImport(candidate.id, candidate.import_id);
    expect(
      driver
        .prepareState<[], { readonly active_imports: number }>(
          "SELECT active_imports FROM csv_storage_quota WHERE singleton = 1",
        )
        .get()?.active_imports,
    ).toBe(0);
  });

  it("reclaims a crashed output intent and its quota without /proc metadata", async () => {
    repo.createJob(
      {
        id: "portable-output-recovery",
        name: "portable-output-recovery",
        instruction: "x",
        autoExport: false,
        inputHeaders: ["value"],
        inputCsvPath: "/in",
        outputCsvPath: "",
      },
      [item("portable-output-item", 0, { value: "one" })],
    );
    const temporary = join(cwd, ".portable-output.agenc-csv.tmp");
    const target = join(cwd, "portable-output.csv");
    await writeFile(temporary, "partial", { mode: 0o600 });
    const stats = await lstat(temporary, { bigint: true });
    driver
      .prepareState(
        `INSERT INTO csv_output_intents (
           intent_id, job_id, root_path, target_path, temporary_path,
           temporary_dev, temporary_ino, reserved_bytes, state,
           recovery_prior_state, owner_generation, owner_pid,
           owner_boot_id, owner_process_start, created_at, updated_at
         ) VALUES (
           'portable-output-intent', 'portable-output-recovery', ?, ?, ?, ?, ?,
           64, 'abandoned', NULL, 'portable-output-generation', 4242,
           NULL, NULL, 1, 1
         )`,
      )
      .run(cwd, target, temporary, stats.dev.toString(), stats.ino.toString());
    driver
      .prepareState(
        `UPDATE csv_storage_quota SET output_staging_files = 1,
           output_staging_bytes = 64 WHERE singleton = 1`,
      )
      .run();
    const recovered = new CsvAgentJobsRepository(driver, {
      processIdentityProbe: deadOwnerProbe(61),
    });

    expect(
      await recoverCsvOutputIntents(
        createCsvOutputRootCapability(cwd),
        recovered,
      ),
    ).toEqual({ recovered: 1, deferred: 0 });
    await expect(readFile(temporary)).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      driver
        .prepareState<
          [],
          {
            readonly output_staging_files: number;
            readonly output_staging_bytes: number;
          }
        >(
          `SELECT output_staging_files, output_staging_bytes
           FROM csv_storage_quota WHERE singleton = 1`,
        )
        .get(),
    ).toEqual({ output_staging_files: 0, output_staging_bytes: 0 });
  });

  it("bounds unavailable output probes and pages fairly across intents", async () => {
    repo.createJob(
      {
        id: "bounded-output-job",
        name: "bounded-output-job",
        instruction: "x",
        autoExport: false,
        inputHeaders: ["value"],
        inputCsvPath: "/in",
        outputCsvPath: "",
      },
      [item("bounded-output-item", 0, { value: "one" })],
    );
    const candidateCount = CSV_RECOVERY_CANDIDATE_PAGE_SIZE + 5;
    const insertIntent = driver.prepareState(
      `INSERT INTO csv_output_intents (
         intent_id, job_id, root_path, target_path, temporary_path,
         temporary_dev, temporary_ino, reserved_bytes, state,
         recovery_prior_state, owner_generation, owner_pid,
         owner_boot_id, owner_process_start, created_at, updated_at
       ) VALUES (?, 'bounded-output-job', ?, ?, ?, '1', '1', 1, 'writing',
         NULL, ?, 4242, NULL, 'old-start', 1, 1)`,
    );
    for (let index = 0; index < candidateCount; index += 1) {
      const suffix = String(index).padStart(2, "0");
      insertIntent.run(
        `bounded-output-${suffix}`,
        cwd,
        join(cwd, `bounded-output-${suffix}.csv`),
        join(cwd, `.bounded-output-${suffix}.tmp`),
        `bounded-output-generation-${suffix}`,
      );
    }
    let inspectCalls = 0;
    const unavailableProbe: CsvProcessIdentityProbe = {
      current: { pid: 41, processStart: "current-start" },
      inspect() {
        inspectCalls += 1;
        return { kind: "unknown" };
      },
    };
    const recovering = new CsvAgentJobsRepository(driver, {
      processIdentityProbe: unavailableProbe,
    });

    const recovery = recoverCsvOutputIntents(
      createCsvOutputRootCapability(cwd),
      recovering,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(inspectCalls).toBeLessThanOrEqual(
      CSV_RECOVERY_MAX_PROCESS_PROBES_PER_PASS,
    );
    await expect(recovery).resolves.toEqual({ recovered: 0, deferred: 0 });

    expect(
      driver
        .prepareState<[string], { readonly count: number }>(
          `SELECT COUNT(*) AS count FROM csv_output_intents
           WHERE intent_id LIKE 'bounded-output-%' AND last_error = ?`,
        )
        .get(CSV_RECOVERY_DEFERRED_PROCESS_PROBE_UNAVAILABLE)?.count,
    ).toBe(candidateCount);
  });

  it("drains more than one output recovery page in one startup call", async () => {
    repo.createJob(
      {
        id: "paged-output-job",
        name: "paged-output-job",
        instruction: "x",
        autoExport: false,
        inputHeaders: ["value"],
        inputCsvPath: "/in",
        outputCsvPath: "",
      },
      [item("paged-output-item", 0, { value: "one" })],
    );
    const candidateCount = CSV_RECOVERY_CANDIDATE_PAGE_SIZE + 5;
    const insertIntent = driver.prepareState(
      `INSERT INTO csv_output_intents (
         intent_id, job_id, root_path, target_path, temporary_path,
         temporary_dev, temporary_ino, reserved_bytes, state,
         recovery_prior_state, owner_generation, owner_pid,
         owner_boot_id, owner_process_start, created_at, updated_at
       ) VALUES (?, 'paged-output-job', ?, ?, ?, ?, ?, 1, 'abandoned',
         NULL, ?, 4242, NULL, NULL, 1, 1)`,
    );
    for (let index = 0; index < candidateCount; index += 1) {
      const suffix = String(index).padStart(2, "0");
      const temporaryPath = join(cwd, `.paged-output-${suffix}.agenc-csv.tmp`);
      await writeFile(temporaryPath, "x", { mode: 0o600 });
      const stats = await lstat(temporaryPath, { bigint: true });
      insertIntent.run(
        `paged-output-${suffix}`,
        cwd,
        join(cwd, `paged-output-${suffix}.csv`),
        temporaryPath,
        stats.dev.toString(),
        stats.ino.toString(),
        `paged-output-generation-${suffix}`,
      );
    }
    driver
      .prepareState(
        `UPDATE csv_storage_quota SET output_staging_files = ?,
           output_staging_bytes = ? WHERE singleton = 1`,
      )
      .run(candidateCount, candidateCount);
    const recovering = new CsvAgentJobsRepository(driver, {
      processIdentityProbe: deadOwnerProbe(61),
    });

    const recoveryResult = await recoverCsvOutputIntents(
      createCsvOutputRootCapability(cwd),
      recovering,
    );
    expect(
      driver
        .prepareState<[], { readonly last_error: string | null }>(
          "SELECT DISTINCT last_error FROM csv_output_intents WHERE intent_id LIKE 'paged-output-%'",
        )
        .all(),
    ).toEqual([]);
    expect(recoveryResult).toEqual({ recovered: candidateCount, deferred: 0 });
    expect(
      driver
        .prepareState<[], { readonly count: number }>(
          "SELECT COUNT(*) AS count FROM csv_output_intents WHERE intent_id LIKE 'paged-output-%'",
        )
        .get()?.count,
    ).toBe(0);
    expect(
      driver
        .prepareState<
          [],
          {
            readonly output_staging_files: number;
            readonly output_staging_bytes: number;
          }
        >(
          `SELECT output_staging_files, output_staging_bytes
           FROM csv_storage_quota WHERE singleton = 1`,
        )
        .get(),
    ).toEqual({ output_staging_files: 0, output_staging_bytes: 0 });
  });

  it("recovers only an importer whose exact OS owner is proven dead", async () => {
    if (process.platform !== "linux") return;
    const bootId = readFileSync(
      "/proc/sys/kernel/random/boot_id",
      "utf8",
    ).trim();
    driver
      .prepareState(
        `INSERT INTO csv_agent_jobs (
           id, name, status, instruction, input_headers_json, input_csv_path,
           output_csv_path, auto_export, import_id, import_state,
           import_lease_owner, import_lease_expires_at, import_owner_pid,
           import_owner_boot_id, import_owner_process_start,
           import_lease_generation, execution_gate,
           requested_max_concurrency, identity_format_version, input_bytes,
           max_items, max_result_bytes, max_result_bytes_per_job,
           created_at, updated_at
         ) VALUES (
           'dead-import', 'dead-import', 'pending', 'x', '["id"]', '/in',
           '', 0, 'dead-import-id', 'staging', 'dead-owner', 1,
           2147483647, ?, '1', 'dead-generation', 'ready', 16, 1, 0,
           10, 1024, 4096, 1, 1
         )`,
      )
      .run(bootId);
    driver
      .prepareState(
        `UPDATE csv_storage_quota SET active_imports = active_imports + 1
         WHERE singleton = 1`,
      )
      .run();

    const recovered = await CsvAgentJobsRepository.open(driver);
    expect(recovered.listJobs()).toEqual([]);
    expect(
      driver
        .prepareState<[], { readonly count: number }>(
          "SELECT COUNT(*) AS count FROM csv_agent_jobs WHERE id = 'dead-import'",
        )
        .get()?.count,
    ).toBe(0);
    expect(
      driver
        .prepareState<[], { readonly active_imports: number }>(
          "SELECT active_imports FROM csv_storage_quota WHERE singleton = 1",
        )
        .get()?.active_imports,
    ).toBe(0);
  });
});
