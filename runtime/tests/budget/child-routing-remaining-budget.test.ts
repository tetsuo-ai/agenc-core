import { describe, expect, it } from "vitest";
import { ExecutionAdmissionKernel } from "../../src/budget/execution-admission-kernel.js";
import { home, cwd, kernels, kernel, root, acquire, reconcile } from "./child-budget.fixture.js";

describe("child routing budget snapshots", () => {
  it("reads direct worker/task usage separately from descendant spend and unknown holds", async () => {
    const parent = root(kernel(), 5);
    reconcile(parent, await acquire(parent, "parent-start", 0, 0), 0, 0);
    const worker = parent.forSession({ runId: "worker", sessionId: "worker" });
    const a = worker.forSession({ sessionId: "worker", taskId: "a" });
    reconcile(a, await acquire(a, "own", 0.4), 0.4);
    const child = a.forSession({ runId: "child", sessionId: "child" });
    reconcile(child, await acquire(child, "spent", 0.2), 0.2);
    const held = await acquire(child, "held", 0.3);
    child.markDispatched(held.reservation.reservationId, { boundary: "provider_wire" });
    child.holdUnknown(held.reservation.reservationId, "timeout");
    expect(a.getUsageSummary?.()).toMatchObject({ costUsd: 0.6, heldCostUsd: 0.3, hasUnknownCost: true });
    expect(a.getDirectUsageSummary?.()).toMatchObject({ costUsd: 0.4, heldCostUsd: 0,
      hasUnknownCost: false, agents: [], modelCalls: 1 });
    const b = worker.forSession({ sessionId: "worker", taskId: "b" });
    reconcile(b, await acquire(b, "own", 0.1), 0.1);
    expect(worker.getDirectUsageSummary?.().costUsd).toBe(0.5);
    expect(a.getDirectUsageSummary?.().costUsd).toBe(0.4);
    expect(b.getDirectUsageSummary?.().costUsd).toBe(0.1);
  });

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
