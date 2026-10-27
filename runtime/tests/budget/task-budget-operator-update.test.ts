import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { ExecutionAdmissionKernel } from "../../src/budget/execution-admission-kernel.js";

it("changes only the root task token cap and preserves spent usage and child caps", async () => {
  const root = await mkdtemp(join(tmpdir(), "agenc-budget-update-"));
  const cwd = join(root, "ws"); await mkdir(cwd);
  const kernel = new ExecutionAdmissionKernel({ agencHome: root, limits: { global: 1, workspace: 1, session: 1, parent: 1, provider: 1 } });
  try {
    const client = kernel.bindClient({ cwd, scope: { runId: "root", sessionId: "root", autonomous: false, maxTokens: 100 } });
    const input = (stepId: string, tokens: number) => ({ stepId, kind: "model_turn" as const, maxInputTokens: tokens, maxOutputTokens: 0, maxCostUsd: 0, provider: "local", model: "fake" });
    const first = await client.acquire(input("first", 60));
    client.markDispatched(first.reservation.reservationId, { boundary: "provider_wire" });
    client.reconcile(first.reservation.reservationId, { inputTokens: 60, outputTokens: 0, costUsd: 0 });
    client.acknowledgeCompletion(first.reservation.reservationId);
    await expect(client.acquire(input("denied", 50))).rejects.toThrow("budget_exceeded");
    const child = client.forSession({ runId: "child", sessionId: "child", maxTokens: 10 });
    expect(client.setTaskTokenBudget!(200)).toBe(200);
    expect(client.getTaskBudgetUsage?.().tokens).toBe(60);
    const next = await client.acquire(input("next", 50));
    const queued = client.acquire(input("queued", 40));
    expect(client.setTaskTokenBudget!(0)).toBe(0);
    expect(client.scope.hasHardTokenCap).toBe(false);
    client.void(next.reservation.reservationId, "test"); client.acknowledgeCompletion(next.reservation.reservationId);
    const resumed = await queued;
    client.void(resumed.reservation.reservationId, "test"); client.acknowledgeCompletion(resumed.reservation.reservationId);
    expect(client.getTaskBudgetUsage?.().tokens).toBe(60);
    await expect(child.acquire(input("child-denied", 11))).rejects.toThrow("budget_exceeded");
    expect(() => child.setTaskTokenBudget!(0)).toThrow();
  } finally { kernel.close(); await rm(root, { recursive: true, force: true }); }
});

it("cannot remove an independent run token or call ceiling", async () => {
  const root = await mkdtemp(join(tmpdir(), "agenc-budget-independent-"));
  const cwd = join(root, "ws"); await mkdir(cwd);
  const kernel = new ExecutionAdmissionKernel({ agencHome: root });
  try {
    const client = kernel.bindClient({ cwd, scope: { runId: "root", sessionId: "root", autonomous: false, maxTokens: 100, maxModelCalls: 1 }, budget: { runMaxTokens: 50 } });
    expect(client.setTaskTokenBudget!(200)).toBe(50);
    expect(client.setTaskTokenBudget!(0)).toBe(50);
    expect(client.scope.hasHardTokenCap).toBe(true);
    expect(client.scope.maxModelCalls).toBe(1);
  } finally { kernel.close(); await rm(root, { recursive: true, force: true }); }
});
