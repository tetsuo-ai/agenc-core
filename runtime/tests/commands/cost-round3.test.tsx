import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { collectDaemonClientEnvOverrides, mergeDaemonClientEnvironment } from "../../src/app-server/client-env-snapshot.js";
import type { ExecutionAdmissionClient } from "../../src/budget/admission-client.js";
import { ExecutionAdmissionKernel } from "../../src/budget/execution-admission-kernel.js";
import { buildCostReport, formatCostReport, unpricedCallDescription } from "../../src/commands/cost.js";
import type { SlashCommandContext } from "../../src/commands/types.js";
import { isChatGptPlan, planAccountingEnabled } from "../../src/session/usage-billing.js";
import { isAdmissionUsageSummary } from "../../src/session/usage-summary.js";
import { CostUsageModal } from "../../src/tui/components/v2/CostUsageModal.js";
import { renderToString } from "../../src/utils/staticRender.js";

vi.mock("bun:bundle", () => ({ feature: () => false }));

// Job coste2e37 round 3: review37's should-fix items C2, C3 and C4 on dfcfbb2c787f.

describe("C2: AGENC_PLAN_ACCOUNTING reaches a running daemon", () => {
  afterEach(() => vi.unstubAllEnvs());
  const signIn = { extra: { authMode: "oauth", chatgptBackend: true } } as never;

  it("travels in the client environment snapshot and is read from the session's own environment", () => {
    const snapshot = collectDaemonClientEnvOverrides({ AGENC_PLAN_ACCOUNTING: "off" });
    expect(snapshot.AGENC_PLAN_ACCOUNTING).toBe("off");
    const session = mergeDaemonClientEnvironment({}, snapshot);
    vi.stubEnv("AGENC_PLAN_ACCOUNTING", undefined);   // the daemon itself was started without the switch
    expect(planAccountingEnabled(session)).toBe(false);
    expect(isChatGptPlan("openai", signIn, session)).toBe(false);
  });

  it("does not take the daemon's own value for a client that did not set it", () => {
    const session = mergeDaemonClientEnvironment({ AGENC_PLAN_ACCOUNTING: "off" }, collectDaemonClientEnvOverrides({}));
    vi.stubEnv("AGENC_PLAN_ACCOUNTING", "off");
    expect(planAccountingEnabled(session)).toBe(true);
    expect(isChatGptPlan("openai", signIn, session)).toBe(true);
  });
});

let home: string;
let cwd: string;
const kernels: ExecutionAdmissionKernel[] = [];
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agenc-cost-round3-"));
  cwd = join(home, "project");
  mkdirSync(join(cwd, ".git"), { recursive: true });
});
afterEach(() => {
  for (const kernel of kernels.splice(0)) kernel.close();
  rmSync(home, { recursive: true, force: true });
});
function bind(runId: string): ExecutionAdmissionClient {
  const kernel = new ExecutionAdmissionKernel({ agencHome: home });
  kernels.push(kernel);
  return kernel.bindClient({ cwd, scope: { runId, sessionId: runId, autonomous: false } });
}
async function model(client: ExecutionAdmissionClient, stepId: string, costUsd: number, plan = false) {
  const lease = await client.acquire({ stepId, kind: "model_turn", model: plan ? "gpt-6.1-sol" : "deepseek-flash",
    provider: plan ? "openai" : "deepseek", maxInputTokens: 20, maxOutputTokens: 20, maxCostUsd: 0.5 });
  const id = lease.reservation.reservationId;
  client.markDispatched(id, { boundary: "provider_wire", timestamp: "2026-11-15T02:00:00Z",
    details: plan ? { billingMode: "plan" } : {} });
  client.reconcile(id, { inputTokens: 10, outputTokens: 5, costUsd,
    billingDetails: plan ? { billingMode: "plan", cachedInputTokens: 0, apiEquivalentUsd: 0.4 }
      : { billingMode: "metered", cachedInputTokens: 5, offPeakEligibleCostUsd: costUsd } });
  client.acknowledgeCompletion(id);
}
async function tool(client: ExecutionAdmissionClient, stepId: string, costUsd: number) {
  const lease = await client.acquire({ stepId, kind: "tool_exec", provider: "deepseek", maxInputTokens: 0, maxOutputTokens: 0, maxCostUsd: 0.5 });
  const id = lease.reservation.reservationId;
  client.markDispatched(id, { boundary: "tool_exec", timestamp: "2026-11-15T02:00:00Z" });
  client.reconcile(id, { inputTokens: 0, outputTokens: 0, costUsd });
  client.acknowledgeCompletion(id);
}
function context(usage: unknown, tasks: Record<string, unknown>): SlashCommandContext {
  return { session: { conversationId: "lead", services: {} }, argsRaw: "", cwd: "/tmp/project", home: "/tmp",
    appState: { getAppState: () => ({ tasks }), getSessionUsage: () => usage } } as unknown as SlashCommandContext;
}
const task = (agentId: string, description: string) => ({ type: "local_agent", agentId, agentType: "runner", description, status: "completed" });
const tasks = { a: task("worker-1", "Monowire"), b: task("worker-2", "Librarian") };
const sum = (values: readonly number[]) => Math.round(values.reduce((a, b) => a + b, 0) * 1e9) / 1e9;

