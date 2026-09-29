import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExecutionAdmissionClient } from "../../src/budget/admission-client.js";
import type { AdmissionLease } from "../../src/budget/admission-types.js";
import { ExecutionAdmissionKernel } from "../../src/budget/execution-admission-kernel.js";

let home: string;
let cwd: string;
const kernels: ExecutionAdmissionKernel[] = [];
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agenc-child-budget-home-"));
  cwd = mkdtempSync(join(tmpdir(), "agenc-child-budget-project-"));
  mkdirSync(join(cwd, ".git"));
});
afterEach(() => {
  for (const kernel of kernels.splice(0)) kernel.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

function kernel() {
  const value = new ExecutionAdmissionKernel({ agencHome: home,
    limits: { global: 20, workspace: 20, session: 20, parent: 20, provider: 20 } });
  kernels.push(value);
  return value;
}
function root(value: ExecutionAdmissionKernel, maxCostUsd?: number, maxTokens?: number) {
  return value.bindClient({ cwd, scope: { runId: "root", sessionId: "root", autonomous: false,
    ...(maxCostUsd !== undefined ? { maxCostUsd } : {}), ...(maxTokens !== undefined ? { maxTokens } : {}) } });
}
function acquire(client: ExecutionAdmissionClient, stepId: string, cost: number, tokens = 1) {
  return client.acquire({ stepId, kind: "model_turn", model: "budget-model", provider: "budget-provider",
    maxInputTokens: tokens, maxOutputTokens: 0, maxCostUsd: cost });
}
function reconcile(client: ExecutionAdmissionClient, lease: AdmissionLease, cost: number, tokens = 1) {
  client.markDispatched(lease.reservation.reservationId, { boundary: "provider_wire" });
  client.reconcile(lease.reservation.reservationId, { inputTokens: tokens, outputTokens: 0, costUsd: cost });
  client.acknowledgeCompletion(lease.reservation.reservationId);
}
describe("child routing budget snapshots", () => {
  it("returns no monetary ceiling for an uncapped tree", () => {
    const parent = root(kernel());
    const child = parent.forSession({ runId: "child", sessionId: "child", taskId: "task" });
    expect(child.getRemainingCostUsd?.()).toBeUndefined();
  });

  it("includes sibling spending and holds when a fresh task's own usage is zero", async () => {
    const parent = root(kernel(), 1);
    const a = parent.forSession({ runId: "a", sessionId: "a" });
    reconcile(a, await acquire(a, "spent", 0.6), 0.6);
    const held = await acquire(a, "held", 0.2);
    a.markDispatched(held.reservation.reservationId, { boundary: "provider_wire" });
    a.holdUnknown(held.reservation.reservationId, "timeout");
    const b = parent.forSession({ runId: "b", sessionId: "b", taskId: "new", maxCostUsd: 1 });
    expect(b.getUsageSummary?.().costUsd).toBe(0);
    expect(b.getRemainingCostUsd?.()).toBeCloseTo(0.2);
    expect(parent.getRemainingCostUsd?.()).toBeCloseTo(0.2);
  });

  it("takes the strictest remaining amount across task and grandparent scopes", async () => {
    const parent = root(kernel(), 5);
    const worker = parent.forSession({ runId: "worker", sessionId: "worker", maxCostUsd: 3 });
    const task = worker.forSession({ sessionId: "worker", taskId: "task", maxCostUsd: 1 });
    reconcile(task, await acquire(task, "spent", 0.7), 0.7);
    const child = task.forSession({ runId: "child", sessionId: "child", maxCostUsd: 2 });
    expect(child.getRemainingCostUsd?.()).toBeCloseTo(0.3);
    const next = worker.forSession({ sessionId: "worker", taskId: "next", maxCostUsd: 5 });
    expect(next.getRemainingCostUsd?.()).toBeCloseTo(2.3);
  });

  it("observes tighter durable caps from an older client and never goes negative", async () => {
    const parent = root(kernel());
    const old = parent.forSession({ runId: "child", sessionId: "child", maxCostUsd: 2 });
    reconcile(old, await acquire(old, "spent", 0.7), 0.7);
    parent.forSession({ runId: "child", sessionId: "child", maxCostUsd: 1 });
    expect(old.getRemainingCostUsd?.()).toBeCloseTo(0.3);
    parent.forSession({ runId: "child", sessionId: "child", maxCostUsd: 0.5 });
    expect(old.getRemainingCostUsd?.()).toBe(0);
  });

  it("counts reservations before dispatch and returns them after a void", async () => {
    const client = root(kernel(), 1);
    const lease = await acquire(client, "reservation", 0.8);
    expect(client.getRemainingCostUsd?.()).toBeCloseTo(0.2);
    client.void(lease.reservation.reservationId, "not_sent");
    expect(client.getRemainingCostUsd?.()).toBe(1);
  });

  it("keeps unknown usage charged after restart", async () => {
    const before = kernel();
    const client = root(before, 1);
    const lease = await acquire(client, "reservation", 0.8);
    client.markDispatched(lease.reservation.reservationId, { boundary: "provider_wire" });
    client.holdUnknown(lease.reservation.reservationId, "timeout");
    client.acknowledgeCompletion(lease.reservation.reservationId);
    before.close();
    const after = kernel();
    expect(after.initializeExistingState().failures).toEqual([]);
    expect(root(after).getRemainingCostUsd?.()).toBeCloseTo(0.2);
  });

  it("applies day/month balances, rollover and persisted caps omitted by a later config", async () => {
    let clock = new Date("2026-09-29T12:00:00Z");
    const value = new ExecutionAdmissionKernel({ agencHome: home, now: () => clock });
    kernels.push(value);
    const client = value.bindClient({ cwd, scope: { runId: "calendar", sessionId: "calendar", autonomous: false,
      budgetIdentity: "installation" }, budget: { dailyUsd: 1, monthlyUsd: 1.5 } });
    expect(client.getRemainingCostUsd?.()).toBe(1);
    reconcile(client, await acquire(client, "spent", 0.8), 0.8);
    expect(client.getRemainingCostUsd?.()).toBeCloseTo(0.2);
    const omitted = value.bindClient({ cwd, scope: { runId: "later", sessionId: "later", autonomous: false,
      budgetIdentity: "installation" } });
    expect(omitted.getRemainingCostUsd?.()).toBeCloseTo(0.2);
    clock = new Date("2026-09-30T12:00:00Z");
    expect(client.getRemainingCostUsd?.()).toBeCloseTo(0.7);
    expect(omitted.getRemainingCostUsd?.()).toBeCloseTo(0.7);
    clock = new Date("2026-10-01T12:00:00Z");
    expect(client.getRemainingCostUsd?.()).toBe(1);
    expect(omitted.getRemainingCostUsd?.()).toBeUndefined();
  });

  it("returns zero after a provider overrun blocks an allocation", async () => {
    const client = root(kernel(), 1);
    const lease = await acquire(client, "overrun", 0.2);
    reconcile(client, lease, 0.3);
    expect(client.getRemainingCostUsd?.()).toBe(0);
  });
});
