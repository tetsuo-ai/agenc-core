import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RuntimeAdmissionRequest } from "../../src/budget/admission-types.js";
import { admissionRecordKey } from "../../src/budget/admission-types.js";
import {
  upsertAgentRun,
  updateAgentRunStatus,
} from "../../src/state/agent-runs.js";
import { ExecutionAdmissionRepository } from "../../src/state/execution-admission.js";
import {
  cancelRunTreeAndAdmission,
  reconcileAdmissionAndRunTree,
} from "../../src/state/run-admission-cancellation.js";
import {
  cancelAgentRunTree,
  repairCancelledSubtrees,
} from "../../src/state/run-cancellation.js";
import { ThreadSpawnEdgeRepository } from "../../src/state/spawn-edges.js";
import {
  openStateDatabases,
  type StateSqliteDriver,
} from "../../src/state/sqlite-driver.js";

const NOW = "2026-07-18T12:00:00.000Z";

let home = "";
let cwd = "";
let driver: StateSqliteDriver;
let admissions: ExecutionAdmissionRepository;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agenc-atomic-cancel-home-"));
  cwd = mkdtempSync(join(tmpdir(), "agenc-atomic-cancel-cwd-"));
  mkdirSync(join(cwd, ".git"));
  driver = openStateDatabases({ cwd, agencHome: home });
  admissions = new ExecutionAdmissionRepository(driver, {
    now: () => new Date(NOW),
    ownerId: "atomic-cancel-test",
    ownerPid: 42,
  });
});

