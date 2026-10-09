import { expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExecutionAdmissionKernel } from "../../src/budget/execution-admission-kernel.js";
import type { ExecutionAdmissionClient } from "../../src/budget/admission-client.js";
import { taskBudgetOf } from "../../src/session/task-budget.js";
import type { Session } from "../../src/session/session.js";

function fixture(maxModelCalls = 1) {
  const home = mkdtempSync(join(tmpdir(), "durable-task-budget-"));
  const cwd = join(home, "project");
  mkdirSync(join(cwd, ".git"), { recursive: true });
  const kernels: ExecutionAdmissionKernel[] = [];
  const open = (limit = maxModelCalls) => {
    const kernel = new ExecutionAdmissionKernel({ agencHome: home, ownerId: `budget-${kernels.length}`,
      ownerPid: process.pid, limits: { global: 4, workspace: 4, session: 4, parent: 4, provider: 4 } });
    kernels.push(kernel);
    const client = kernel.bindClient({ cwd, scope: { runId: "root", sessionId: "root", autonomous: false, maxModelCalls: limit } });
    return { kernel, client };
  };
  return { ...open(), open, cleanup() { for (const kernel of kernels) kernel.close(); rmSync(home, { recursive: true, force: true }); } };
}
const acquire = (client: ExecutionAdmissionClient, stepId: string, kind: "model_turn" | "tool_exec" = "model_turn") => client.acquire({
  stepId, kind, model: "test", provider: "test", maxInputTokens: 3, maxOutputTokens: 7, maxCostUsd: 0,
});
const session = (client: ExecutionAdmissionClient) => ({ config: { taskTokenBudget: 0, taskMaxCalls: 1 }, services: { executionAdmission: client } }) as Session;

it("atomically shares a single model call across siblings and refunds an undispatched reservation", async () => {
  const f = fixture();
  try {
    const a = f.client.forSession({ runId: "a", sessionId: "a" });
    const b = f.client.forSession({ runId: "b", sessionId: "b" });
    const results = await Promise.allSettled([acquire(a, "a"), acquire(b, "b")]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
    const rejected = results.find(r => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ reason: "model_call_budget_exceeded" });
    const first = results[0]!.status === "fulfilled" ? a : b;
    const lease = (results.find(r => r.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof acquire>>>).value;
    first.void(lease.reservation.reservationId, "never_dispatched");
    first.acknowledgeCompletion(lease.reservation.reservationId);
    const replacement = await acquire(f.client, "replacement");
    f.client.markDispatched(replacement.reservation.reservationId, { boundary: "provider_wire" });
    f.client.reconcile(replacement.reservation.reservationId, { inputTokens: 1, outputTokens: 1, costUsd: 0 });
    f.client.acknowledgeCompletion(replacement.reservation.reservationId);
    expect(taskBudgetOf(session(b))!.reached).toBe(true);
    await expect(acquire(b, "one-too-many")).rejects.toMatchObject({ reason: "model_call_budget_exceeded" });
    // A spent model-call allocation must still allow already admitted tools to finish.
    const tool = await acquire(b, "finish-tool", "tool_exec");
    b.void(tool.reservation.reservationId, "test_cleanup");
    b.acknowledgeCompletion(tool.reservation.reservationId);
  } finally { f.cleanup(); }
});

it.each(["unknown", "reported"] as const)("preserves %s usage and the call ceiling across a real kernel restart", async availability => {
  const f = fixture();
  try {
    const lease = await acquire(f.client, "wire");
    f.client.markDispatched(lease.reservation.reservationId, { boundary: "provider_wire" });
    if (availability === "unknown") f.client.holdUnknown(lease.reservation.reservationId, "usage_missing");
    else f.client.reconcile(lease.reservation.reservationId, { inputTokens: 1, outputTokens: 1, costUsd: 0 });
    f.client.acknowledgeCompletion(lease.reservation.reservationId);
    f.kernel.close();
    const restored = f.open(99);
    expect(restored.client.scope.maxModelCalls).toBe(1);
    expect(restored.client.getTaskBudgetUsage!()).toEqual({ calls: 1, tokens: availability === "unknown" ? 10 : 2 });
    expect(taskBudgetOf(session(restored.client))!.reached).toBe(true);
  } finally { f.cleanup(); }
});
