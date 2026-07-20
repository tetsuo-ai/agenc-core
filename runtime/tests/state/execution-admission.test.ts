import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RuntimeAdmissionRequest } from "../../src/budget/admission-types.js";
import { admissionRecordKey } from "../../src/budget/admission-types.js";
import { upsertAgentRun } from "../../src/state/agent-runs.js";
import {
  ExecutionAdmissionRepository,
  NANO_USD_PER_USD,
} from "../../src/state/execution-admission.js";
import { STATE_DB_MIGRATIONS } from "../../src/state/migrations/index.js";
import { cancelAgentRunTree } from "../../src/state/run-cancellation.js";
import {
  applyMigrations,
  openStateDatabases,
  type StateSqliteDriver,
} from "../../src/state/sqlite-driver.js";

const T0 = "2026-07-18T00:00:00.000Z";
const T1 = "2026-07-18T00:01:00.000Z";

let home = "";
let cwd = "";
let driver: StateSqliteDriver;
let now: Date;
let nextId: number;
let admissions: ExecutionAdmissionRepository;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agenc-admission-home-"));
  cwd = mkdtempSync(join(tmpdir(), "agenc-admission-cwd-"));
  mkdirSync(join(cwd, ".git"));
  driver = openStateDatabases({ cwd, agencHome: home });
  now = new Date(T0);
  nextId = 0;
  admissions = new ExecutionAdmissionRepository(driver, {
    now: () => now,
    id: () => `admission-id-${++nextId}`,
    ownerId: "daemon-a",
    ownerPid: 100,
  });
});