describe("C3: BY AGENT includes tool charges and adds up to the total", () => {
  it("shows a $0.10 model call and a $0.05 tool charge as $0.15 for the agent, and a tool-only agent", async () => {
    const lead = bind("lead");
    const worker = lead.forSession({ runId: "worker-1", sessionId: "worker-1" });
    const toolOnly = lead.forSession({ runId: "worker-2", sessionId: "worker-2" });
    await model(lead, "sol-1", 0, true);
    await model(worker, "ds-1", 0.1);
    await tool(worker, "search-1", 0.05);
    await tool(toolOnly, "fetch-1", 0.02);
    const usage = lead.getUsageSummary!();
    expect(isAdmissionUsageSummary(usage)).toBe(true);
    expect(usage.costUsd).toBeCloseTo(0.17, 9);
    const rows = usage.agentModels!;
    expect(sum(rows.map(row => row.costUsd))).toBe(sum([usage.costUsd]));
    expect(sum(rows.filter(row => row.runId === "worker-1").map(row => row.costUsd))).toBe(0.15);
    expect(rows.find(row => row.runId === "worker-2")).toMatchObject({ kind: "tools", costUsd: 0.02, modelCalls: 0 });
    // The billed rows add up to the billed total too (the model call is off-peak; tool fees keep their full price).
    expect(usage.billedEstimateUsd).toBeCloseTo(0.12, 9);
    expect(sum(rows.map(row => row.billedEstimateUsd ?? row.costUsd))).toBe(0.12);

    const report = buildCostReport(context(usage, tasks));
    const out = formatCostReport(report);
    const modal = await renderToString(createElement(CostUsageModal, { report, onDone: () => {}, active: false }), { columns: 170, rows: 60 });
    for (const surface of [out, modal]) {
      expect(surface).toContain("Monowire · deepseek/deepseek-flash");
      expect(surface).toContain("Monowire · tool charges");
      expect(surface).toContain("1 charge · $0.050 billed");
      expect(surface).toContain("Librarian · tool charges");
      expect(surface).toContain("1 charge · $0.020 billed");
      expect(surface).not.toContain("(peak est.)");
    }
  });
});

describe("C4: calls without reported usage show the agent, the model and a plain reason", () => {
  const failed = { reservationId: "r1", runId: "conv-mwjixu6l", stepId: "model:sub-conv-mwjixu6l-4:4:0:sample-3:primary",
    kind: "model_turn", model: "gpt-6.1-sol", provider: "openai", reason: "provider_call_failed_after_dispatch", plan: true as const };
  const cancelled = { ...failed, reservationId: "r2", runId: "worker-1", stepId: "model:sub-worker-1-2:2:0:sample-1:primary",
    model: "deepseek-flash", provider: "deepseek", reason: "cancelled_after_dispatch:interrupted", plan: undefined };

  it("names the agent instead of step and run ids, in both surfaces", async () => {
    const usage = { runId: "conv-mwjixu6l", sequence: 3, costUsd: 0.01, heldCostUsd: 0, inputTokens: 10, outputTokens: 5,
      totalTokens: 15, modelCalls: 1, hasUnknownCost: true, unpricedCalls: [failed, cancelled], unpricedCallCount: 2,
      models: [], agents: [] };
    const report = buildCostReport(context(usage, tasks));
    const out = formatCostReport(report);
    const modal = await renderToString(createElement(CostUsageModal, { report, onDone: () => {}, active: false }), { columns: 170, rows: 60 });
    for (const surface of [out, modal]) {
      expect(surface).toContain("lead · openai/gpt-6.1-sol model call · failed after it was sent, no usage reported; ChatGPT plan call, nothing billed");
      expect(surface).toContain("Monowire · deepseek/deepseek-flash model call · cancelled after it was sent (interrupted), no usage reported");
      for (const id of ["conv-mwjixu6l", "sample-3", "primary", "worker-1", "run "]) expect(surface).not.toContain(id);
    }
  });

  it("has a plain wording for an agent it cannot name", () => {
    expect(unpricedCallDescription({ ...failed, plan: undefined })).toBe("an agent · openai/gpt-6.1-sol model call · failed after it was sent, no usage reported");
  });
});
