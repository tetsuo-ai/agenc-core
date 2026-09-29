import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildExecutionPlan } from "../../src/agents/cross-provider.js";
import { describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../../src/config/schema.js";
import { routeChildTask, childRoutingBudget, recordChildRoutingOutcome } from "../../src/agents/child-routing.js";
import type { Session } from "../../src/session/session.js";

function fixture(connected: readonly string[], allowed = ["deepseek", "openai"]) {
  const config = { ...defaultConfig(), model_provider: "grok", model: "grok-4.6",
    agents: { cross_provider_enabled: true, cross_provider_auto: true, allowed_providers: allowed } };
  const readiness = vi.fn(async ({ provider }: { provider: string }) => connected.includes(provider));
  const session = {
    modelInfo: { slug: "grok-4.6" }, config: {},
    providerService: { current: () => ({ provider: "grok", model: "grok-4.6" }),
      environment: () => ({}), isChildProviderConnected: readiness },
    services: { configStore: { current: () => config } },
  } as unknown as Session;
  return { session, readiness };
}

describe("child routing integration", () => {
  it("an explicit successful child restores a provider after its funds block", async () => {
    const home = await mkdtemp(join(tmpdir(), "child-routing-health-"));
    try {
      const { session } = fixture(["deepseek"]);
      Object.assign(session.services.configStore!, { homeContext: { path: home } });
      const plan = { task: { text: "Extract names" } } as ChildExecutionPlan;
      const terminal = { provider: "deepseek", model: "deepseek-flash", reason: "insufficient_funds" as const,
        retryable: false, dispatch: "sent" as const, completedWork: "", unfinishedWork: "Extract names" };
      await recordChildRoutingOutcome(session, plan, { receiptId: "failed", terminal, latencyMs: 2 });
      expect((await routeChildTask(session, { prompt: "Extract names" })).result.selected).toBeUndefined();
      await recordChildRoutingOutcome(session, plan, { receiptId: "manual-success", terminal: { ...terminal, reason: "completed" }, latencyMs: 2 });
      expect((await routeChildTask(session, { prompt: "Extract names" })).result.selected?.provider).toBe("deepseek");
    } finally { await rm(home, { recursive: true, force: true }); }
  });
  it("retains explicit tool-free task requirements", async () => {
    const { session } = fixture(["deepseek"]);
    expect((await routeChildTask(session, { prompt: "Extract names", requiresTools: false })).task.requiresTools).toBe(false);
  });
  it("chooses an allowed connected candidate and checks authority once per provider", async () => {
    const { session, readiness } = fixture(["deepseek"]);
    const routed = await routeChildTask(session, { prompt: "Extract a short list of names" });
    expect(routed.result.selected).toMatchObject({ provider: "deepseek", model: "deepseek-flash" });
    expect(routed.task.inputTokens).toBeGreaterThan(16_384);
    expect(readiness.mock.calls.filter(([pair]) => pair.provider === "deepseek")).toHaveLength(1);
    expect(routed.result.ranked.every(pair => pair.provider === "deepseek")).toBe(true);
  });
  it("does not inherit a disallowed parent when all allowed providers are disconnected", async () => {
    const { session } = fixture([]);
    expect((await routeChildTask(session, { prompt: "Review a small function" })).result.selected).toBeUndefined();
  });
  it("uses catalog vision capabilities and refuses undersized context", async () => {
    const { session } = fixture(["deepseek"]);
    const vision = await routeChildTask(session, { prompt: "Inspect screenshot", requiresVision: true });
    expect(vision.result.ranked.every(pair => pair.model !== "deepseek-v4-pro")).toBe(true);
    expect(vision.result.selected?.model).toBe("deepseek-flash");
    expect((await routeChildTask(session, { prompt: "Review", contextTokens: 2_000_000 })).result.selected).toBeUndefined();
  });
  it("subtracts reported spend and held-unknown reservations from the ancestor ceiling", async () => {
    const { session } = fixture(["deepseek"]);
    Object.assign(session.services, { executionAdmission: {
      scope: { maxCostUsd: 1 }, getUsageSummary: () => ({ costUsd: 0.7, heldCostUsd: 0.3 }),
    } });
    expect(childRoutingBudget(session, 20)).toBeCloseTo(0);
    expect((await routeChildTask(session, { prompt: "Extract names", maxCostUsd: 20 })).result.selected).toBeUndefined();
  });
  it("prefers authoritative ancestor remaining dollars over task-local usage", () => {
    const { session } = fixture(["deepseek"]);
    Object.assign(session.services, { executionAdmission: { scope: { maxCostUsd: 1 },
      getUsageSummary: () => ({ costUsd: 0, heldCostUsd: 0 }), getRemainingCostUsd: () => 0.02 } });
    expect(childRoutingBudget(session)).toBe(0.02);
    expect(childRoutingBudget(session, 0.5)).toBe(0.02);
    expect(childRoutingBudget(session, 0.01)).toBe(0.01);
  });
  it("does not invent a cap when authoritative admission is uncapped", () => {
    const { session } = fixture(["deepseek"]);
    Object.assign(session.services, { executionAdmission: { scope: {}, getRemainingCostUsd: () => undefined } });
    expect(childRoutingBudget(session)).toBeUndefined();
    expect(childRoutingBudget(session, 0.5)).toBe(0.5);
  });
  it("difficulty labels do not force an expensive model over current ability evidence", async () => {
    const { session } = fixture(["deepseek"]);
    const routed = await routeChildTask(session, { prompt: "Prove the invariant", taskKind: "reasoning", complexity: "hard" });
    expect(routed.result.selected).toMatchObject({ provider: "deepseek", model: "deepseek-flash" });
  });
});
