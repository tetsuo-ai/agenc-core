/**
 * The canonical usage observation keeps one incremental view per scope. Its
 * cost must not grow with the session when other connections commit rows
 * that do not touch admission (the session's own rollout projection does so
 * on every tool round), and every observation must still equal the table.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutionAdmissionClient } from "../../src/budget/admission-client.js";
import {
  admissionRecordKey,
  type AdmissionUsageSnapshot,
  type AdmissionUsageSummary,
  type RuntimeAdmissionRequest,
} from "../../src/budget/admission-types.js";
import { ExecutionAdmissionKernel } from "../../src/budget/execution-admission-kernel.js";
import {
  AdmissionUsageProjection,
  captureMaterializedUsage,
} from "../../src/state/admission-usage-snapshot.js";
import { ExecutionAdmissionRepository } from "../../src/state/execution-admission.js";
import { openStateDatabases, type StateSqliteDriver } from "../../src/state/sqlite-driver.js";

let home: string;
let cwd: string;
const drivers: StateSqliteDriver[] = [];
const kernels: ExecutionAdmissionKernel[] = [];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agenc-usage-catch-up-"));
  cwd = join(home, "project");
  mkdirSync(join(cwd, ".git"), { recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const kernel of kernels.splice(0)) kernel.close();
  for (const driver of drivers.splice(0)) driver.close();
  rmSync(home, { recursive: true, force: true });
});

function connection(): StateSqliteDriver {
  const driver = openStateDatabases({ cwd, agencHome: home, deferLogs: true });
  drivers.push(driver);
  return driver;
}

let ids = 0;
function repository(driver: StateSqliteDriver): ExecutionAdmissionRepository {
  return new ExecutionAdmissionRepository(driver, { id: () => `id-${(ids += 1)}` });
}

/** A commit that touches no admission table, as the session's rollout store makes. */
function unrelatedCommit(driver: StateSqliteDriver, label: string): void {
  driver.transactionImmediate(() => {
    driver.state.prepare(
      "INSERT INTO tool_pair_projection_runs (projection_id, source_key, status) VALUES (?, 'usage-test', 'building')",
    ).run(label);
    driver.state.prepare("DELETE FROM tool_pair_projection_runs WHERE projection_id = ?").run(label);
  });
}

function request(runId: string, stepId: string, scope: string, parentScope?: string): RuntimeAdmissionRequest {
  return {
    step: { runId, stepId },
    kind: "model_turn",
    estimate: { maxInputTokens: 2_000, maxOutputTokens: 500, maxCostUsd: 0.05 },
    model: stepId.includes("pro") ? "deepseek-pro" : "deepseek-flash",
    provider: "deepseek",
    workspaceId: "workspace-a",
    sessionId: runId,
    parentScopeId: runId,
    autonomous: false,
    budgetScopes: [parentScope === undefined ? { key: scope } : { key: scope, parentKey: parentScope }],
  };
}

function claim(admissions: ExecutionAdmissionRepository, input: RuntimeAdmissionRequest): string {
  admissions.enqueue(input);
  const claimed = admissions.claim({ key: admissionRecordKey(input.step) });
  if (claimed.kind !== "claimed") throw new Error(`expected a claim, got ${claimed.kind}`);
  return claimed.lease.reservation.reservationId;
}

function spend(
  admissions: ExecutionAdmissionRepository,
  input: RuntimeAdmissionRequest,
  costUsd: number | null = 0.004,
): string {
  const id = claim(admissions, input);
  admissions.markDispatched(id);
  admissions.reconcile(id, { kind: "reported", usage: { inputTokens: 1_500, outputTokens: 200, costUsd } });
  return id;
}

/** Capture, and require the observation the table gives at the same moment. */
function expectExact(admissions: ExecutionAdmissionRepository, runId: string, scope: string): AdmissionUsageSnapshot {
  const snapshot = admissions.captureUsageSummary(runId, scope);
  const truth = admissions.getUsageSummary(runId, scope);
  expect(snapshot.read()).toEqual(truth);
  expect(snapshot.signature).toBe(captureMaterializedUsage(truth).signature);
  return snapshot;
}