afterEach(() => {
  driver.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

function request(
  runId: string,
  stepId: string,
  options: {
    readonly parentRunId?: string;
    readonly input?: number;
    readonly output?: number;
    readonly cost?: number | null;
    readonly deadlineAt?: string;
    readonly scopes?: RuntimeAdmissionRequest["budgetScopes"];
    readonly approvalRequired?: boolean;
    readonly denialReason?: string;
  } = {},
): RuntimeAdmissionRequest {
  return {
    step: {
      runId,
      stepId,
      ...(options.parentRunId !== undefined
        ? { parentRunId: options.parentRunId }
        : {}),
    },
    kind: "model_turn",
    estimate: {
      maxInputTokens: options.input ?? 20,
      maxOutputTokens: options.output ?? 20,
      maxCostUsd: options.cost === undefined ? 0.004 : options.cost,
    },
    model: "test-model",
    provider: "test-provider:https://example.test",
    workspaceId: "workspace-a",
    sessionId: "session-a",
    parentScopeId: options.parentRunId ?? "session-a",
    autonomous: false,
    ...(options.deadlineAt !== undefined
      ? { deadlineAt: options.deadlineAt }
      : {}),
    ...(options.scopes !== undefined ? { budgetScopes: options.scopes } : {}),
    ...(options.approvalRequired !== undefined
      ? { approvalRequired: options.approvalRequired }
      : {}),
    ...(options.denialReason !== undefined
      ? { denialReason: options.denialReason }
      : {}),
  };
}

function claimReservation(key?: string): {
  readonly reservationId: string;
  readonly reservedTokens: number;
} {
  const result = admissions.claim(key === undefined ? {} : { key });
  expect(result.kind).toBe("claimed");
  if (result.kind !== "claimed") throw new Error("expected claimed admission");
  return result.lease.reservation;
}

describe("execution admission schema migration", () => {
  it("extends the existing generic queue additively and preserves legacy rows", () => {
    const db = new Database(":memory:");
    try {
      applyMigrations(
        db,
        STATE_DB_MIGRATIONS.filter((migration) => migration.version < 14),
      );
      db.prepare(
        `INSERT INTO agent_jobs (
          id, kind, status, priority, input_json, created_at, updated_at,
          available_at
        ) VALUES ('legacy-job', 'legacy', 'queued', 7, '{"legacy":true}', ?, ?, ?)`,
      ).run(T0, T0, T0);

      applyMigrations(db, STATE_DB_MIGRATIONS);
      applyMigrations(db, STATE_DB_MIGRATIONS);

      expect(
        db
          .prepare(
            `SELECT id, kind, status, priority, input_json, admission_run_id
             FROM agent_jobs WHERE id = 'legacy-job'`,
          )
          .get(),
      ).toEqual({
        id: "legacy-job",
        kind: "legacy",
        status: "queued",
        priority: 7,
        input_json: '{"legacy":true}',
        admission_run_id: null,
      });
      const tables = db
        .prepare<{ type: string }, { name: string }>(
          `SELECT name FROM sqlite_master
           WHERE type = :type AND name LIKE 'execution_admission_%'
           ORDER BY name ASC`,
        )
        .all({ type: "table" })
        .map((row) => row.name);
      expect(tables).toEqual([
        "execution_admission_allocations",
        "execution_admission_cancellations",
        "execution_admission_journal",
        "execution_admission_reservation_allocations",
        "execution_admission_reservations",
        "execution_admission_run_limits",
      ]);
      expect(
        db
          .prepare("SELECT MAX(version) AS version FROM schema_migrations")
          .get(),
      ).toEqual({ version: 16 });
    } finally {
      db.close();
    }
  });
});

describe("ExecutionAdmissionRepository", () => {
  it("preserves the frozen contract parentScopeId on direct requests", () => {
    const direct = request("run-parent-scope", "turn-1");
    const attempt = admissions.enqueue({
      ...direct,
      parentScopeId: "contract-parent-scope",
    });

    expect(attempt.record.request).toMatchObject({
      parentScopeId: "contract-parent-scope",
    });
    expect(attempt.record.request).not.toHaveProperty("parentId");
  });

  it("persists boundary preflight failures as explicit deny decisions", () => {
    const denied = admissions.enqueue(
      request("run-denied", "model-1", {
        output: 0,
        cost: null,
        denialReason: "unbounded_model_output",
      }),
    );

    expect(denied.decision).toEqual({
      decision: "deny",
      reason: "unbounded_model_output",
    });
    expect(denied.record).toMatchObject({
      status: "denied",
      reason: "unbounded_model_output",
    });
    expect(admissions.listJournal({ runId: "run-denied" })).toMatchObject([
      { event: "denied", reason: "unbounded_model_output" },
    ]);
  });

  it("persists deterministic priority order, idempotent enqueue, and fallback evidence", () => {
    const low = request("run-low", "step-1");
    const high = request("run-high", "step-1");
    const lowAttempt = admissions.enqueue(low, { priority: 1 });
    const highAttempt = admissions.enqueue(high, { priority: 9 });
    expect(lowAttempt.decision.decision).toBe("queue");
    expect(highAttempt.decision.decision).toBe("queue");
    expect(lowAttempt.record.priority).toBe(1);
    expect(highAttempt.record.priority).toBe(9);
    expect(lowAttempt.record.availableAt).toBe(T0);

    const duplicate = admissions.enqueue(low, { priority: 100 });
    expect(duplicate.record.jobId).toBe(lowAttempt.record.jobId);
    expect(duplicate.record.priority).toBe(1);
    expect(admissions.list()).toHaveLength(2);

    const firstClaim = admissions.claim();
    expect(firstClaim.kind).toBe("claimed");
    if (firstClaim.kind === "claimed") {
      expect(firstClaim.lease.request.step.runId).toBe("run-high");
    }
    const fallback = admissions.recordFallback(admissionRecordKey(high.step), {
      reason: "primary_rate_limited",
      model: "fallback-model",
      provider: "fallback-provider:https://fallback.test",
      details: { fromModel: "test-model" },
    });
    expect(fallback).toMatchObject({
      event: "fallback",
      reason: "primary_rate_limited",
      model: "fallback-model",
      provider: "fallback-provider:https://fallback.test",
      details: { fromModel: "test-model" },
    });
    expect(
      admissions.listJournal({ runId: "run-high" }).map((event) => event.event),
    ).toEqual(["queued", "allowed", "fallback"]);
  });

  it("keeps nano-USD normalization idempotent across durable retries", () => {
    const original = request("fractional-cost", "turn-1", {
      cost: 0.000489528,
      scopes: [
        { key: "fractional-cost-budget", maxCostUsd: 0.0004895281 },
      ],
    });

    const first = admissions.enqueue(original);
    const retry = admissions.enqueue(original);

    expect(retry.record.jobId).toBe(first.record.jobId);
    expect(retry.record.request.estimate.maxCostUsd).toBe(0.000489528);
    expect(retry.record.request.budgetScopes).toEqual([
      { key: "fractional-cost-budget", maxCostUsd: 0.000489529 },
    ]);
  });

  it("conserves sibling reservations through hierarchical token and nano-USD allocations", () => {
    const scopes = [
      { key: "root-budget", maxTokens: 100, maxCostUsd: 0.01 },
      {
        key: "child-budget",
        parentKey: "root-budget",
        maxTokens: 100,
        maxCostUsd: 0.01,
      },
    ] as const;
    const first = request("child-a", "turn-1", {
      parentRunId: "root-run",
      input: 20,
      output: 40,
      cost: 0.006,
      scopes,
    });
    const second = request("child-b", "turn-1", {
      parentRunId: "root-run",
      input: 25,
      output: 25,
      cost: 0.005,
      scopes,
    });
    admissions.enqueue(first);
    admissions.enqueue(second);
    const firstReservation = claimReservation(admissionRecordKey(first.step));
    expect(firstReservation.reservedTokens).toBe(60);

    const denied = admissions.claim({ key: admissionRecordKey(second.step) });
    expect(denied).toMatchObject({
      kind: "not_claimed",
      reason: "budget_exceeded",
      record: { status: "denied", reason: "budget_exceeded" },
    });
    for (const allocation of admissions.listAllocations()) {
      expect(allocation.heldTokens).toBe(60);
      expect(allocation.heldCostUsd).toBe(0.006);
      expect(allocation.usedTokens).toBe(0);
    }

    admissions.markDispatched(firstReservation.reservationId, {
      providerRequestId: "provider-request-1",
      details: { boundary: "direct_model", adapter: "test-provider" },
    });
    expect(
      admissions
        .listJournal({ runId: "child-a" })
        .find((event) => event.event === "dispatched")?.details,
    ).toEqual({
      boundary: "direct_model",
      adapter: "test-provider",
      providerRequestId: "provider-request-1",
    });
    const reconciled = admissions.reconcile(firstReservation.reservationId, {
      kind: "reported",
      usage: { inputTokens: 10, outputTokens: 20, costUsd: 0.003 },
      providerRequestId: "provider-request-1",
    });
    expect(reconciled).toEqual({ applied: true, outcome: "reconciled" });
    expect(
      admissions.reconcile(firstReservation.reservationId, {
        kind: "reported",
        usage: { inputTokens: 10, outputTokens: 20, costUsd: 0.003 },
      }),
    ).toEqual({
      applied: false,
      outcome: "duplicate",
      existingStatus: "reconciled",
    });
    for (const allocation of admissions.listAllocations()) {
      expect(allocation.heldTokens).toBe(0);
      expect(allocation.usedTokens).toBe(30);
      expect(allocation.usedCostUsd).toBe(0.003);
    }
    const rawCost = driver
      .prepareState<[], { used_cost_nanos: number }>(
        `SELECT used_cost_nanos FROM execution_admission_allocations
         WHERE scope_key = 'root-budget'`,
      )
      .get();
    expect(rawCost?.used_cost_nanos).toBe(0.003 * NANO_USD_PER_USD);
  });

  it("never overcommits a shared parent across a 100-child fan-out", () => {
    const scopes = [
      { key: "fanout-root", maxTokens: 250, maxCostUsd: 0.25 },
    ] as const;
    const children = Array.from({ length: 100 }, (_, index) =>
      request(`fanout-child-${index}`, "turn-1", {
        parentRunId: "fanout-parent",
        input: 3,
        output: 2,
        cost: 0.005,
        scopes,
      }),
    );
    for (const child of children) admissions.enqueue(child);

    const results = children.map((child) =>
      admissions.claim({ key: admissionRecordKey(child.step) }),
    );
    expect(results.filter((result) => result.kind === "claimed")).toHaveLength(
      50,
    );
    expect(
      results.filter(
        (result) =>
          result.kind === "not_claimed" && result.reason === "budget_exceeded",
      ),
    ).toHaveLength(50);
    expect(admissions.listAllocations()[0]).toMatchObject({
      heldTokens: 250,
      heldCostUsd: 0.25,
      usedTokens: 0,
      usedCostUsd: 0,
    });
  });

  it("denies unpriced work under a hard USD allocation", () => {
    const unpriced = request("run-unpriced", "turn-1", {
      cost: null,
      scopes: [{ key: "hard-usd", maxCostUsd: 1 }],
    });
    admissions.enqueue(unpriced);
    expect(
      admissions.claim({ key: admissionRecordKey(unpriced.step) }),
    ).toMatchObject({
      kind: "not_claimed",
      reason: "unpriced_under_hard_cap",
      record: { status: "denied" },
    });
  });

  it("voids only before dispatch and holds dispatched cancellation unknown", () => {
    const before = request("run-before", "turn-1");
    admissions.enqueue(before);
    const beforeReservation = claimReservation(admissionRecordKey(before.step));
    const beforeCancelled = admissions.cancelStep(
      admissionRecordKey(before.step),
      {
        reason: "caller_aborted",
      },
    );
    expect(beforeCancelled?.status).toBe("voided");
    expect(
      admissions.getReservation(beforeReservation.reservationId)?.status,
    ).toBe("voided");

    const after = request("run-after", "turn-1");
    admissions.enqueue(after);
    const afterReservation = claimReservation(admissionRecordKey(after.step));
    admissions.markDispatched(afterReservation.reservationId);
    const afterCancelled = admissions.cancelStep(
      admissionRecordKey(after.step),
      {
        reason: "caller_aborted",
      },
    );
    expect(afterCancelled?.status).toBe("held_unknown");
    expect(
      admissions.getReservation(afterReservation.reservationId)?.status,
    ).toBe("held_unknown");
    expect(
      admissions
        .listJournal({ runId: "run-after" })
        .map((event) => event.event),
    ).toEqual(["queued", "allowed", "dispatched", "held_unknown", "cancelled"]);
  });

  it("makes provider overrun explicit, blocks the allocation, and cancels descendants", () => {
    const root = request("root-run", "turn-1", {
      input: 5,
      output: 5,
      cost: 0.002,
      scopes: [{ key: "root-overrun-budget", maxTokens: 100, maxCostUsd: 1 }],
    });
    const child = request("child-run", "turn-1", {
      parentRunId: "root-run",
    });
    admissions.enqueue(root);
    admissions.enqueue(child);
    const reservation = claimReservation(admissionRecordKey(root.step));
    admissions.markDispatched(reservation.reservationId);
    const result = admissions.reconcile(reservation.reservationId, {
      kind: "reported",
      usage: { inputTokens: 5, outputTokens: 6, costUsd: 0.003 },
    });
    expect(result).toMatchObject({
      applied: true,
      outcome: "provider_overrun",
      reservedTokens: 10,
      actualTokens: 11,
      reservedCostUsd: 0.002,
      actualCostUsd: 0.003,
    });
    expect(admissions.get(admissionRecordKey(root.step))?.status).toBe(
      "provider_overrun",
    );
    expect(admissions.get(admissionRecordKey(child.step))?.status).toBe(
      "cancelled",
    );
    expect(admissions.listAllocations()[0]).toMatchObject({
      usedTokens: 11,
      usedCostUsd: 0.003,
      blockedByProviderOverrun: true,
    });

    const late = request("root-run", "turn-late");
    expect(admissions.enqueue(late).decision).toEqual({
      decision: "deny",
      reason: "parent_cancel_locked",
    });
  });

  it("retains the full monetary reservation when provider-overrun cost is unknown", () => {
    const overrun = request("unknown-cost-overrun", "turn-1", {
      input: 5,
      output: 5,
      cost: 0.002,
      scopes: [{ key: "unknown-cost-budget", maxCostUsd: 1 }],
    });
    admissions.enqueue(overrun);
    const reservation = claimReservation(admissionRecordKey(overrun.step));
    admissions.markDispatched(reservation.reservationId);

    expect(
      admissions.reportProviderOverrun(reservation.reservationId, {
        inputTokens: 5,
        outputTokens: 5,
        costUsd: null,
      }),
    ).toMatchObject({
      applied: true,
      outcome: "provider_overrun",
      actualCostUsd: null,
    });
    expect(admissions.listAllocations()[0]).toMatchObject({
      usedCostUsd: 0.002,
      heldCostUsd: 0,
      blockedByProviderOverrun: true,
    });

    now = new Date(T1);
    admissions.recover({ now: T1 });
    expect(admissions.listAllocations()[0]).toMatchObject({
      usedCostUsd: 0.002,
      heldCostUsd: 0,
      blockedByProviderOverrun: true,
    });
  });

  it("classifies a known token overrun as provider_overrun even when cost is unknown", () => {
    const overrun = request("unknown-cost-token-overrun", "turn-1", {
      input: 5,
      output: 5,
      cost: 0.002,
      scopes: [{ key: "unknown-cost-token-budget", maxTokens: 100 }],
    });
    admissions.enqueue(overrun);
    const reservation = claimReservation(admissionRecordKey(overrun.step));
    admissions.markDispatched(reservation.reservationId);

    expect(
      admissions.reconcile(reservation.reservationId, {
        kind: "reported",
        usage: { inputTokens: 6, outputTokens: 5, costUsd: null },
      }),
    ).toMatchObject({
      applied: true,
      outcome: "provider_overrun",
      reservedTokens: 10,
      actualTokens: 11,
      actualCostUsd: null,
    });
    expect(admissions.listAllocations()[0]).toMatchObject({
      usedTokens: 11,
      usedCostUsd: 0.002,
      blockedByProviderOverrun: true,
    });
  });

  it("holds unknown cost for an unpriced reservation instead of treating it as free", () => {
    const unknown = request("unpriced-unknown", "turn-1", {
      input: 2,
      output: 3,
      cost: null,
      scopes: [{ key: "unpriced-token-budget", maxTokens: 20 }],
    });
    admissions.enqueue(unknown);
    const reservation = claimReservation(admissionRecordKey(unknown.step));
    admissions.markDispatched(reservation.reservationId);

    expect(
      admissions.reconcile(reservation.reservationId, {
        kind: "reported",
        usage: { inputTokens: 1, outputTokens: 1, costUsd: null },
      }),
    ).toEqual({ applied: true, outcome: "held_unknown" });
    expect(admissions.getReservation(reservation.reservationId)).toMatchObject({
      status: "held_unknown",
      actualTokens: 2,
      actualCostUsd: null,
    });
    expect(admissions.listAllocations()[0]).toMatchObject({
      usedTokens: 5,
      usedCostUsd: 0,
      heldTokens: 0,
    });
  });

  it("replaces a held-unknown full charge when authoritative usage arrives late", () => {
    const late = request("late-usage", "turn-1", {
      input: 10,
      output: 10,
      cost: 0.02,
      scopes: [{ key: "late-usage-budget", maxTokens: 100, maxCostUsd: 1 }],
    });
    admissions.enqueue(late);
    const reservation = claimReservation(admissionRecordKey(late.step));
    admissions.markDispatched(reservation.reservationId);
    expect(
      admissions.holdUnknown(reservation.reservationId, "provider_timeout"),
    ).toEqual({ applied: true, outcome: "held_unknown" });
    expect(admissions.listAllocations()[0]).toMatchObject({
      usedTokens: 20,
      usedCostUsd: 0.02,
    });

    expect(
      admissions.reconcile(reservation.reservationId, {
        kind: "reported",
        usage: { inputTokens: 3, outputTokens: 4, costUsd: 0.007 },
        providerRequestId: "late-provider-id",
      }),
    ).toEqual({ applied: true, outcome: "reconciled" });
    expect(admissions.listAllocations()[0]).toMatchObject({
      usedTokens: 7,
      usedCostUsd: 0.007,
      heldTokens: 0,
      heldCostUsd: 0,
    });
    expect(
      admissions.reconcile(reservation.reservationId, {
        kind: "reported",
        usage: { inputTokens: 3, outputTokens: 4, costUsd: 0.007 },
      }),
    ).toEqual({
      applied: false,
      outcome: "duplicate",
      existingStatus: "reconciled",
    });
    expect(
      admissions
        .listJournal({ runId: "late-usage" })
        .map((event) => event.event),
    ).toEqual([
      "queued",
      "allowed",
      "dispatched",
      "held_unknown",
      "reconciled",
    ]);
  });

  it("makes a late authoritative overrun explicit after held-unknown recovery", () => {
    const late = request("late-overrun", "turn-1", {
      input: 5,
      output: 5,
      cost: 0.01,
      scopes: [{ key: "late-overrun-budget", maxTokens: 100, maxCostUsd: 1 }],
    });
    admissions.enqueue(late);
    const reservation = claimReservation(admissionRecordKey(late.step));
    admissions.markDispatched(reservation.reservationId);
    admissions.holdUnknown(reservation.reservationId, "crash_after_dispatch");

    expect(
      admissions.reconcile(reservation.reservationId, {
        kind: "reported",
        usage: { inputTokens: 7, outputTokens: 7, costUsd: null },
      }),
    ).toMatchObject({
      applied: true,
      outcome: "provider_overrun",
      actualTokens: 14,
      actualCostUsd: null,
    });
    expect(admissions.listAllocations()[0]).toMatchObject({
      usedTokens: 14,
      usedCostUsd: 0.01,
      blockedByProviderOverrun: true,
    });
  });

  it("rejects historical allocation reparenting instead of omitting prior usage", () => {
    const original = request("historical-run", "turn-1", {
      scopes: [{ key: "historical-allocation" }],
    });
    admissions.enqueue(original);
    const reservation = claimReservation(admissionRecordKey(original.step));
    admissions.reconcile(reservation.reservationId, {
      kind: "reported",
      usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.001 },
    });

    const reparented = request("historical-run", "turn-2", {
      scopes: [
        { key: "new-parent", maxTokens: 100 },
        { key: "historical-allocation", parentKey: "new-parent" },
      ],
    });
    admissions.enqueue(reparented);
    expect(() =>
      admissions.claim({ key: admissionRecordKey(reparented.step) }),
    ).toThrow(/conflicting parentKey/);
    expect(admissions.listAllocations()).toMatchObject([
      { key: "historical-allocation", usedTokens: 2 },
    ]);
  });

  it("rejects conflicting provider request identities on repeated dispatch", () => {
    const dispatched = request("dispatch-identity", "turn-1");
    admissions.enqueue(dispatched);
    const reservation = claimReservation(admissionRecordKey(dispatched.step));
    admissions.markDispatched(reservation.reservationId, {
      providerRequestId: "provider-id-a",
    });
    expect(() =>
      admissions.markDispatched(reservation.reservationId, {
        providerRequestId: "provider-id-b",
      }),
    ).toThrow(/different provider request id/);
  });

  it("rechecks the deadline transactionally before dispatch", () => {
    const expiring = request("dispatch-deadline", "turn-1", {
      deadlineAt: T1,
    });
    admissions.enqueue(expiring);
    const reservation = claimReservation(admissionRecordKey(expiring.step));

    // The lease was valid when claimed, but the provider boundary is crossed
    // later. This mutable clock deterministically exercises that interval.
    now = new Date(T1);
    const record = admissions.markDispatched(reservation.reservationId);

    expect(record).toMatchObject({
      status: "voided",
      reason: "cancelled_before_dispatch:deadline_expired",
    });
    expect(admissions.getReservation(reservation.reservationId)?.status).toBe(
      "voided",
    );
    expect(admissions.isRunCancellationLocked("dispatch-deadline")).toBe(true);
    expect(
      admissions
        .listJournal({ runId: "dispatch-deadline" })
        .map((event) => event.event),
    ).toEqual(["queued", "allowed", "voided", "cancelled"]);
  });

  it("rechecks the canonical cancellation lock transactionally before dispatch", () => {
    upsertAgentRun(driver, {
      id: "dispatch-cancelled",
      objective: "dispatch cancellation race",
      status: "running",
      startedAt: T0,
      lastActiveAt: T0,
    });
    const cancelled = request("dispatch-cancelled", "turn-1");
    admissions.enqueue(cancelled);
    const reservation = claimReservation(admissionRecordKey(cancelled.step));

    // Model the canonical run cancellation winning the write race after claim
    // but before the provider/tool boundary is crossed.
    cancelAgentRunTree(driver, {
      runId: "dispatch-cancelled",
      reason: "operator_cancel",
      cancelledAt: T1,
    });
    const record = admissions.markDispatched(reservation.reservationId, {
      dispatchedAt: T1,
    });

    expect(record).toMatchObject({
      status: "voided",
      reason: "cancelled_before_dispatch:parent_cancel_locked",
    });
    expect(admissions.getReservation(reservation.reservationId)?.status).toBe(
      "voided",
    );
    expect(
      admissions
        .listJournal({ runId: "dispatch-cancelled" })
        .some((event) => event.event === "dispatched"),
    ).toBe(false);
  });

  it("keeps the first provider request identity immutable through reconciliation", () => {
    const correlated = request("reconcile-identity", "turn-1");
    admissions.enqueue(correlated);
    const reservation = claimReservation(admissionRecordKey(correlated.step));
    admissions.markDispatched(reservation.reservationId, {
      providerRequestId: "provider-id-a",
    });

    expect(() =>
      admissions.reconcile(reservation.reservationId, {
        kind: "reported",
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.001 },
        providerRequestId: "provider-id-b",
      }),
    ).toThrow(/different provider request id/);
    expect(admissions.getReservation(reservation.reservationId)).toMatchObject({
      status: "dispatched",
      providerRequestId: "provider-id-a",
    });

    expect(
      admissions.reconcile(reservation.reservationId, {
        kind: "reported",
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.001 },
        providerRequestId: "provider-id-a",
      }),
    ).toEqual({ applied: true, outcome: "reconciled" });
    expect(() =>
      admissions.reconcile(reservation.reservationId, {
        kind: "reported",
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.001 },
        providerRequestId: "provider-id-b",
      }),
    ).toThrow(/different provider request id/);
    expect(admissions.getReservation(reservation.reservationId)).toMatchObject({
      status: "reconciled",
      providerRequestId: "provider-id-a",
    });
  });

  it("reconstructs queue and reservations without refunding dispatched work", () => {
    const safe = request("safe-run", "turn-1");
    const unknown = request("unknown-run", "turn-1");
    const queued = request("queued-run", "turn-1");
    const expired = request("expired-run", "turn-1", {
      deadlineAt: "2026-07-18T00:00:30.000Z",
    });
    admissions.enqueue(safe);
    admissions.enqueue(unknown);
    admissions.enqueue(queued);
    admissions.enqueue(expired);
    const safeReservation = claimReservation(admissionRecordKey(safe.step));
    const unknownReservation = claimReservation(
      admissionRecordKey(unknown.step),
    );
    admissions.markDispatched(unknownReservation.reservationId);

    now = new Date(T1);
    const report = admissions.recover({ now: T1 });
    expect(report.requeuedJobIds).toContain(
      admissions.get(admissionRecordKey(safe.step))?.jobId,
    );
    expect(report.heldUnknownReservationIds).toEqual([
      unknownReservation.reservationId,
    ]);
    expect(report.cancelledExpiredJobIds).toContain(
      admissions.get(admissionRecordKey(expired.step))?.jobId,
    );
    expect(report.detachedQueuedJobIds).toContain(
      admissions.get(admissionRecordKey(queued.step))?.jobId,
    );
    expect(admissions.get(admissionRecordKey(safe.step))?.status).toBe(
      "queued",
    );
    expect(
      admissions.getReservation(safeReservation.reservationId)?.status,
    ).toBe("voided");
    expect(admissions.get(admissionRecordKey(unknown.step))?.status).toBe(
      "held_unknown",
    );
    expect(admissions.get(admissionRecordKey(expired.step))?.status).toBe(
      "cancelled",
    );

    const replacement = claimReservation(admissionRecordKey(safe.step));
    expect(replacement.reservationId).not.toBe(safeReservation.reservationId);
    expect(admissions.listReservations({ runId: "safe-run" })).toHaveLength(2);
  });
});
