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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cancelAgentRunTree,
  checkSpawnAdmissionGate,
  repairCancelledSubtrees,
  SpawnAdmissionBlockedError,
} from "../../src/state/run-cancellation.js";
import {
  upsertAgentRun,
  updateAgentRunStatus,
} from "../../src/state/agent-runs.js";
import { ThreadSpawnEdgeRepository } from "../../src/state/spawn-edges.js";
import { recordInFlightToolCallStart } from "../../src/state/tool-output-rotation.js";
import {
  exportAgentState,
  importAgentState,
} from "../../src/state/export-import.js";
import { recoverDaemonStateOnStartup } from "../../src/state/recovery.js";
import { BudgetLedger } from "../../src/budget/ledger.js";
import {
  openStateDatabases,
  type StateSqliteDriver,
} from "../../src/state/sqlite-driver.js";

let home: string;
let cwd: string;
let driver: StateSqliteDriver;

const T0 = "2026-07-18T00:00:00.000Z";
const T1 = "2026-07-18T00:05:00.000Z";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agenc-run-cancel-home-"));
  cwd = mkdtempSync(join(tmpdir(), "agenc-run-cancel-cwd-"));
  mkdirSync(join(cwd, ".git"));
  driver = openStateDatabases({ cwd, agencHome: home });
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
      metadata: { agentId: childId, agentPath: `${parentPath}/${childId}`, depth },
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
    for (const id of ["parent", "child_running", "child_queued", "grandchild"]) {
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
});

describe("spawn admission gate", () => {
  it("refuses a new edge under a cancelled parent with the typed error, and only then", () => {
    const edges = new ThreadSpawnEdgeRepository(driver);
    run("parent", "running");
    edge(edges, "ok_child", "parent", "/root");
    cancelAgentRunTree(driver, { runId: "parent", reason: "r", cancelledAt: T1 });

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

  it("allows spawns under live parents, unknown parents, and in import mode", () => {
    const edges = new ThreadSpawnEdgeRepository(driver);
    run("live_parent", "running");
    edge(edges, "child_ok", "live_parent", "/root");
    expect(edgeStatusOf("child_ok")).toBe("open");
    // No run row anywhere up the chain: nothing durable to gate on.
    edge(edges, "orphan_child", "unknown_thread", "/root");
    expect(edgeStatusOf("orphan_child")).toBe("open");
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
});

describe("cancel-lock stickiness", () => {
  it("refuses to move a cancelled run to a different status via update or upsert", () => {
    run("victim", "running");
    cancelAgentRunTree(driver, { runId: "victim", reason: "r", cancelledAt: T1 });

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
    cancelAgentRunTree(driver, { runId: "parent", reason: "r", cancelledAt: T1 });
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
    // Completed child revived after the one-shot repair...
    updateAgentRunStatus(driver, {
      id: "done_child",
      status: "running",
      lastActiveAt: T1,
    });
    // ...survives every subsequent startup.
    recoverDaemonStateOnStartup(driver, { now: () => T1 });
    expect(statusOf("done_child")).toBe("running");
  });

  it("repairs only descendants of cancelled ancestors, not completed ones", () => {
    const edges = new ThreadSpawnEdgeRepository(driver);
    run("done_parent", "completed");
    run("legit_child", "running");
    edge(edges, "legit_child", "done_parent", "/root");
    const repair = repairCancelledSubtrees(driver, { now: T1 });
    expect(repair.repairedRunIds).toEqual([]);
    expect(statusOf("legit_child")).toBe("running");
    const report = recoverDaemonStateOnStartup(driver, { now: () => T1 });
    expect(report.recoveredRuns.map((r) => r.id)).toContain("legit_child");
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
    expect(() => importAgentState(driver, payload, { agencHome: home })).toThrow(
      /review-locked/,
    );
    // The refusal rolled the whole transaction back: run row untouched.
    expect(statusOf("locked_run")).toBe("cancelled");
  });
});

describe("BudgetLedger.voidHoldsForAgent", () => {
  it("releases open holds without touching recorded spend", () => {
    const ledger = new BudgetLedger({
      agencHome: home,
      now: () => new Date("2026-07-18T00:10:00.000Z"),
    });
    ledger.addSpend("worker", 0.5, 1_000);
    const reserved = ledger.tryReserve(
      {
        holdId: "hold-void-1",
        agentId: "worker",
        model: "test-model",
        estimatedUsd: 2,
        estimatedTokens: 4_000,
        reservedAt: "2026-07-18T00:10:00.000Z",
      },
      () => null,
    );
    expect(reserved.reserved).toBe(true);
    expect(ledger.listOpenHolds("worker")).toHaveLength(1);
    expect(ledger.snapshot("worker").day.usd).toBeCloseTo(2.5, 10);

    expect(ledger.voidHoldsForAgent("worker")).toBe(1);
    expect(ledger.listOpenHolds("worker")).toHaveLength(0);
    // Spend recorded before the hold is untouched; only the reservation
    // debit was refunded.
    expect(ledger.snapshot("worker").day.usd).toBeCloseTo(0.5, 10);
    // Voiding again is a no-op.
    expect(ledger.voidHoldsForAgent("worker")).toBe(0);
  });

  it("refunds the month window for a hold whose day already rolled (voided = full refund)", () => {
    let now = new Date("2026-07-18T23:50:00.000Z");
    const ledger = new BudgetLedger({ agencHome: home, now: () => now });
    const reserved = ledger.tryReserve(
      {
        holdId: "hold-rolled-1",
        agentId: "worker",
        model: "test-model",
        estimatedUsd: 4,
        estimatedTokens: 8_000,
        reservedAt: now.toISOString(),
      },
      () => null,
    );
    expect(reserved.reserved).toBe(true);
    expect(ledger.snapshot("worker").month.usd).toBeCloseTo(4, 10);
    // The day rolls (same month): the day debit is zeroed by the roll,
    // but the month window still carries the hold's debit.
    now = new Date("2026-07-19T00:10:00.000Z");
    expect(ledger.voidHoldsForAgent("worker")).toBe(1);
    expect(ledger.snapshot("worker").day.usd).toBeCloseTo(0, 10);
    // `voided` is a FULL refund: the month debit is released too — unlike
    // consumeHold's window_rolled, which keeps it (unknown usage).
    expect(ledger.snapshot("worker").month.usd).toBeCloseTo(0, 10);
  });
});
