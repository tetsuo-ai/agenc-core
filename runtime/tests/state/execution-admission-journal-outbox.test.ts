import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RuntimeAdmissionRequest } from "../../src/budget/admission-types.js";
import { admissionRecordKey } from "../../src/budget/admission-types.js";
import { ExecutionAdmissionRepository } from "../../src/state/execution-admission.js";
import { openStateDatabases, type StateSqliteDriver } from "../../src/state/sqlite-driver.js";

let home = "";
let cwd = "";
let driver: StateSqliteDriver;
let foreignDriver: StateSqliteDriver | undefined;
let nextId = 0;
let admissions: ExecutionAdmissionRepository;

function repository(on: StateSqliteDriver, owner: string): ExecutionAdmissionRepository {
  return new ExecutionAdmissionRepository(on, {
    now: () => new Date("2026-10-08T00:00:00.000Z"),
    id: () => `${owner}-id-${++nextId}`,
    ownerId: owner,
    ownerPid: 100,
  });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agenc-outbox-home-"));
  cwd = mkdtempSync(join(tmpdir(), "agenc-outbox-cwd-"));
  mkdirSync(join(cwd, ".git"));
  driver = openStateDatabases({ cwd, agencHome: home });
  nextId = 0;
  admissions = repository(driver, "daemon-a");
});

afterEach(() => {
  foreignDriver?.close();
  foreignDriver = undefined;
  driver.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

function request(runId: string, stepId: string, details?: { costEstimated?: boolean }): RuntimeAdmissionRequest {
  return {
    step: { runId, stepId },
    kind: "model_turn",
    estimate: { maxInputTokens: 20, maxOutputTokens: 20, maxCostUsd: 0.004 },
    model: "test-model",
    provider: "test-provider:https://example.test",
    workspaceId: "workspace-a",
    sessionId: "session-a",
    parentScopeId: "session-a",
    autonomous: false,
    ...(details?.costEstimated === true ? { costEstimated: true } : {}),
  };
}

function lifecycle(on: ExecutionAdmissionRepository, runId: string, stepId: string): void {
  const step = request(runId, stepId, { costEstimated: true });
  on.enqueue(step);
  const claimed = on.claim({ key: admissionRecordKey(step.step) });
  if (claimed.kind !== "claimed") throw new Error("expected a claim");
  on.markDispatched(claimed.lease.reservation.reservationId, {
    providerRequestId: `request-${stepId}`,
    details: { boundary: "provider_wire" },
  });
  on.reconcile(claimed.lease.reservation.reservationId, {
    kind: "reported",
    usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.003 },
    providerRequestId: `request-${stepId}`,
  });
}

describe("committed admission journal outbox", () => {
  it("serves exactly the rows the table holds after the cursor, equal to a table read", () => {
    lifecycle(admissions, "run-a", "turn-1");
    const fromTable = admissions.listJournal({ afterSequence: 0 });
    expect(fromTable.map((event) => event.event)).toEqual(["queued", "allowed", "dispatched", "reconciled"]);
    expect(admissions.takeCommittedJournal(0)).toEqual(fromTable);
    // Taking drains the outbox; nothing new is exact and empty.
    expect(admissions.takeCommittedJournal(fromTable.at(-1)!.sequence)).toEqual([]);
  });

  it("skips events at or before the cursor and requires contiguous sequences", () => {
    lifecycle(admissions, "run-a", "turn-1");
    const all = admissions.listJournal({ afterSequence: 0 });
    expect(admissions.takeCommittedJournal(2)).toEqual(all.slice(2));
    lifecycle(admissions, "run-a", "turn-2");
    // A cursor that lags behind the outbox cannot be served from it.
    expect(admissions.takeCommittedJournal(1)).toBeUndefined();
  });

  it("falls back when another connection wrote journal rows", () => {
    lifecycle(admissions, "run-a", "turn-1");
    const cursor = admissions.takeCommittedJournal(0)!.at(-1)!.sequence;
    foreignDriver = openStateDatabases({ cwd, agencHome: home });
    lifecycle(repository(foreignDriver, "daemon-b"), "run-b", "turn-1");
    // Foreign rows after the cursor and nothing of ours: not exact.
    expect(admissions.takeCommittedJournal(cursor)).toBeUndefined();
    const foreign = admissions.listJournal({ afterSequence: cursor });
    expect(foreign.map((event) => event.runId)).toEqual(["run-b", "run-b", "run-b", "run-b"]);
    // Our next commit follows foreign rows the outbox never held.
    admissions.enqueue(request("run-a", "turn-2"));
    expect(admissions.takeCommittedJournal(cursor)).toBeUndefined();
  });

  it("drops rows of a rolled-back transaction it did not open and stays inexact", () => {
    expect(() => driver.transaction(() => {
      admissions.enqueue(request("run-a", "turn-1"));
      throw new Error("outer rollback");
    })).toThrow("outer rollback");
    expect(admissions.listJournal({ afterSequence: 0 })).toEqual([]);
    expect(admissions.takeCommittedJournal(0)).toBeUndefined();
    // After a fallback the outbox is trusted again for its own transactions.
    admissions.enqueue(request("run-a", "turn-2"));
    expect(admissions.takeCommittedJournal(0)).toEqual(admissions.listJournal({ afterSequence: 0 }));
  });

  it("does not trust rows written inside a transaction it did not open even when it commits", () => {
    driver.transaction(() => {
      admissions.enqueue(request("run-a", "turn-1"));
    });
    expect(admissions.takeCommittedJournal(0)).toBeUndefined();
    expect(admissions.listJournal({ afterSequence: 0 })).toHaveLength(1);
  });

  it("counts committed outermost write transactions", () => {
    const before = admissions.writeRevision;
    admissions.enqueue(request("run-a", "turn-1"));
    expect(admissions.writeRevision).toBe(before + 1);
    expect(() => admissions.markDispatched("missing-reservation")).toThrow();
    // A rolled-back write is not counted.
    expect(admissions.writeRevision).toBe(before + 1);
  });
});
