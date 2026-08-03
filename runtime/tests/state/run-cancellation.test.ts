// M3 final slice: tree-scoped run cancellation cascade + spawn admission
// gate. Cancelling a run moves every non-terminal descendant (queued AND
// running) to `cancelled` in one transaction, closes open spawn edges, and
// preserves in-flight tool-call evidence. A new spawn edge under a
// cancel-locked ancestor is refused with the typed
// SpawnAdmissionBlockedError; cancelled/unknown_outcome statuses are
// sticky against upsert/update laundering; startup recovery finishes a
// crash-interrupted cascade instead of resurrecting survivors.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CancellationSetLimitError,
  CancellationRepairDeferredError,
  MAX_ANCESTOR_WALK,
  MAX_CANCELLATION_REPAIR_ROOTS,
  MAX_CANCELLATION_RUNS,
  cancelAgentRunTree,
  checkSpawnAdmissionGate,
  repairCancelledSubtrees,
  SpawnAdmissionBlockedError,
} from "../../src/state/run-cancellation.js";
import {
  upsertAgentRun,
  updateAgentRunStatus,
} from "../../src/state/agent-runs.js";
import { ExecutionAdmissionRepository } from "../../src/state/execution-admission.js";
import { ThreadSpawnEdgeRepository } from "../../src/state/spawn-edges.js";
import { recordInFlightToolCallStart } from "../../src/state/tool-output-rotation.js";
import {
  exportAgentState,
  importAgentState,
} from "../../src/state/export-import.js";
import { recoverDaemonStateOnStartup } from "../../src/state/recovery.js";
import { StateRunDurabilityRepository } from "../../src/state/run-durability.js";
import {
  openStateDatabases,
  type StateSqliteDriver,
} from "../../src/state/sqlite-driver.js";

let home: string;
let cwd: string;
let driver: StateSqliteDriver;
let admissions: ExecutionAdmissionRepository;

const T0 = "2026-07-18T00:00:00.000Z";
const T1 = "2026-07-18T00:05:00.000Z";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agenc-run-cancel-home-"));
  cwd = mkdtempSync(join(tmpdir(), "agenc-run-cancel-cwd-"));
  mkdirSync(join(cwd, ".git"));
  driver = openStateDatabases({ cwd, agencHome: home });
  admissions = new ExecutionAdmissionRepository(driver, {
    now: () => new Date(T1),
  });
});

