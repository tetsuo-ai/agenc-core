import { describe, expect, it } from "vitest";
import { kernel, root, acquire, reconcile } from "./child-budget.fixture.js";

const exceeded = { name: "AdmissionDeniedError", reason: "budget_exceeded" };

describe("durable child allocations", () => {
  it("enforces each sibling's cap and their shared ancestor cap before dispatch", async () => {
    const parent = root(kernel(), 5, 20);
    const a = parent.forSession({ runId: "a", sessionId: "a", maxCostUsd: 1, maxTokens: 4 });
    const b = parent.forSession({ runId: "b", sessionId: "b", maxCostUsd: 3, maxTokens: 10 });
    const first = await acquire(a, "a-1", 0.7, 3);
    await expect(acquire(a, "a-cost", 0.4)).rejects.toMatchObject(exceeded);
    await expect(acquire(a, "a-tokens", 0.1, 2)).rejects.toMatchObject(exceeded);
    const second = await acquire(b, "b-1", 2, 6);
    const c = parent.forSession({ runId: "c", sessionId: "c", maxCostUsd: 20 });
    await expect(acquire(c, "ancestor", 2.4)).rejects.toMatchObject(exceeded);
    reconcile(a, first, 0.7, 3);
    reconcile(b, second, 2, 6);
    expect(parent.getUsageSummary?.()).toMatchObject({ costUsd: 2.7, totalTokens: 9 });
  });

  it("persists token-only caps before any admission and allows no cost for a zero cap", async () => {
    const before = kernel();
    const parent = root(before);
    parent.forSession({ runId: "tokens", sessionId: "tokens", maxTokens: 2 });
    parent.forSession({ runId: "zero", sessionId: "zero", maxCostUsd: 0 });
    before.close();
    const after = kernel();
    expect(after.initializeExistingState().failures).toEqual([]);
    const restored = root(after);
    const tokens = restored.forSession({ runId: "tokens", sessionId: "tokens" });
    expect(tokens.scope).toMatchObject({ maxTokens: 2, hasHardTokenCap: true });
    await expect(acquire(tokens, "large", 0, 3)).rejects.toMatchObject(exceeded);
    const zero = restored.forSession({ runId: "zero", sessionId: "zero" });
    expect(zero.scope).toMatchObject({ maxCostUsd: 0, hasHardCostCap: true });
    await expect(acquire(zero, "paid", 0.001)).rejects.toMatchObject(exceeded);
    const free = await acquire(zero, "free", 0);
    reconcile(zero, free, 0);
  });

  it("cannot reset or loosen child and ancestor caps after restart", async () => {
    const before = kernel();
    const parent = root(before, 5, 20);
    const child = parent.forSession({ runId: "child", sessionId: "child", maxCostUsd: 1, maxTokens: 4 });
    reconcile(child, await acquire(child, "first", 0.4, 2), 0.4, 2);
    before.close();
    const after = kernel();
    expect(after.initializeExistingState().failures).toEqual([]);
    const restoredParent = root(after, 50, 200);
    expect(restoredParent.scope).toMatchObject({ maxCostUsd: 5, maxTokens: 20 });
    const restored = restoredParent.forSession({ runId: "child", sessionId: "child", maxCostUsd: 10, maxTokens: 40 });
    expect(restored.scope).toMatchObject({ maxCostUsd: 1, maxTokens: 4 });
    await expect(acquire(restored, "too-costly", 0.7)).rejects.toMatchObject(exceeded);
    await expect(acquire(restored, "too-long", 0.1, 3)).rejects.toMatchObject(exceeded);
    reconcile(restored, await acquire(restored, "remaining", 0.6, 2), 0.6, 2);
    expect(restored.getUsageSummary?.()).toMatchObject({ costUsd: 1, totalTokens: 4 });
  });

  it("tightens limits while stale clients remain subject to the durable cap", async () => {
    const parent = root(kernel());
    const old = parent.forSession({ runId: "child", sessionId: "child", maxCostUsd: 2, maxTokens: 8 });
    const narrowed = parent.forSession({ runId: "child", sessionId: "child", maxCostUsd: 1, maxTokens: 4 });
    await expect(acquire(old, "old-cost", 1.1)).rejects.toMatchObject(exceeded);
    await expect(acquire(old, "old-tokens", 0.1, 5)).rejects.toMatchObject(exceeded);
    reconcile(old, await acquire(old, "fits", 0.5, 3), 0.5, 3);
    await expect(acquire(narrowed, "spent", 0.6)).rejects.toMatchObject(exceeded);
  });

  it("keeps unknown dispatched usage charged against child and parent after restart", async () => {
    const before = kernel();
    const child = root(before, 1.1).forSession({ runId: "child", sessionId: "child", maxCostUsd: 1, maxTokens: 4 });
    const lease = await acquire(child, "unknown", 0.8, 3);
    child.markDispatched(lease.reservation.reservationId, { boundary: "provider_wire" });
    child.holdUnknown(lease.reservation.reservationId, "provider_timeout");
    child.acknowledgeCompletion(lease.reservation.reservationId);
    before.close();
    const after = kernel();
    expect(after.initializeExistingState().failures).toEqual([]);
    const parent = root(after);
    const restored = parent.forSession({ runId: "child", sessionId: "child" });
    await expect(acquire(restored, "child-cost", 0.3)).rejects.toMatchObject(exceeded);
    await expect(acquire(restored, "child-tokens", 0.1, 2)).rejects.toMatchObject(exceeded);
    const sibling = parent.forSession({ runId: "sibling", sessionId: "sibling", maxCostUsd: 10 });
    await expect(acquire(sibling, "ancestor", 0.4)).rejects.toMatchObject(exceeded);
    expect(parent.getUsageSummary?.()).toMatchObject({ heldCostUsd: 0.8 });
  });

  it("isolates assignments on a reused worker and keeps task ancestors on grandchildren", async () => {
    const parent = root(kernel(), 3, 20);
    reconcile(parent, await acquire(parent, "start", 0, 0), 0, 0);
    const worker = parent.forSession({ runId: "worker", sessionId: "worker" });
    const a = worker.forSession({ sessionId: "worker", taskId: "a", maxCostUsd: 0.5, maxTokens: 4 });
    const first = await acquire(a, "model-1", 0.5, 2);
    reconcile(a, first, 0.5, 2);
    const b = a.forSession({ sessionId: "worker", taskId: "b", maxCostUsd: 1.5, maxTokens: 10 });
    const second = await acquire(b, "model-1", 0.6, 2);
    expect(first.reservation.reservationId).not.toBe(second.reservation.reservationId);
    reconcile(b, second, 0.6, 2);
    expect(a.getUsageSummary?.()).toMatchObject({ costUsd: 0.5, totalTokens: 2 });
    expect(b.getUsageSummary?.()).toMatchObject({ costUsd: 0.6, totalTokens: 2 });
    const same = worker.forSession({ sessionId: "worker", taskId: "a", maxCostUsd: 50 });
    await expect(acquire(same, "another", 0.01)).rejects.toMatchObject(exceeded);
    const grandchild = b.forSession({ runId: "grandchild", sessionId: "grandchild", maxCostUsd: 5 });
    await expect(acquire(grandchild, "task-parent", 1)).rejects.toMatchObject(exceeded);
    reconcile(grandchild, await acquire(grandchild, "fits", 0.8), 0.8);
    const c = worker.forSession({ sessionId: "worker", taskId: "c", maxCostUsd: 2 });
    await expect(acquire(c, "root-cap", 1.2)).rejects.toMatchObject(exceeded);
    a.release?.(); b.release?.(); same.release?.(); c.release?.(); grandchild.release?.(); worker.release?.();
  });

  it("restores a task cap and cumulative worker usage after restart", async () => {
    const before = kernel();
    const worker = root(before, 2).forSession({ runId: "worker", sessionId: "worker", maxCostUsd: 1.5 });
    const task = worker.forSession({ sessionId: "worker", taskId: "review", maxCostUsd: 0.7, maxTokens: 2 });
    reconcile(task, await acquire(task, "first", 0.4), 0.4);
    before.close();
    const after = kernel();
    expect(after.initializeExistingState().failures).toEqual([]);
    const restoredWorker = root(after).forSession({ runId: "worker", sessionId: "worker" });
    const restored = restoredWorker.forSession({ sessionId: "worker", taskId: "review" });
    expect(restored.scope).toMatchObject({ maxCostUsd: 0.7, maxTokens: 2, taskId: "review" });
    await expect(acquire(restored, "too-costly", 0.4)).rejects.toMatchObject(exceeded);
    const inherited = restored.forSession({ sessionId: "worker" });
    await expect(acquire(inherited, "too-long", 0.1, 2)).rejects.toMatchObject(exceeded);
    const next = restoredWorker.forSession({ sessionId: "worker", taskId: "next", maxCostUsd: 2 });
    await expect(acquire(next, "worker-cap", 1.2)).rejects.toMatchObject(exceeded);
  });

  it("rejects invalid allocation limits and empty task identities at binding", () => {
    const parent = root(kernel());
    for (const maxCostUsd of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => parent.forSession({ sessionId: "child", maxCostUsd })).toThrow(/admission_child_cost_limit_invalid/);
    }
    for (const maxTokens of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => parent.forSession({ sessionId: "child", maxTokens })).toThrow(/admission_child_token_limit_invalid/);
    }
    expect(() => parent.forSession({ sessionId: "child", taskId: " " })).toThrow(/admission_child_task_identity_invalid/);
  });
});