afterEach(() => {
  driver.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

function seedRun(runId: string): void {
  upsertAgentRun(driver, {
    id: runId,
    objective: "atomic cancellation",
    status: "running",
    startedAt: NOW,
    lastActiveAt: NOW,
  });
}

function request(
  runId: string,
  stepId: string,
  parentRunId?: string,
): RuntimeAdmissionRequest {
  return {
    step: {
      runId,
      stepId,
      ...(parentRunId === undefined ? {} : { parentRunId }),
    },
    kind: "model_turn",
    estimate: {
      maxInputTokens: 5,
      maxOutputTokens: 5,
      maxCostUsd: 0.01,
    },
    workspaceId: "workspace",
    sessionId: runId,
    autonomous: true,
    budgetScopes: [{ key: `run:${runId}`, maxTokens: 100, maxCostUsd: 1 }],
  };
}

describe("atomic run/admission cancellation", () => {
  it("does not create admission state when the public run id is unknown", () => {
    const tableCounts = (): Record<string, number> =>
      Object.fromEntries(
        [
          "agent_jobs",
          "execution_admission_reservations",
          "execution_admission_allocations",
          "execution_admission_cancellations",
          "execution_admission_journal",
        ].map((table) => [
          table,
          driver
            .prepareState<[], { readonly count: number }>(
              `SELECT COUNT(*) AS count FROM ${table}`,
            )
            .get()?.count ?? 0,
        ]),
      );
    const before = tableCounts();

    const result = cancelRunTreeAndAdmission(driver, admissions, {
      runId: "unknown-run",
      reason: "operator_cancel",
      cancelledAt: NOW,
    });

    expect(result.run.missing).toBe(true);
    expect(result.admission.affectedRunIds).toEqual([]);
    expect(tableCounts()).toEqual(before);
  });

  it("cancels an admission-only public run", () => {
    const admission = request("admission-only-run", "turn-1");
    admissions.enqueue(admission);

    const result = cancelRunTreeAndAdmission(driver, admissions, {
      runId: "admission-only-run",
      reason: "operator_cancel",
      cancelledAt: NOW,
    });

    expect(result.run).toMatchObject({
      missing: false,
      admissionOnly: true,
      subtreeRunIds: ["admission-only-run"],
    });
    expect(result.admission.affectedRunIds).toEqual(["admission-only-run"]);
    expect(admissions.get(admissionRecordKey(admission.step))?.status).toBe(
      "cancelled",
    );
    expect(
      driver
        .prepareState<[string], { readonly reason: string }>(
          "SELECT reason FROM execution_admission_cancellations WHERE run_id = ?",
        )
        .get("admission-only-run")?.reason,
    ).toBe("operator_cancel");

    const repeated = cancelRunTreeAndAdmission(driver, admissions, {
      runId: "admission-only-run",
      reason: "operator_cancel_again",
      cancelledAt: NOW,
    });
    expect(repeated.run).toMatchObject({
      missing: false,
      admissionOnly: true,
      alreadyTerminal: true,
      rootStatusBefore: "cancelled",
      cancelledRunIds: [],
    });
  });

  it("commits the run lock and reservation settlement together", () => {
    seedRun("atomic-run");
    const admission = request("atomic-run", "turn-1");
    admissions.enqueue(admission);
    const claim = admissions.claim({ key: admissionRecordKey(admission.step) });
    if (claim.kind !== "claimed") throw new Error("expected admission claim");

    const result = cancelRunTreeAndAdmission(driver, admissions, {
      runId: "atomic-run",
      reason: "operator_cancel",
      cancelledAt: NOW,
    });

    expect(result.run.cancelledRunIds).toEqual(["atomic-run"]);
    expect(result.admission.voidedReservationIds).toEqual([
      claim.lease.reservation.reservationId,
    ]);
    expect(
      driver
        .prepareState<[string], { status: string }>(
          "SELECT status FROM agent_runs WHERE id = ?",
        )
        .get("atomic-run")?.status,
    ).toBe("cancelled");
    expect(
      admissions.getReservation(claim.lease.reservation.reservationId)?.status,
    ).toBe("voided");
  });

  it("keeps spawn reporting spawn-only while admission cancellation uses the graph union", () => {
    seedRun("graph-root");
    const admissionChild = request(
      "admission-only-child",
      "turn-1",
      "graph-root",
    );
    expect(admissions.enqueue(admissionChild).record.status).toBe("queued");

    const spawnOnly = cancelAgentRunTree(driver, {
      runId: "graph-root",
      reason: "spawn-only-contract",
      cancelledAt: NOW,
    });
    expect(spawnOnly.subtreeRunIds).toEqual(["graph-root"]);
    expect(
      admissions.get(admissionRecordKey(admissionChild.step))?.status,
    ).toBe("queued");

    const combined = cancelRunTreeAndAdmission(driver, admissions, {
      runId: "graph-root",
      reason: "admission-union-contract",
      cancelledAt: NOW,
    });
    expect(combined.run.subtreeRunIds).toEqual(["graph-root"]);
    expect(combined.admission.affectedRunIds).toEqual([
      "graph-root",
      "admission-only-child",
    ]);
    expect(
      admissions.get(admissionRecordKey(admissionChild.step))?.status,
    ).toBe("cancelled");
  });

  it("rolls the agent-run cascade back when admission settlement fails", () => {
    seedRun("rollback-run");
    const admission = request("rollback-run", "turn-1");
    admissions.enqueue(admission);
    const claim = admissions.claim({ key: admissionRecordKey(admission.step) });
    if (claim.kind !== "claimed") throw new Error("expected admission claim");
    driver
      .prepareState(
        `CREATE TRIGGER reject_admission_cancel
       BEFORE UPDATE ON execution_admission_reservations
       BEGIN
         SELECT RAISE(ABORT, 'fault-injected admission failure');
       END`,
      )
      .run();

    expect(() =>
      cancelRunTreeAndAdmission(driver, admissions, {
        runId: "rollback-run",
        reason: "operator_cancel",
        cancelledAt: NOW,
      }),
    ).toThrow(/fault-injected admission failure/);
    expect(
      driver
        .prepareState<[string], { status: string }>(
          "SELECT status FROM agent_runs WHERE id = ?",
        )
        .get("rollback-run")?.status,
    ).toBe("running");
    expect(
      admissions.getReservation(claim.lease.reservation.reservationId)?.status,
    ).toBe("reserved");
  });

  it("repairs overlapping roots, locks the admission union, and rolls every projection back on a late failure", () => {
    const edges = new ThreadSpawnEdgeRepository(driver);
    for (const runId of ["repair_root", "repair_nested", "repair_leaf"]) {
      seedRun(runId);
    }
    edges.create(
      {
        childThreadId: "repair_nested",
        parentThreadId: "repair_root",
        parentPath: "/root",
        metadata: {
          agentId: "repair_nested",
          agentPath: "/root/repair_nested",
          depth: 1,
        },
        status: "open",
      },
      { admissionGate: "import" },
    );
    edges.create(
      {
        childThreadId: "repair_leaf",
        parentThreadId: "repair_nested",
        parentPath: "/root/repair_nested",
        metadata: {
          agentId: "repair_leaf",
          agentPath: "/root/repair_nested/repair_leaf",
          depth: 2,
        },
        status: "open",
      },
      { admissionGate: "import" },
    );

    const reservedRequest = request(
      "repair_leaf",
      "reserved-step",
      "repair_nested",
    );
    const dispatchedRequest = request(
      "repair_admission_only",
      "dispatched-step",
      "repair_nested",
    );
    admissions.enqueue(reservedRequest);
    admissions.enqueue(dispatchedRequest);
    const reservedClaim = admissions.claim({
      key: admissionRecordKey(reservedRequest.step),
    });
    const dispatchedClaim = admissions.claim({
      key: admissionRecordKey(dispatchedRequest.step),
    });
    if (reservedClaim.kind !== "claimed") {
      throw new Error("expected reserved repair claim");
    }
    if (dispatchedClaim.kind !== "claimed") {
      throw new Error("expected dispatched repair claim");
    }
    admissions.markDispatched(
      dispatchedClaim.lease.reservation.reservationId,
    );
    for (const runId of ["repair_root", "repair_nested"]) {
      updateAgentRunStatus(driver, {
        id: runId,
        status: "cancelled",
        lastActiveAt: NOW,
      });
    }
    driver
      .prepareState(
        `CREATE TRIGGER reject_final_repair_marker
         BEFORE UPDATE OF metadata_json ON agent_runs
         WHEN OLD.id = 'repair_root'
          AND json_extract(NEW.metadata_json, '$.cascadeComplete') = 1
         BEGIN
           SELECT RAISE(ABORT, 'fault-injected final repair failure');
         END`,
      )
      .run();

    expect(() =>
      repairCancelledSubtrees(driver, admissions, { now: NOW }),
    ).toThrow(/fault-injected final repair failure/u);
    expect(
      driver
        .prepareState<[], { readonly count: number }>(
          `SELECT COUNT(*) AS count
           FROM execution_admission_cancellations
           WHERE run_id IN (
             'repair_root', 'repair_nested', 'repair_leaf',
             'repair_admission_only'
           )`,
        )
        .get()?.count,
    ).toBe(0);
    expect(
      admissions.getReservation(
        reservedClaim.lease.reservation.reservationId,
      )?.status,
    ).toBe("reserved");
    expect(
      admissions.getReservation(
        dispatchedClaim.lease.reservation.reservationId,
      )?.status,
    ).toBe("dispatched");
    expect(
      admissions.get(admissionRecordKey(reservedRequest.step))?.status,
    ).toBe("running");
    expect(
      admissions.get(admissionRecordKey(dispatchedRequest.step))?.status,
    ).toBe("running");
    for (const runId of ["repair_root", "repair_nested"]) {
      const metadata = driver
        .prepareState<[string], { readonly metadata_json: string | null }>(
          "SELECT metadata_json FROM agent_runs WHERE id = ?",
        )
        .get(runId)?.metadata_json;
      expect(JSON.parse(metadata ?? "{}").cascadeComplete).not.toBe(true);
    }
    expect(
      driver
        .prepareState<[string], { readonly status: string }>(
          "SELECT status FROM agent_runs WHERE id = ?",
        )
        .get("repair_leaf")?.status,
    ).toBe("running");
    expect(edges.get("repair_leaf")?.status).toBe("open");
    expect(
      driver
        .prepareState<[], { readonly count: number }>(
          "SELECT COUNT(*) AS count FROM temp.agenc_cancellation_operation_runs",
        )
        .get()?.count,
    ).toBe(0);

    driver.prepareState("DROP TRIGGER reject_final_repair_marker").run();
    expect(
      repairCancelledSubtrees(driver, admissions, { now: NOW }),
    ).toEqual({ repairedRunIds: ["repair_leaf"] });
    expect(
      driver
        .prepareState<
          [],
          { readonly run_id: string; readonly reason: string }
        >(
          `SELECT run_id, reason FROM execution_admission_cancellations
           WHERE run_id IN (
             'repair_root', 'repair_nested', 'repair_leaf',
             'repair_admission_only'
           )
           ORDER BY run_id COLLATE BINARY`,
        )
        .all(),
    ).toEqual([
      {
        run_id: "repair_admission_only",
        reason: "recovery_cascade_repair",
      },
      { run_id: "repair_leaf", reason: "recovery_cascade_repair" },
      { run_id: "repair_nested", reason: "recovery_cascade_repair" },
      { run_id: "repair_root", reason: "recovery_cascade_repair" },
    ]);
    expect(
      admissions.getReservation(
        reservedClaim.lease.reservation.reservationId,
      )?.status,
    ).toBe("voided");
    expect(
      admissions.getReservation(
        dispatchedClaim.lease.reservation.reservationId,
      )?.status,
    ).toBe("held_unknown");
    expect(
      admissions.get(admissionRecordKey(reservedRequest.step))?.status,
    ).toBe("voided");
    expect(
      admissions.get(admissionRecordKey(dispatchedRequest.step))?.status,
    ).toBe("held_unknown");
    expect(
      admissions.listAllocations().find(
        (allocation) => allocation.key === "run:repair_admission_only",
      ),
    ).toMatchObject({
      heldTokens: 0,
      usedTokens: 10,
      heldCostUsd: 0,
      usedCostUsd: 0.01,
    });
    expect(edges.get("repair_leaf")?.status).toBe("closed");
    for (const runId of ["repair_root", "repair_nested"]) {
      const metadata = driver
        .prepareState<[string], { readonly metadata_json: string | null }>(
          "SELECT metadata_json FROM agent_runs WHERE id = ?",
        )
        .get(runId)?.metadata_json;
      expect(JSON.parse(metadata ?? "{}").cascadeComplete).toBe(true);
    }
  });

  it("repairs a previously committed provider overrun on duplicate reconciliation", () => {
    seedRun("legacy-overrun-run");
    const admission = request("legacy-overrun-run", "turn-1");
    admissions.enqueue(admission);
    const claim = admissions.claim({ key: admissionRecordKey(admission.step) });
    if (claim.kind !== "claimed") throw new Error("expected admission claim");
    admissions.markDispatched(claim.lease.reservation.reservationId);

    // Model the old two-transaction crash point: admission accounting landed,
    // but the canonical agent run was never cascaded.
    expect(
      admissions.reconcile(claim.lease.reservation.reservationId, {
        kind: "reported",
        usage: { inputTokens: 6, outputTokens: 5, costUsd: 0.02 },
      }),
    ).toMatchObject({ applied: true, outcome: "provider_overrun" });
    expect(
      driver
        .prepareState<[string], { readonly status: string }>(
          "SELECT status FROM agent_runs WHERE id = ?",
        )
        .get("legacy-overrun-run")?.status,
    ).toBe("running");

    const repaired = reconcileAdmissionAndRunTree(driver, admissions, {
      reservationId: claim.lease.reservation.reservationId,
      input: {
        kind: "reported",
        usage: { inputTokens: 6, outputTokens: 5, costUsd: 0.02 },
      },
      reconciledAt: NOW,
    });

    expect(repaired.admission).toEqual({
      applied: false,
      outcome: "duplicate",
      existingStatus: "provider_overrun",
    });
    expect(repaired.run?.cancelledRunIds).toEqual(["legacy-overrun-run"]);
    expect(
      driver
        .prepareState<[string], { readonly status: string }>(
          "SELECT status FROM agent_runs WHERE id = ?",
        )
        .get("legacy-overrun-run")?.status,
    ).toBe("cancelled");
  });
});