afterEach(() => {
  driver.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

function run(id: string, status: string): void {
  upsertAgentRun(driver, {
    id,
    objective: id,
    status,
    startedAt: T0,
    lastActiveAt: T0,
  });
}

function edge(
  edges: ThreadSpawnEdgeRepository,
  childId: string,
  parentId: string,
  parentPath: string,
  opts?: { admissionGate?: "enforce" | "import" },
): void {
  const depth = `${parentPath}/${childId}`.split("/").length - 2;
  edges.create(
    {
      childThreadId: childId,
      parentThreadId: parentId,
      parentPath,
      metadata: {
        agentId: childId,
        agentPath: `${parentPath}/${childId}`,
        depth,
      },
      status: "open",
    },
    opts,
  );
}

function statusOf(id: string): string | undefined {
  return driver
    .prepareState<[string], { status?: string }>(
      "SELECT status FROM agent_runs WHERE id = ?",
    )
    .get(id)?.status;
}

function edgeStatusOf(childId: string): string | undefined {
  return driver
    .prepareState<[string], { status?: string }>(
      "SELECT status FROM thread_spawn_edges WHERE child_thread_id = ?",
    )
    .get(childId)?.status;
}

describe("cancelAgentRunTree", () => {
  it("cancels queued and running descendants transitively, closes open edges, preserves evidence", () => {
    const edges = new ThreadSpawnEdgeRepository(driver);
    run("parent", "running");
    run("child_running", "running");
    run("child_queued", "pending");
    run("grandchild", "working");
    run("child_done", "completed");
    edge(edges, "child_running", "parent", "/root");
    edge(edges, "child_queued", "parent", "/root");
    edge(edges, "grandchild", "child_running", "/root/child_running");
    edge(edges, "child_done", "parent", "/root");
    edges.setStatus("child_done", "closed");
    recordInFlightToolCallStart(driver, {
      sessionId: "cancel-session",
      agentId: "child_running",
      toolCallId: "cancel-tool-1",
      toolName: "Bash",
      args: { command: "echo partial" },
      startedAt: T0,
      recoveryCategory: "side-effecting",
      agencHome: home,
    });

    const report = cancelAgentRunTree(driver, {
      runId: "parent",
      reason: "test-cancel",
      cancelledAt: T1,
    });

    expect(report.missing).toBe(false);
    expect(report.alreadyTerminal).toBe(false);
    expect([...report.cancelledRunIds].sort()).toEqual([
      "child_queued",
      "child_running",
      "grandchild",
      "parent",
    ]);
    expect(report.priorStatusById).toEqual({
      parent: "running",
      child_running: "running",
      child_queued: "pending",
      grandchild: "working",
    });
    for (const id of [
      "parent",
      "child_running",
      "child_queued",
      "grandchild",
    ]) {
      expect(statusOf(id)).toBe("cancelled");
    }
    // Terminal history is never rewritten.
    expect(statusOf("child_done")).toBe("completed");
    // Open subtree edges are closed; the already-closed one is untouched.
    expect(edgeStatusOf("child_running")).toBe("closed");
    expect(edgeStatusOf("child_queued")).toBe("closed");
    expect(edgeStatusOf("grandchild")).toBe("closed");
    expect([...report.closedEdgeChildIds].sort()).toEqual([
      "child_queued",
      "child_running",
      "grandchild",
    ]);
    // Partial evidence preserved: the in-flight row is untouched.
    const evidenceRow = driver
      .prepareState<[string], { status?: string }>(
        "SELECT status FROM in_flight_tool_calls WHERE tool_call_id = ?",
      )
      .get("cancel-tool-1");
    expect(evidenceRow).toBeDefined();
    // Cancel metadata is recorded on each cancelled run.
    const meta = driver
      .prepareState<[string], { metadata_json?: string }>(
        "SELECT metadata_json FROM agent_runs WHERE id = ?",
      )
      .get("grandchild")?.metadata_json;
    expect(JSON.parse(meta ?? "{}")).toMatchObject({
      cancelReason: "test-cancel",
      cancelledBy: "parent",
      cancelledAt: T1,
    });
  });

  it("is idempotent and honest about missing runs", () => {
    run("parent", "running");
    const first = cancelAgentRunTree(driver, {
      runId: "parent",
      reason: "r",
      cancelledAt: T1,
    });
    expect(first.cancelledRunIds).toEqual(["parent"]);
    const second = cancelAgentRunTree(driver, {
      runId: "parent",
      reason: "r",
      cancelledAt: T1,
    });
    expect(second.alreadyTerminal).toBe(true);
    expect(second.cancelledRunIds).toEqual([]);
    const missing = cancelAgentRunTree(driver, {
      runId: "no_such_run",
      reason: "r",
      cancelledAt: T1,
    });
    expect(missing.missing).toBe(true);
  });

  it("repairs descendants when canonical recovery cancelled the root before the DB cascade", () => {
    const edges = new ThreadSpawnEdgeRepository(driver);
    run("canonical_cancelled_root", "running");
    run("surviving_child", "running");
    edge(edges, "surviving_child", "canonical_cancelled_root", "/root");
    updateAgentRunStatus(driver, {
      id: "canonical_cancelled_root",
      status: "cancelled",
      lastActiveAt: T1,
    });

    const repaired = cancelAgentRunTree(driver, {
      runId: "canonical_cancelled_root",
      reason: "operator_retry",
      cancelledAt: T1,
    });

    expect(repaired.alreadyTerminal).toBe(true);
    expect(repaired.cancelledRunIds).toEqual(["surviving_child"]);
    expect(statusOf("surviving_child")).toBe("cancelled");
    expect(edgeStatusOf("surviving_child")).toBe("closed");
    const metadata = driver
      .prepareState<[string], { metadata_json: string | null }>(
        "SELECT metadata_json FROM agent_runs WHERE id = ?",
      )
      .get("canonical_cancelled_root")?.metadata_json;
    expect(JSON.parse(metadata ?? "{}")).toMatchObject({
      cascadeComplete: true,
      cancelReason: "operator_retry",
    });
  });

  it("survives an edge cycle without hanging", () => {
    const edges = new ThreadSpawnEdgeRepository(driver);
    run("a", "running");
    run("b", "running");
    edge(edges, "b", "a", "/root");
    // A hostile/corrupt reverse edge forming a cycle (b -> a).
    edge(edges, "a", "b", "/root/b");
    const report = cancelAgentRunTree(driver, {
      runId: "a",
      reason: "cycle",
      cancelledAt: T1,
    });
    expect([...report.cancelledRunIds].sort()).toEqual(["a", "b"]);
  });

  it("reports roots first and every other identity in binary order", () => {
    const edges = new ThreadSpawnEdgeRepository(driver);
    for (const id of ["zz_root", "z_child", "a0_child", "a_child"]) {
      run(id, "running");
    }
    edge(edges, "z_child", "zz_root", "/root");
    edge(edges, "a0_child", "zz_root", "/root");
    edge(edges, "a_child", "zz_root", "/root");

    const report = cancelAgentRunTree(driver, {
      runId: "zz_root",
      reason: "ordered-report",
      cancelledAt: T1,
    });

    expect(report.subtreeRunIds).toEqual([
      "zz_root",
      "a0_child",
      "a_child",
      "z_child",
    ]);
    expect(report.cancelledRunIds).toEqual(report.subtreeRunIds);
    expect(report.cancellationNodeCount).toBe(4);
    expect(report.cancellationEdgeCount).toBe(3);
  });

  it("uses a fixed SQL statement budget independent of subtree cardinality", () => {
    const edges = new ThreadSpawnEdgeRepository(driver);
    run("small_root", "running");
    run("small_child", "running");
    edge(edges, "small_child", "small_root", "/root");
    run("large-root", "running");
    driver
      .prepareState(
        `WITH RECURSIVE sequence(value) AS (
           VALUES (1)
           UNION ALL
           SELECT value + 1 FROM sequence WHERE value < 1_000
         )
         INSERT INTO thread_spawn_edges (
           child_thread_id, parent_thread_id, parent_path, metadata_json, status
         )
         SELECT printf('large-%04d', value),
                CASE value WHEN 1 THEN 'large-root'
                  ELSE printf('large-%04d', value - 1) END,
                '/root', '{}', 'open'
         FROM sequence`,
      )
      .run();
    const prepare = vi.spyOn(driver, "prepareState");
    prepare.mockClear();

    cancelAgentRunTree(driver, {
      runId: "small_root",
      reason: "statement-count",
      cancelledAt: T1,
    });
    const smallStatementCount = prepare.mock.calls.length;
    prepare.mockClear();
    const large = cancelAgentRunTree(driver, {
      runId: "large-root",
      reason: "statement-count",
      cancelledAt: T1,
    });

    expect(large.subtreeRunIds).toHaveLength(1_001);
    expect(prepare.mock.calls).toHaveLength(smallStatementCount);
  });

  it("accepts exactly the run bound and rejects the plus-one sentinel before mutation", () => {
    const seedChain = (prefix: string, nodeCount: number): void => {
      run(`${prefix}-000000`, "running");
      driver
        .prepareState<[number]>(
          `WITH RECURSIVE sequence(value) AS (
             VALUES (1)
             UNION ALL
             SELECT value + 1 FROM sequence WHERE value < ?
           )
           INSERT INTO thread_spawn_edges (
             child_thread_id, parent_thread_id, parent_path,
             metadata_json, status
           )
           SELECT printf('${prefix}-%06d', value),
                  CASE value WHEN 1 THEN '${prefix}-000000'
                    ELSE printf('${prefix}-%06d', value - 1) END,
                  '/root', '{}', 'open'
           FROM sequence`,
        )
        .run(nodeCount - 1);
    };
    seedChain("at-max", MAX_CANCELLATION_RUNS);
    const atMax = cancelAgentRunTree(driver, {
      runId: "at-max-000000",
      reason: "bound",
      cancelledAt: T1,
    });
    expect(atMax.subtreeRunIds).toHaveLength(MAX_CANCELLATION_RUNS);
    expect(atMax.cancellationNodeCount).toBe(MAX_CANCELLATION_RUNS);

    seedChain("over-max", MAX_CANCELLATION_RUNS + 1);
    expect(() =>
      cancelAgentRunTree(driver, {
        runId: "over-max-000000",
        reason: "bound",
        cancelledAt: T1,
      }),
    ).toThrow(
      expect.objectContaining<Partial<CancellationSetLimitError>>({
        code: "CANCELLATION_SET_LIMIT",
        dimension: "runs",
        observed: MAX_CANCELLATION_RUNS + 1,
        limit: MAX_CANCELLATION_RUNS,
      }),
    );
    expect(statusOf("over-max-000000")).toBe("running");
    expect(edgeStatusOf("over-max-000001")).toBe("open");
    expect(
      driver
        .prepareState<[], { readonly count: number }>(
          `SELECT COUNT(*) AS count
           FROM temp.agenc_cancellation_operation_runs`,
        )
        .get()?.count,
    ).toBe(0);
  }, 30_000);
});

describe("spawn admission gate", () => {
  it("refuses a new edge under a cancelled parent with the typed error, and only then", () => {
    const edges = new ThreadSpawnEdgeRepository(driver);
    run("parent", "running");
    edge(edges, "ok_child", "parent", "/root");
    cancelAgentRunTree(driver, {
      runId: "parent",
      reason: "r",
      cancelledAt: T1,
    });

    run("late_child", "running");
    expect(() => edge(edges, "late_child", "parent", "/root")).toThrow(
      SpawnAdmissionBlockedError,
    );
    expect(edgeStatusOf("late_child")).toBeUndefined();
    const decision = checkSpawnAdmissionGate(driver, {
      parentThreadId: "parent",
    });
    expect(decision).toEqual({
      allowed: false,
      decision: "deny",
      reason: "parent_cancel_locked",
      parentRunId: "parent",
      parentStatus: "cancelled",
    });
  });

  it("refuses through a terminal-but-revivable intermediate run row (whole-chain walk)", () => {
    const edges = new ThreadSpawnEdgeRepository(driver);
    run("cancelled_root", "running");
    run("completed_mid", "completed");
    edge(edges, "completed_mid", "cancelled_root", "/root");
    cancelAgentRunTree(driver, {
      runId: "cancelled_root",
      reason: "r",
      cancelledAt: T1,
    });
    expect(statusOf("completed_mid")).toBe("completed");
    // A `completed` intermediate must not shield admissions below it from
    // the cancelled root: cancellation poisons the whole tree.
    expect(() =>
      edge(edges, "late_leaf", "completed_mid", "/root/completed_mid"),
    ).toThrow(SpawnAdmissionBlockedError);
  });

  it("walks up the spawn tree to the nearest ancestor with a run row", () => {
    const edges = new ThreadSpawnEdgeRepository(driver);
    run("root_run", "running");
    // Middle thread has NO agent_runs row — only the edge chain links it.
    edge(edges, "middle", "root_run", "/root");
    edge(edges, "leaf", "middle", "/root/middle");
    cancelAgentRunTree(driver, {
      runId: "root_run",
      reason: "r",
      cancelledAt: T1,
    });
    // Admitting under "middle" must find the cancelled root ancestor —
    // even though middle's own edge is now closed (ancestry survives).
    expect(() => edge(edges, "late", "middle", "/root/middle")).toThrow(
      SpawnAdmissionBlockedError,
    );
  });

  it("allows live/import parents but rejects an unresolved parent", () => {
    const edges = new ThreadSpawnEdgeRepository(driver);
    run("live_parent", "running");
    edge(edges, "child_ok", "live_parent", "/root");
    expect(edgeStatusOf("child_ok")).toBe("open");
    // No run row anywhere up the chain: ancestry remains unproved.
    expect(() =>
      edge(edges, "orphan_child", "unknown_thread", "/root"),
    ).toThrow(expect.objectContaining({ reason: "ancestor_unresolved" }));
    expect(edgeStatusOf("orphan_child")).toBeUndefined();
    // Import mode records historical topology even under a cancelled run.
    cancelAgentRunTree(driver, {
      runId: "live_parent",
      reason: "r",
      cancelledAt: T1,
    });
    edge(edges, "historic_child", "live_parent", "/root", {
      admissionGate: "import",
    });
    expect(edgeStatusOf("historic_child")).toBe("open");
  });

  it("accepts a canonical rollout lifecycle root as durable identity", () => {
    const durability = new StateRunDurabilityRepository(driver);
    const edges = new ThreadSpawnEdgeRepository(driver);
    durability.ensureInitialEpoch({
      runId: "rollout_root",
      openedAt: T0,
    });

    expect(
      checkSpawnAdmissionGate(driver, { parentThreadId: "rollout_root" }),
    ).toEqual({ allowed: true });
    edge(edges, "rollout_child", "rollout_root", "/root");
    expect(edgeStatusOf("rollout_child")).toBe("open");
  });

  it("allows depth 64 but denies depth 65 with a stable fail-closed reason", () => {
    const edges = new ThreadSpawnEdgeRepository(driver);
    const seedDepth = (prefix: string, depth: number): string => {
      const rootId = `${prefix}_0`;
      run(rootId, "running");
      let parentId = rootId;
      for (let index = 1; index <= depth; index++) {
        const childId = `${prefix}_${index}`;
        edge(edges, childId, parentId, `/root/${parentId}`, {
          admissionGate: "import",
        });
        parentId = childId;
      }
      return parentId;
    };
    const atBound = seedDepth("depth_ok", MAX_ANCESTOR_WALK);
    expect(
      checkSpawnAdmissionGate(driver, { parentThreadId: atBound }),
    ).toEqual({ allowed: true });
    const overBound = seedDepth("depth_deny", MAX_ANCESTOR_WALK + 1);
    expect(
      checkSpawnAdmissionGate(driver, { parentThreadId: overBound }),
    ).toMatchObject({
      allowed: false,
      decision: "deny",
      reason: "ancestor_depth_exceeded",
      parentStatus: "unproved",
    });
  });

  it("denies corrupt ancestor cycles instead of treating deduplication as proof", () => {
    const edges = new ThreadSpawnEdgeRepository(driver);
    run("cycle_a", "running");
    run("cycle_b", "running");
    edge(edges, "cycle_b", "cycle_a", "/root", {
      admissionGate: "import",
    });
    edge(edges, "cycle_a", "cycle_b", "/root/cycle_b", {
      admissionGate: "import",
    });

    expect(
      checkSpawnAdmissionGate(driver, { parentThreadId: "cycle_a" }),
    ).toEqual({
      allowed: false,
      decision: "deny",
      reason: "ancestor_cycle",
      parentRunId: "cycle_a",
      parentStatus: "unproved",
    });
  });
});

describe("cancel-lock stickiness", () => {
  it("refuses to move a cancelled run to a different status via update or upsert", () => {
    run("victim", "running");
    cancelAgentRunTree(driver, {
      runId: "victim",
      reason: "r",
      cancelledAt: T1,
    });

    const updated = updateAgentRunStatus(driver, {
      id: "victim",
      status: "running",
      lastActiveAt: T1,
    });
    expect(updated).toEqual({
      applied: false,
      reason: "cancel_locked_status_sticky",
      existingStatus: "cancelled",
    });
    const upserted = upsertAgentRun(driver, {
      id: "victim",
      objective: "victim",
      status: "errored",
      startedAt: T0,
      lastActiveAt: T1,
    });
    expect(upserted.applied).toBe(false);
    expect(statusOf("victim")).toBe("cancelled");

    // Same-status writes still land (metadata patches on the record).
    const sameStatus = updateAgentRunStatus(driver, {
      id: "victim",
      status: "cancelled",
      lastActiveAt: T1,
      metadataPatch: { note: "reviewed" },
    });
    expect(sameStatus.applied).toBe(true);
  });

  it("keeps completed runs revivable (follow-up-message flow)", () => {
    run("finished", "completed");
    const revived = updateAgentRunStatus(driver, {
      id: "finished",
      status: "running",
      lastActiveAt: T1,
    });
    expect(revived.applied).toBe(true);
    expect(statusOf("finished")).toBe("running");
  });
});

describe("recovery interplay", () => {
  it("finishes a crash-interrupted cascade instead of resurrecting survivors", () => {
    const edges = new ThreadSpawnEdgeRepository(driver);
    run("parent", "running");
    run("survivor", "running");
    edge(edges, "survivor", "parent", "/root");
    // Simulate a crash mid-cascade: parent cancelled, descendant missed.
    updateAgentRunStatus(driver, {
      id: "parent",
      status: "cancelled",
      lastActiveAt: T1,
    });
    expect(statusOf("survivor")).toBe("running");

    const report = recoverDaemonStateOnStartup(driver, { now: () => T1 });
    expect(statusOf("survivor")).toBe("cancelled");
    expect(report.recoveredRuns.map((r) => r.id)).not.toContain("survivor");
    expect(report.recoveredRuns.map((r) => r.id)).not.toContain("parent");
  });

  it("repair is one-shot: a later legitimately revived descendant is never re-killed", () => {
    const edges = new ThreadSpawnEdgeRepository(driver);
    run("parent", "running");
    run("done_child", "completed");
    edge(edges, "done_child", "parent", "/root");
    // Cascade cancel: parent stamped cascadeComplete, completed child kept.
    cancelAgentRunTree(driver, {
      runId: "parent",
      reason: "r",
      cancelledAt: T1,
    });
    // The completed child is later legitimately revived (follow-up message).
    expect(
      updateAgentRunStatus(driver, {
        id: "done_child",
        status: "running",
        lastActiveAt: T1,
      }).applied,
    ).toBe(true);
    // Startup repair must NOT re-kill it — the cascade already completed.
    recoverDaemonStateOnStartup(driver, { now: () => T1 });
    expect(statusOf("done_child")).toBe("running");
  });

  it("non-cascade cancels are repaired exactly once, then the tree is left alone", () => {
    const edges = new ThreadSpawnEdgeRepository(driver);
    run("parent", "running");
    run("survivor", "running");
    run("done_child", "completed");
    edge(edges, "survivor", "parent", "/root");
    edge(edges, "done_child", "parent", "/root");
    // Non-cascade cancel writer (e.g. relayed status transition).
    updateAgentRunStatus(driver, {
      id: "parent",
      status: "cancelled",
      lastActiveAt: T1,
    });
    // First startup: survivor finished off, root stamped.
    recoverDaemonStateOnStartup(driver, { now: () => T1 });
    expect(statusOf("survivor")).toBe("cancelled");
    expect(admissions.isRunCancellationLocked("parent")).toBe(true);
    expect(admissions.isRunCancellationLocked("survivor")).toBe(true);
    // Completed child revived after the one-shot repair...
    updateAgentRunStatus(driver, {
      id: "done_child",
      status: "running",
      lastActiveAt: T1,
    });
    expect(admissions.isRunCancellationLocked("done_child")).toBe(false);
    // ...survives every subsequent startup.
    recoverDaemonStateOnStartup(driver, { now: () => T1 });
    expect(statusOf("done_child")).toBe("running");
  });

  it("repairs only descendants of cancelled ancestors, not completed ones", () => {
    const edges = new ThreadSpawnEdgeRepository(driver);
    run("done_parent", "completed");
    run("legit_child", "running");
    edge(edges, "legit_child", "done_parent", "/root");
    const repair = repairCancelledSubtrees(driver, admissions, { now: T1 });
    expect(repair.repairedRunIds).toEqual([]);
    expect(statusOf("legit_child")).toBe("running");
    const report = recoverDaemonStateOnStartup(driver, { now: () => T1 });
    expect(report.recoveredRuns.map((r) => r.id)).toContain("legit_child");
  });

  it("repairs overlapping roots as one union and stamps markers only after success", () => {
    const edges = new ThreadSpawnEdgeRepository(driver);
    run("repair_root", "running");
    run("repair_nested_root", "running");
    run("repair_leaf", "running");
    edge(edges, "repair_nested_root", "repair_root", "/root");
    edge(
      edges,
      "repair_leaf",
      "repair_nested_root",
      "/root/repair_nested_root",
    );
    updateAgentRunStatus(driver, {
      id: "repair_root",
      status: "cancelled",
      lastActiveAt: T1,
    });
    updateAgentRunStatus(driver, {
      id: "repair_nested_root",
      status: "cancelled",
      lastActiveAt: T1,
    });
    driver
      .prepareState(
        `CREATE TRIGGER fail_repair_leaf
         BEFORE UPDATE OF status ON agent_runs
         WHEN OLD.id = 'repair_leaf'
         BEGIN
           SELECT RAISE(ABORT, 'fault-injected repair failure');
         END`,
      )
      .run();

    expect(() => repairCancelledSubtrees(driver, admissions, { now: T1 })).toThrow(
      /fault-injected repair failure/u,
    );
    for (const rootId of ["repair_root", "repair_nested_root"]) {
      const metadata = driver
        .prepareState<[string], { readonly metadata_json: string | null }>(
          "SELECT metadata_json FROM agent_runs WHERE id = ?",
        )
        .get(rootId)?.metadata_json;
      expect(JSON.parse(metadata ?? "{}").cascadeComplete).not.toBe(true);
    }
    expect(statusOf("repair_leaf")).toBe("running");
    expect(
      driver
        .prepareState<[], { readonly count: number }>(
          `SELECT COUNT(*) AS count
           FROM temp.agenc_cancellation_operation_runs`,
        )
        .get()?.count,
    ).toBe(0);

    driver.prepareState("DROP TRIGGER fail_repair_leaf").run();
    expect(repairCancelledSubtrees(driver, admissions, { now: T1 })).toEqual({
      repairedRunIds: ["repair_leaf"],
    });
    expect(statusOf("repair_leaf")).toBe("cancelled");
    for (const rootId of ["repair_root", "repair_nested_root"]) {
      const metadata = driver
        .prepareState<[string], { readonly metadata_json: string | null }>(
          "SELECT metadata_json FROM agent_runs WHERE id = ?",
        )
        .get(rootId)?.metadata_json;
      expect(JSON.parse(metadata ?? "{}").cascadeComplete).toBe(true);
    }
    expect(repairCancelledSubtrees(driver, admissions, { now: T1 })).toEqual({
      repairedRunIds: [],
    });
  });

  it("stamps exactly the repair-root bound and defers plus one before mutation", () => {
    const seedCancelledRoots = (prefix: string, count: number): void => {
      driver
        .prepareState<[number, string, string]>(
          `WITH RECURSIVE sequence(value) AS (
             VALUES (1)
             UNION ALL
             SELECT value + 1 FROM sequence WHERE value < ?
           )
           INSERT INTO agent_runs (
             id, objective, status, started_at, last_active_at, metadata_json
           )
           SELECT printf('${prefix}_%05d', value), 'repair bound',
                  'cancelled', ?, ?, NULL
           FROM sequence`,
        )
        .run(count, T0, T0);
    };
    seedCancelledRoots("at_repair_bound", MAX_CANCELLATION_REPAIR_ROOTS);
    expect(repairCancelledSubtrees(driver, admissions, { now: T1 })).toEqual({
      repairedRunIds: [],
    });
    expect(
      driver
        .prepareState<[], { readonly count: number }>(
          `SELECT COUNT(*) AS count FROM agent_runs
           WHERE id LIKE 'at_repair_bound_%'
             AND json_extract(metadata_json, '$.cascadeComplete') = 1`,
        )
        .get()?.count,
    ).toBe(MAX_CANCELLATION_REPAIR_ROOTS);

    seedCancelledRoots("over_repair_bound", MAX_CANCELLATION_REPAIR_ROOTS + 1);
    expect(() => repairCancelledSubtrees(driver, admissions, { now: T1 })).toThrow(
      expect.objectContaining<Partial<CancellationRepairDeferredError>>({
        code: "CANCELLATION_REPAIR_DEFERRED",
        reason: "repair_root_limit",
      }),
    );
    expect(
      driver
        .prepareState<[], { readonly count: number }>(
          `SELECT COUNT(*) AS count FROM agent_runs
           WHERE id LIKE 'over_repair_bound_%'
             AND metadata_json IS NOT NULL`,
        )
        .get()?.count,
    ).toBe(0);
  });
});

describe("state import over a cancel-locked run", () => {
  it("refuses atomically instead of half-applying session-state replacement", () => {
    run("locked_run", "running");
    const payload = exportAgentState(driver, "locked_run", { now: () => T0 });
    cancelAgentRunTree(driver, {
      runId: "locked_run",
      reason: "r",
      cancelledAt: T1,
    });
    expect(() =>
      importAgentState(driver, payload, { agencHome: home }),
    ).toThrow(/review-locked/);
    // The refusal rolled the whole transaction back: run row untouched.
    expect(statusOf("locked_run")).toBe("cancelled");
  });
});
