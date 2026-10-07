import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildExecutionPlan } from "../../src/agents/cross-provider.js";
import { describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../../src/config/schema.js";
import { routeChildTask, childRoutingBudget, recordChildRoutingOutcome } from "../../src/agents/child-routing.js";
import { StaticModelsManager } from "../../src/llm/models-manager.js";
import { abilityPrior, updateAbility } from "../../src/agents/provider-selector-irt.js";
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

/** A parent on a real catalog model, with every allowed provider connected. */
async function catalogSession(provider: string, model: string, allowed: readonly string[],
  services: Record<string, unknown> = {}, billing: Readonly<Record<string, string>> = {}): Promise<Session> {
  const config = { ...defaultConfig(), model_provider: provider, model,
    agents: { cross_provider_enabled: true, cross_provider_auto: true, allowed_providers: [...allowed] } };
  const modelsManager = new StaticModelsManager({ config, fallbackProvider: provider, metadata: { env: {} } });
  return { modelInfo: await modelsManager.getModelInfo(model), config: {},
    providerService: { current: () => ({ provider, model }), environment: () => ({}),
      childProviderRoutingInfo: async (pair: { provider: string }) => ({ connected: true, billingSource: billing[pair.provider] ?? "byok" }) },
    services: { modelsManager, configStore: { current: () => config }, ...services },
  } as unknown as Session;
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
    expect(routed.result.rejected).toContainEqual(expect.objectContaining({ model: "deepseek-flash", reason: "quality_below_task_floor" }));
  });
});

