import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RuntimeAdmissionRequest } from "../../src/budget/admission-types.js";
import { admissionRecordKey } from "../../src/budget/admission-types.js";
import { upsertAgentRun } from "../../src/state/agent-runs.js";
import { ExecutionAdmissionRepository } from "../../src/state/execution-admission.js";
import {
  cancelRunTreeAndAdmission,
  reconcileAdmissionAndRunTree,
} from "../../src/state/run-admission-cancellation.js";
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

function request(runId: string, stepId: string): RuntimeAdmissionRequest {
  return {
    step: { runId, stepId },
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

  it("rolls the agent-run cascade back when admission settlement fails", () => {
    seedRun("rollback-run");
    const admission = request("rollback-run", "turn-1");
    admissions.enqueue(admission);
    const claim = admissions.claim({ key: admissionRecordKey(admission.step) });
    if (claim.kind !== "claimed") throw new Error("expected admission claim");
    driver.prepareState(
      `CREATE TRIGGER reject_admission_cancel
       BEFORE UPDATE ON execution_admission_reservations
       BEGIN
         SELECT RAISE(ABORT, 'fault-injected admission failure');
       END`,
    ).run();

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