describe("usage views across connections", () => {
  it("stay exact without rereading every reservation while other connections commit unrelated rows", () => {
    const admissions = repository(connection());
    const other = connection();
    const updates = vi.spyOn(AdmissionUsageProjection.prototype, "update");
    const rounds = 80;
    for (let round = 1; round <= rounds; round += 1) {
      unrelatedCommit(other, `before-${round}`);
      spend(admissions, request("run", `model-${round}`, "run:run"));
      unrelatedCommit(other, `between-${round}`);
      spend(admissions, request("run", `tool-${round}`, "run:run"), 0);
      expectExact(admissions, "run", "run:run");
    }
    // Each round changes two reservations; a view that is rebuilt instead
    // rereads every reservation of the session (rounds^2 rows in total).
    expect(updates.mock.calls.length).toBeLessThanOrEqual(2 * rounds);
  });

  it("apply admission changes another connection commits in a shared scope", () => {
    const parent = repository(connection());
    const child = repository(connection());
    expectExact(parent, "parent", "run:parent");
    for (let round = 1; round <= 12; round += 1) {
      spend(parent, request("parent", `parent-${round}`, "run:parent"));
      expectExact(parent, "parent", "run:parent");
      spend(child, request("child", `child-${round}`, "run:child", "run:parent"));
      spend(child, request("child", `child-pro-${round}`, "run:child", "run:parent"), round % 3 === 0 ? null : 0.01);
      const open = claim(child, request("child", `open-${round}`, "run:child", "run:parent"));
      expectExact(parent, "parent", "run:parent");
      if (round % 2 === 0) {
        child.markDispatched(open);
        child.reconcile(open, { kind: "unknown", reason: "daemon_restarted_after_dispatch" });
      } else {
        child.reconcile(open, { kind: "void", reason: "not sent" });
      }
      expectExact(parent, "parent", "run:parent");
    }
    // The other connection cancels the child run, settling its open work in bulk.
    claim(child, request("child", "open-at-cancel", "run:child", "run:parent"));
    expectExact(parent, "parent", "run:parent");
    child.cancel("child", { reason: "user_cancelled" });
    expectExact(parent, "parent", "run:parent");
  });

  it("rebuild when a journal row they have not applied disappears", () => {
    const admissions = repository(connection());
    const other = connection();
    const id = spend(admissions, request("run", "first", "run:run"));
    spend(admissions, request("run", "second", "run:run"));
    expectExact(admissions, "run", "run:run");
    // A change outside the admission code, with the journal rows that would
    // have named it removed: only a rebuild can see it.
    other.transactionImmediate(() => {
      other.state.prepare("UPDATE execution_admission_reservations SET actual_cost_nanos = 9000000 WHERE reservation_id = ?").run(id);
      const insert = other.state.prepare(
        `INSERT INTO execution_admission_journal (event_id, timestamp, run_id, step_id, kind, event)
         VALUES (?, '2026-10-20T00:00:00.000Z', 'run', 'pruned', 'model_turn', 'queued')`,
      );
      insert.run("pruned-1");
      insert.run("pruned-2");
      other.state.prepare("DELETE FROM execution_admission_journal WHERE event_id = 'pruned-1'").run();
    });
    const snapshot = expectExact(admissions, "run", "run:run");
    expect(snapshot.read().costUsd).toBeCloseTo(0.009 + 0.004, 12);
  });

  it("rebuild after a write on their own connection outside admission", () => {
    const driver = connection();
    const admissions = repository(driver);
    const id = spend(admissions, request("run", "first", "run:run"));
    expectExact(admissions, "run", "run:run");
    driver.state.prepare("UPDATE execution_admission_reservations SET actual_input_tokens = 7 WHERE reservation_id = ?").run(id);
    expect(expectExact(admissions, "run", "run:run").read().inputTokens).toBe(7);
  });

  it("never keep state read inside a caller's transaction that rolls back", () => {
    const driver = connection();
    const admissions = repository(driver);
    spend(admissions, request("run", "committed", "run:run"));
    expectExact(admissions, "run", "run:run");
    expect(() => driver.transactionImmediate(() => {
      spend(admissions, request("run", "rolled-back", "run:run"), 0.03);
      const inside = admissions.captureUsageSummary("run", "run:run").read();
      expect(inside.costUsd).toBeCloseTo(0.034, 12);
      throw new Error("roll back");
    })).toThrow("roll back");
    // The rolled-back step's journal sequence is reused by the next commit.
    spend(admissions, request("run", "after", "run:run"), 0.002);
    const after = expectExact(admissions, "run", "run:run").read();
    expect(after.costUsd).toBeCloseTo(0.006, 12);
    expect(after.modelCalls).toBe(2);
  });
});

describe("canonical usage snapshots in a session", () => {
  async function spendKernel(client: ExecutionAdmissionClient, stepId: string, kind: "model_turn" | "tool_exec") {
    const lease = await client.acquire({
      stepId, kind, model: "deepseek-flash", provider: "deepseek",
      maxInputTokens: 2_000, maxOutputTokens: 500, maxCostUsd: kind === "tool_exec" ? 0 : 0.05,
    });
    const id = lease.reservation.reservationId;
    client.markDispatched(id, { boundary: kind === "tool_exec" ? "tool_effect" : "provider_wire" });
    client.reconcile(id, { inputTokens: kind === "tool_exec" ? 0 : 1_500, outputTokens: kind === "tool_exec" ? 0 : 200, costUsd: kind === "tool_exec" ? 0 : 0.004 });
  }

  it("equal every SQL observation while the rollout store commits between steps", async () => {
    const kernel = new ExecutionAdmissionKernel({ agencHome: home });
    kernels.push(kernel);
    const client = kernel.bindClient({ cwd, scope: { runId: "session", sessionId: "session", autonomous: false } });
    const legacy: AdmissionUsageSummary[] = [];
    const captured: AdmissionUsageSnapshot[] = [];
    client.subscribeUsage!((summary) => legacy.push(summary));
    client.subscribeUsageSnapshot!((snapshot) => captured.push(snapshot));
    const rollout = connection();
    const updates = vi.spyOn(AdmissionUsageProjection.prototype, "update");
    const rounds = 60;
    for (let round = 1; round <= rounds; round += 1) {
      unrelatedCommit(rollout, `model-${round}`);
      await spendKernel(client, `model-${round}`, "model_turn");
      unrelatedCommit(rollout, `tool-${round}`);
      await spendKernel(client, `tool-${round}`, "tool_exec");
    }
    expect(captured.length).toBeGreaterThanOrEqual(rounds);
    expect(captured.map((snapshot) => snapshot.read())).toEqual(legacy);
    expect(captured.map((snapshot) => snapshot.signature))
      .toEqual(legacy.map((summary) => captureMaterializedUsage(summary).signature));
    // Later usage-neutral journal rows (a tool's dispatch) only move the cursor.
    expect({ ...captured.at(-1)!.read(), sequence: 0 }).toEqual({ ...client.getUsageSummary!(), sequence: 0 });
    expect(updates.mock.calls.length).toBeLessThanOrEqual(4 * rounds);
  });
});