describe("parent-first routing with the real model catalog", () => {
  const allowed = ["openai", "anthropic", "deepseek"];
  it.each([["openai", "gpt-6-astra"], ["anthropic", "claude-opus-5"]] as const)(
    "keeps an uncapped %s/%s parent on simple and hard reasoning", async (provider, model) => {
      const session = await catalogSession(provider, model, allowed);
      for (const complexity of ["simple", "standard", "hard"] as const) {
        const routed = await routeChildTask(session, { prompt: "Prove the invariant", taskKind: "reasoning", complexity });
        expect(routed.result.lambda).toBe(0);
        expect(routed.result).toMatchObject({ mode: "parent", selected: { provider, model } });
      }
      const coding = await routeChildTask(session, { prompt: "Implement the parser refactor", complexity: "hard" });
      expect(coding.result.selected).toMatchObject({ provider, model });
    });
  it("lets a hard task leave only toward a stronger model", async () => {
    const strong = await catalogSession("anthropic", "claude-opus-5", ["anthropic"]);
    const hard = await routeChildTask(strong, { prompt: "Prove the invariant", taskKind: "reasoning", complexity: "hard" });
    expect(hard.result.selected?.model).toBe("claude-opus-5");
    expect(hard.result.rejected).toContainEqual(expect.objectContaining({ model: "claude-sonnet-5", reason: "quality_below_task_floor" }));
    const weaker = await catalogSession("anthropic", "claude-sonnet-5", ["anthropic"]);
    const raised = await routeChildTask(weaker, { prompt: "Prove the invariant", taskKind: "reasoning", complexity: "hard" });
    expect(raised.result.selected?.model).not.toBe("claude-sonnet-5");
    expect(raised.result.selected?.adequacy).toBeGreaterThanOrEqual(0.92);
  });
  it("does not downgrade a deepseek-v4-pro parent on reasoning, even under a generous cap", async () => {
    const session = await catalogSession("deepseek", "deepseek-v4-pro", ["deepseek"]);
    for (const prompt of ["Prove the invariant", "Find the probability that the graph has a cycle"]) {
      // Standard complexity, so the cheaper flash model is adequate and ranked.
      const routed = await routeChildTask(session, { prompt, taskKind: "reasoning", complexity: "standard", maxCostUsd: 20 });
      expect(routed.features.skill).toBe("reasoning");
      expect(routed.result).toMatchObject({ mode: "parent", selected: { model: "deepseek-v4-pro" } });
      // Both priors come from the same maintained scale.
      const flash = routed.result.ranked.find(item => item.model === "deepseek-flash")!;
      expect(flash.ability.mean).toBeLessThan(routed.result.selected!.ability.mean);
    }
  });
  describe("a cap never makes a child more expensive", () => {
    const pick = (routed: Awaited<ReturnType<typeof routeChildTask>>) =>
      [`${routed.result.selected?.provider}/${routed.result.selected?.model}`, routed.result.selected?.estimatedCostUsd] as const;
    it.each([
      ["a grok-4.6 parent that cannot hold the context, simple extraction", ["grok", "grok-4.6", ["deepseek", "openai"]],
        { prompt: "Extract a short list of record IDs", contextTokens: 600_000 }, "openai/gpt-6-luna"],
      ["a grok-4.6 parent that cannot hold the context, standard reasoning", ["grok", "grok-4.6", ["deepseek", "openai"]],
        { prompt: "Find the probability that the graph has a cycle", taskKind: "reasoning", complexity: "standard", contextTokens: 600_000 },
        "deepseek/deepseek-flash"],
      ["a gpt-6-luna parent below the standard reasoning floor", ["openai", "gpt-6-luna", ["deepseek", "openai"]],
        { prompt: "Find the probability that the graph has a cycle", taskKind: "reasoning", complexity: "standard" }, "deepseek/deepseek-flash"],
    ] as const)("starts from the least expensive adequate model for %s", async (_name, [provider, model, allowed], request, cheapest) => {
      const session = await catalogSession(provider, model, allowed);
      const [uncappedPair, uncappedCost] = pick(await routeChildTask(session, request));
      expect(uncappedPair).toBe(cheapest);
      for (const maxCostUsd of [1, 5, 20]) {
        const [cappedPair, cappedCost] = pick(await routeChildTask(session, { ...request, maxCostUsd }));
        expect(cappedPair).toBe(cheapest);
        expect(cappedCost).toBeLessThanOrEqual(uncappedCost!);
      }
    });
    it("moves a subscription parent with unknown dollars to the least expensive adequate model under a cap", async () => {
      const session = await catalogSession("openai", "gpt-6-astra", ["deepseek", "anthropic"], {}, { openai: "sign_in" });
      const request = { prompt: "Extract a short list of record IDs" };
      expect((await routeChildTask(session, request)).result).toMatchObject({ mode: "parent", selected: { model: "gpt-6-astra" } });
      for (const maxCostUsd of [1, 5, 20]) {
        const routed = await routeChildTask(session, { ...request, maxCostUsd });
        expect(routed.result.rejected).toContainEqual(expect.objectContaining({ model: "gpt-6-astra", reason: "price_unknown" }));
        expect(pick(routed)[0]).toBe("deepseek/deepseek-flash");
      }
    });
    it("keeps an adequate parent under balanced at any cap; economy trades it for a material saving", async () => {
      const session = await catalogSession("openai", "gpt-6-astra", ["deepseek", "openai"]);
      const request = { prompt: "Extract a short list of record IDs" };
      for (const maxCostUsd of [0.8, 1, 2, 5, 20]) {
        for (const cost of ["quality", "balanced"] as const) {
          expect((await routeChildTask(session, { ...request, maxCostUsd, preferences: { cost } })).result)
            .toMatchObject({ mode: "parent", selected: { model: "gpt-6-astra" } });
        }
      }
      // The parent would use most of a $1 cap; an adequate model saves nearly all of it.
      const economy = await routeChildTask(session, { ...request, maxCostUsd: 1, preferences: { cost: "economy" } });
      expect(economy.result.mode).toBe("utility");
      expect(economy.result.selected!.estimatedCostUsd).toBeLessThan(0.05);
      // Against a $20 cap the same saving is not material.
      expect((await routeChildTask(session, { ...request, maxCostUsd: 20, preferences: { cost: "economy" } })).result.selected?.model)
        .toBe("gpt-6-astra");
    });
  });

  it("plans no cascade from a strong parent without paired or verified evidence", async () => {
    const verifier = { prepare: vi.fn(async () => ({ available: true as const, retrySafe: true, costUsd: 0, latencyMs: 1,
      check: async () => "pass" as const })) };
    const session = await catalogSession("openai", "gpt-6-astra", ["deepseek", "openai"], { childRoutingVerifier: verifier });
    for (const [maxCostUsd, request] of [[1, { prompt: "Extract a short list of record IDs" }],
      [2, { prompt: "Find the probability that the graph has a cycle", taskKind: "reasoning" as const, complexity: "standard" as const }]] as const) {
      const routed = await routeChildTask(session, { ...request, maxCostUsd });
      expect(routed.verification).toBeDefined();
      expect(routed.result.cascade).toBeUndefined();
      expect(routed.result).toMatchObject({ mode: "parent", selected: { model: "gpt-6-astra" } });
    }
  });

  it.each([1, 10])("plans no cascade from paired outcomes with %i failures and no rescue, at any cap", async failures => {
    const verifier = { prepare: vi.fn(async () => ({ available: true as const, retrySafe: true, costUsd: 0, latencyMs: 1,
      conditional: [{ first: "deepseek/deepseek-v4-pro", second: "openai/gpt-6-astra", failures, recovered: 0 }],
      check: async () => "pass" as const })) };
    const verified = await catalogSession("openai", "gpt-6-astra", ["deepseek", "openai"], { childRoutingVerifier: verifier });
    const plain = await catalogSession("openai", "gpt-6-astra", ["deepseek", "openai"]);
    for (const maxCostUsd of [undefined, 1, 2, 20]) {
      for (const request of [{ prompt: "Extract a short list of record IDs" },
        { prompt: "Find the probability that the graph has a cycle", taskKind: "reasoning" as const, complexity: "standard" as const }]) {
        const capped = { ...request, ...(maxCostUsd !== undefined ? { maxCostUsd } : {}) };
        const routed = await routeChildTask(verified, capped);
        expect(routed.verification).toBeDefined();
        expect(routed.result.cascade).toBeUndefined();
        expect(routed.result.mode).not.toBe("cascade");
        // The row changes nothing: the choice is the one made without a verifier.
        expect(routed.result.selected?.model).toBe((await routeChildTask(plain, capped)).result.selected?.model);
      }
    }
  });

  it("does not move a deepseek-flash parent up a tier after one verified pass", async () => {
    const session = await catalogSession("deepseek", "deepseek-flash", ["deepseek"]);
    const request = { prompt: "Find the probability that the graph has a cycle", taskKind: "reasoning" as const, complexity: "standard" as const };
    const { features } = await routeChildTask(session, request);
    let ability = abilityPrior("deepseek", "deepseek-v4-pro", features.skill);
    ability = updateAbility(ability, features, true);
    const once = await routeChildTask(session, { ...request, outcomes: { aggregates: [], health: [], abilities: [ability] } });
    expect(once.result).toMatchObject({ mode: "parent", selected: { model: "deepseek-flash" } });
  });

  describe("a cheap deepseek-flash parent with the evaluation's providers and $0.05 cap", () => {
    const providers = ["deepseek", "meta", "kimi", "minimax"];
    const prompts = ["Extract the invoice numbers from these lines as a JSON array.",
      "Write a Python function that merges overlapping intervals.",
      "How many paths of length 4 exist in this graph? Return the integer."];
    it("keeps the parent on a cold start", async () => {
      const session = await catalogSession("deepseek", "deepseek-flash", providers);
      for (const prompt of prompts) {
        const routed = await routeChildTask(session, { prompt, maxCostUsd: 0.05, requiresTools: false });
        expect(routed.result).toMatchObject({ mode: "parent", selected: { model: "deepseek-flash" } });
      }
    });
    it("tries an adequate cheaper model first only behind a host verifier, with the parent as the anchor", async () => {
      const cheap = ["meta/muse-spark-1.3-contributor", "meta/muse-spark-1.2-contributor"];
      const verifier = { prepare: vi.fn(async () => ({ available: true as const, retrySafe: true, costUsd: 0, latencyMs: 1,
        targetQuality: 0.75, conditional: cheap.map(first => ({ first, second: "deepseek/deepseek-flash", failures: 6, recovered: 5 })),
        check: async () => "pass" as const })) };
      const session = await catalogSession("deepseek", "deepseek-flash", providers, { childRoutingVerifier: verifier });
      for (const prompt of prompts) {
        const routed = await routeChildTask(session, { prompt, maxCostUsd: 0.05, requiresTools: false });
        expect(routed.result.mode).toBe("cascade");
        expect(routed.result.cascade!.candidates.map(item => `${item.provider}/${item.model}`)).toEqual([
          expect.stringMatching(/^meta\/muse-spark-1\.[23]-contributor$/u), "deepseek/deepseek-flash"]);
        expect(routed.result.cascade!.worstCaseCostUsd).toBeLessThanOrEqual(0.05);
      }
    });
  });
});
