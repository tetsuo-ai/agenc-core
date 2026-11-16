import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { ExecutionAdmissionClient } from "../../src/budget/admission-client.js";
import { ExecutionAdmissionKernel } from "../../src/budget/execution-admission-kernel.js";

// Job coste2e37, finding F1: a ChatGPT sign-in call that fails after dispatch has no usage, so its ledger row
// carried no billing route and the session's money read "≥". The route is now recorded at dispatch.
let home: string;
let cwd: string;
const kernels: ExecutionAdmissionKernel[] = [];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agenc-plan-failed-"));
  cwd = join(home, "project");
  mkdirSync(join(cwd, ".git"), { recursive: true });
});

afterEach(() => {
  for (const kernel of kernels.splice(0)) kernel.close();
  rmSync(home, { recursive: true, force: true });
});

function createKernel(): ExecutionAdmissionKernel {
  const kernel = new ExecutionAdmissionKernel({ agencHome: home });
  kernels.push(kernel);
  return kernel;
}

function bind(kernel: ExecutionAdmissionKernel, runId: string): ExecutionAdmissionClient {
  return kernel.bindClient({ cwd, scope: { runId, sessionId: runId, autonomous: false } });
}

async function dispatch(client: ExecutionAdmissionClient, stepId: string, provider: string, model: string, plan: boolean): Promise<string> {
  const lease = await client.acquire({ stepId, kind: "model_turn", model, provider,
    maxInputTokens: 20, maxOutputTokens: 20, maxCostUsd: 0.5 });
  const id = lease.reservation.reservationId;
  client.markDispatched(id, { boundary: "provider_wire", timestamp: "2026-11-16T15:31:02Z",
    details: { model, provider, ...(plan ? { billingMode: "plan" } : {}) } });
  return id;
}

it.each([
  ["a call that failed after dispatch", (client: ExecutionAdmissionClient, id: string) => client.holdUnknown(id, "provider_call_failed_after_dispatch"), "provider_call_failed_after_dispatch"],
  ["a call cancelled after dispatch", (client: ExecutionAdmissionClient) => client.cancelRun("user_interrupt"), "cancelled_after_dispatch:user_interrupt"],
] as const)("a plan route keeps %s out of the unknown cost, and lists it", async (_name, fail, reason) => {
  const kernel = createKernel();
  const lead = bind(kernel, "lead");
  const worker = lead.forSession({ runId: "worker", sessionId: "worker" });
  // One sign-in call with usage, one metered sub-agent call, then the failing sign-in call.
  const ok = await dispatch(lead, "sol-1", "openai", "gpt-6.1-sol", true);
  lead.reconcile(ok, { inputTokens: 10, outputTokens: 5, costUsd: 0,
    billingDetails: { billingMode: "plan", cachedInputTokens: 4, apiEquivalentUsd: 0.4 } });
  lead.acknowledgeCompletion(ok);
  const metered = await dispatch(worker, "ds-1", "deepseek", "deepseek-flash", false);
  worker.reconcile(metered, { inputTokens: 10, outputTokens: 5, costUsd: 0.2,
    billingDetails: { billingMode: "metered", cachedInputTokens: 5, offPeakEligibleCostUsd: 0.2 } });
  worker.acknowledgeCompletion(metered);
  const failed = await dispatch(lead, "sol-2", "openai", "gpt-6.1-sol", true);
  fail(lead, failed);

  for (const summary of [lead.getUsageSummary!(), bind(createKernel(), "lead").getUsageSummary!()]) {
    expect(summary.hasUnknownCost).toBe(false);
    expect(summary).toMatchObject({ costUsd: 0.2, billedEstimateUsd: 0.1, planCalls: 1, meteredCalls: 1,
      apiEquivalentUsd: 0.4, cacheUnreportedCalls: 1, unpricedCallCount: 1 });
    expect(summary.unpricedCalls).toEqual([expect.objectContaining({ stepId: "sol-2", provider: "openai", reason, plan: true })]);
    const sol = summary.models.find(row => row.provider === "openai")!;
    expect(sol).toMatchObject({ hasUnknownCost: false, planCalls: 1, modelCalls: 1 });
  }
});

it("still counts a metered call that failed after dispatch as unknown cost", async () => {
  const lead = bind(createKernel(), "lead");
  const failed = await dispatch(lead, "ds-1", "deepseek", "deepseek-flash", false);
  lead.holdUnknown(failed, "provider_call_failed_after_dispatch");
  const summary = lead.getUsageSummary!();
  expect(summary.hasUnknownCost).toBe(true);
  expect(summary.unpricedCalls).toEqual([expect.objectContaining({ stepId: "ds-1", reason: "provider_call_failed_after_dispatch" })]);
  expect(summary.unpricedCalls![0]).not.toHaveProperty("plan");
});
