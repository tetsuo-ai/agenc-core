import { describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../../src/config/schema.js";
import { routeChildTask, childRoutingBudget } from "../../src/agents/child-routing.js";
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
  it("explicit task difficulty selects a strong model for hard reasoning", async () => {
    const { session } = fixture(["deepseek"]);
    const routed = await routeChildTask(session, { prompt: "Prove the invariant", taskKind: "reasoning", complexity: "hard" });
    expect(routed.result.selected).toMatchObject({ provider: "deepseek", model: "deepseek-v4-pro" });
  });
});
