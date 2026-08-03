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
import {
  CSV_RECOVERY_DEFERRED_PROCESS_IDENTITY_UNPROVEN,
  createCsvProcessIdentityProbe,
  CsvAgentJobsRepository,
  type CsvProcessIdentityProbe,
} from "./csv-agent-jobs.js";
import {
  createCsvOutputRootCapability,
  recoverCsvOutputIntents,
} from "../agents/jobs/csv-output.js";
import {
  CSV_MAX_RESULT_BLOB_BYTES_GLOBAL,
  CSV_MAX_STAGING_ROWS_GLOBAL,
} from "../contracts/csv-job-contract.js";
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
    "uses an authoritative OS liveness probe on %s without /proc metadata",
    (platform) => {
      const missing = Object.assign(new Error("missing process"), {
        code: "ESRCH",
      });
      const probe = createCsvProcessIdentityProbe({
        platform,
        pid: 41,
        signalProcess(pid) {
          if (pid === 41) return;
          throw missing;
        },
      });

      expect(probe.current).toEqual({ pid: 41 });
      expect(probe.inspect(42)).toEqual({ kind: "dead" });

      const denied = createCsvProcessIdentityProbe({
        platform,
        pid: 41,
        signalProcess(targetPid) {
          if (targetPid === 41) return;
          throw Object.assign(new Error("permission denied"), {
            code: "EPERM",
          });
        },
      });
      expect(denied.inspect(42)).toEqual({ kind: "alive" });

      const unavailable = createCsvProcessIdentityProbe({
        platform,
        pid: 41,
        signalProcess(targetPid) {
          if (targetPid === 41) return;
          throw Object.assign(new Error("probe unavailable"), { code: "EIO" });
        },
      });
      expect(unavailable.inspect(42)).toEqual({ kind: "unknown" });
    },
  );

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

  it("holds ambiguous outcomes for evidence-backed review and abandons terminally", () => {
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
    expect(() =>
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
    ).toThrow(/no canonical effect identity/u);
    repo.resolveUnknownOutcome({
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

  it("refuses to advance a CSV review when its canonical effect is missing", () => {
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
    expect(() =>
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
    ).toThrow(/missing or stale/u);
    expect(repo.getItem("missing-effect", "opaque")).toMatchObject({
      status: "unknown_outcome",
      reviewStatus: "pending",
    });
  });

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

  it("reclaims crashed import quota without Linux boot/start metadata", () => {
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

    const recovered = new CsvAgentJobsRepository(driver, {
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

  it("defers an expired lease when PID reuse prevents exact owner proof", () => {
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

    new CsvAgentJobsRepository(driver, {
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

  it("recovers only an importer whose exact OS owner is proven dead", () => {
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

    const recovered = new CsvAgentJobsRepository(driver);
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
