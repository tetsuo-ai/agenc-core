import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildExecutionPlan } from "../../src/agents/cross-provider.js";
import { describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../../src/config/schema.js";
import { routeChildTask, childRoutingBudget, recordChildRoutingOutcome } from "../../src/agents/child-routing.js";
import { StaticModelsManager } from "../../src/llm/models-manager.js";
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

const completed = { provider: "deepseek", model: "deepseek-flash", reason: "completed" as const,
  retryable: false, dispatch: "sent" as const, completedWork: "Names", unfinishedWork: "" };

async function withHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "child-routing-outcomes-"));
  try { await run(home); } finally { await rm(home, { recursive: true, force: true }); }
}

describe("child routing outcome file", () => {
  it.each([
    ["off", { cross_provider_enabled: false, cross_provider_auto: false }],
    ["cross-provider only", { cross_provider_enabled: true, cross_provider_auto: false }],
    ["automatic choice only", { cross_provider_enabled: false, cross_provider_auto: true }],
  ] as const)("writes nothing while automatic selection is %s", async (_name, agents) => {
    await withHome(async home => {
      const { session } = fixture(["deepseek"]);
      Object.assign(session.services.configStore!, { homeContext: { path: home }, current: () => ({ agents }) });
      const plan = { task: { text: "Extract names" } } as ChildExecutionPlan;
      await recordChildRoutingOutcome(session, plan, { receiptId: "planned", terminal: completed, latencyMs: 2 });
      await recordChildRoutingOutcome(session, undefined, { receiptId: "inherited", terminal: completed, latencyMs: 2 });
      await expect(stat(join(home, "state"))).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("does not cool down a provider for the child's own role timeout", async () => {
    await withHome(async home => {
      const { session } = fixture(["deepseek"]);
      Object.assign(session.services.configStore!, { homeContext: { path: home } });
      const plan = { task: { text: "Extract names" } } as ChildExecutionPlan;
      await recordChildRoutingOutcome(session, plan, { receiptId: "role-timeout", latencyMs: 2,
        terminal: { ...completed, reason: "timeout", retryable: false, dispatch: "unknown" } });
      expect((await routeChildTask(session, { prompt: "Extract names" })).result.selected?.provider).toBe("deepseek");
      await recordChildRoutingOutcome(session, plan, { receiptId: "provider-timeout", latencyMs: 2,
        terminal: { ...completed, reason: "timeout", retryable: true, dispatch: "unknown" } });
      expect((await routeChildTask(session, { prompt: "Extract names" })).result.rejected)
        .toContainEqual(expect.objectContaining({ provider: "deepseek", reason: "provider_cooldown" }));
    });
  });

  it("clears a provider's failure when a child without a routing plan completes on it", async () => {
    await withHome(async home => {
      const { session } = fixture(["deepseek"]);
      Object.assign(session.services.configStore!, { homeContext: { path: home } });
      const plan = { task: { text: "Extract names" } } as ChildExecutionPlan;
      await recordChildRoutingOutcome(session, plan, { receiptId: "throttled", latencyMs: 2,
        terminal: { ...completed, reason: "rate_limited", retryable: true, retryAfterMs: 600_000, dispatch: "sent" } });
      expect((await routeChildTask(session, { prompt: "Extract names" })).result.selected).toBeUndefined();
      await recordChildRoutingOutcome(session, undefined, { receiptId: "explicit-child", terminal: completed, latencyMs: 2 });
      expect((await routeChildTask(session, { prompt: "Extract names" })).result.selected?.provider).toBe("deepseek");
      const history = JSON.parse(await readFile(join(home, "state", "child-routing-outcomes.json"), "utf8")) as {
        aggregates: unknown[]; health: { provider: string; consecutiveFailures: number }[] };
      // The unplanned child changed provider health only.
      expect(history.aggregates).toHaveLength(1);
      expect(history.health).toContainEqual(expect.objectContaining({ provider: "deepseek", consecutiveFailures: 0 }));
    });
  });
});

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
    expect(routed.result.ranked.every(pair => pair.provider === "deepseek" || pair.provider === "grok")).toBe(true);
  });
  it("finds nothing when allowed providers are disconnected and the parent model does not fit", async () => {
    // This stub parent model has no context window, so it cannot qualify.
    const { session } = fixture([]);
    expect((await routeChildTask(session, { prompt: "Review a small function" })).result.selected).toBeUndefined();
  });
  it("counts the parent's own model as a candidate when its provider is not allowed", async () => {
    const { session } = fixture([]);
    const config = { ...defaultConfig(), model_provider: "grok", model: "grok-4.6" };
    Object.assign(session, { modelInfo: await new StaticModelsManager({ config, fallbackProvider: "grok", metadata: { env: {} } })
      .getModelInfo("grok-4.6") });
    const routed = await routeChildTask(session, { prompt: "Review a small function" });
    expect(routed.result.selected).toMatchObject({ provider: "grok", model: "grok-4.6" });
    expect(routed.result.ranked.map(pair => pair.provider)).toEqual(["grok"]);
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
  it("explicit task difficulty selects a strong model for hard reasoning", async () => {
    const { session } = fixture(["deepseek"]);
    const routed = await routeChildTask(session, { prompt: "Prove the invariant", taskKind: "reasoning", complexity: "hard" });
    expect(routed.result.selected).toMatchObject({ provider: "deepseek", model: "deepseek-v4-pro" });
  });
});
