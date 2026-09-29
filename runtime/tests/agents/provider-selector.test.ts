import { describe, expect, it } from "vitest";
import { classifyChildTask, estimateChildCandidateCost, selectChildProvider } from "../../src/agents/provider-selector.js";
import { CHILD_ROUTING_PROFILE_REVISION } from "../../src/agents/provider-selector-profiles.js";
import type { ChildProviderCandidate, ChildRoutingAggregate, ChildSelectionTask } from "../../src/agents/provider-selector.js";

const task: ChildSelectionTask = { kind: "review", complexity: "simple", requiresTools: true, inputTokens: 2_000, outputTokens: 500 };
const flash: ChildProviderCandidate = { provider: "deepseek", model: "deepseek-v4-flash", connected: true, allowed: true,
  supportsToolUse: true, supportsVision: true, supportsReasoning: true, contextWindow: 100_000, maxOutputTokens: 8_192,
  cost: { inputUsdPer1K: 0.0001, outputUsdPer1K: 0.0002 } };
const pro: ChildProviderCandidate = { ...flash, model: "deepseek-v4-pro", supportsVision: false,
  cost: { inputUsdPer1K: 0.003, outputUsdPer1K: 0.012 } };
const astra: ChildProviderCandidate = { ...flash, provider: "openai", model: "gpt-6-astra",
  cost: { inputUsdPer1K: 0.01, outputUsdPer1K: 0.04 } };

function choose(candidates: readonly ChildProviderCandidate[], changes: Partial<ChildSelectionTask> = {}) {
  return selectChildProvider({ task: { ...task, ...changes }, candidates, nowMs: 100_000 });
}

describe("child provider selection", () => {
  it("does not upgrade a short review because code is hard to trust", () => {
    expect(classifyChildTask("Review this small function. Flag confusing naming that makes the math hard to trust."))
      .toEqual({ kind: "review", complexity: "simple" });
    expect(classifyChildTask("Perform a hard review of this algorithm"))
      .toEqual({ kind: "review", complexity: "hard" });
  });
  it("uses a cheaper sufficient model for simple work and a stronger model for hard work", () => {
    expect(choose([astra, pro, flash]).selected?.model).toBe(flash.model);
    expect(choose([astra, flash, pro], { kind: "reasoning", complexity: "hard" }).selected?.model).toBe(pro.model);
  });

  it.each([
    [{ connected: false }, {}, "provider_not_connected"],
    [{ allowed: false }, {}, "provider_not_allowed"],
    [{ supportsToolUse: false }, {}, "client_tools_unsupported"],
    [{ supportsVision: false }, { requiresVision: true }, "vision_unsupported"],
    [{ supportsReasoning: false }, { requiresReasoning: true }, "reasoning_unsupported"],
    [{ contextWindow: 2_500 }, {}, "context_insufficient"],
    [{ contextWindow: undefined }, {}, "context_insufficient"],
    [{ maxOutputTokens: 499 }, {}, "output_limit_insufficient"],
    [{ maxOutputTokens: undefined }, {}, "output_limit_insufficient"],
    [{ cost: undefined }, {}, "price_unknown"],
    [{ cost: { inputUsdPer1K: 0, outputUsdPer1K: 0 } }, {}, "price_unknown"],
    [{ cost: { inputUsdPer1K: 0.1, outputUsdPer1K: 0.2, costEstimated: true } }, {}, "price_unknown"],
    [{ cost: { inputUsdPer1K: -1, outputUsdPer1K: 0.2 } }, {}, "price_unknown"],
    [{ model: "new-mega-ultra-pro" }, {}, "model_profile_unknown"],
    [{}, { maxCostUsd: 0 }, "task_budget_insufficient"],
    [{}, { maxCostUsd: -1 }, "invalid_task_requirements"],
    [{}, { inputTokens: Number.NaN }, "invalid_task_requirements"],
    [{}, { outputTokens: 0 }, "invalid_task_requirements"],
    [{}, { expectedModelCalls: Number.POSITIVE_INFINITY }, "invalid_task_requirements"],
  ] as const)("rejects an ineligible candidate (%s)", (candidate, requirements, reason) => {
    const result = choose([{ ...flash, ...candidate }], requirements);
    expect(result.selected).toBeUndefined();
    expect(result.rejected[0]?.reason).toBe(reason);
  });

  it("requires explicit local zero-cost evidence before treating a model as free", () => {
    expect(choose([{ ...flash, cost: { inputUsdPer1K: 0, outputUsdPer1K: 0, localZeroCost: true } }],
      { maxCostUsd: 0 }).selected?.estimatedCostUsd).toBe(0);
  });

  it("does not infer a profile from prototype properties or unlisted snapshots", () => {
    for (const candidate of [{ ...flash, provider: "constructor" }, { ...flash, model: "toString" },
      { ...astra, model: "gpt-6-astra-2099-99-99" }]) {
      expect(choose([candidate]).rejected[0]?.reason).toBe("model_profile_unknown");
    }
  });

  it("does not pick a cheap tool-only or text-only model for a vision task", () => {
    expect(choose([pro, astra], { requiresVision: true, complexity: "hard" }).selected?.model).toBe(astra.model);
  });

  it("accounts for call count, speed and long-context pricing before budget filtering", () => {
    const candidate = { ...flash, serviceTier: "priority", cost: { inputUsdPer1K: 0.001, outputUsdPer1K: 0.002,
      fastMode: { inputUsdPer1K: 0.002, outputUsdPer1K: 0.004 },
      longContext: { aboveInputTokens: 1_000, rates: { inputUsdPer1K: 0.003, outputUsdPer1K: 0.006,
        fastMode: { inputUsdPer1K: 0.006, outputUsdPer1K: 0.012 } } } } };
    expect(estimateChildCandidateCost(candidate, { ...task, expectedModelCalls: 2 })).toBeCloseTo(0.036);
    expect(choose([candidate], { expectedModelCalls: 2, maxCostUsd: 0.035 }).selected).toBeUndefined();
    expect(choose([candidate], { expectedModelCalls: 2, maxCostUsd: 0.036 }).selected).toBeDefined();
  });

  it("refuses undocumented fast-mode pricing under a dollar cap", () => {
    const candidate = { ...flash, serviceTier: "priority", cost: { ...flash.cost!, fastModeRequiresOwnRate: true } };
    expect(choose([candidate], { maxCostUsd: 1 }).rejected[0]?.reason).toBe("price_unknown");
  });

  it("respects an explicit override without relaxing authority or capability requirements", () => {
    const input = { task, candidates: [flash, pro], override: { provider: pro.provider, model: pro.model } };
    expect(selectChildProvider(input).selected?.model).toBe(pro.model);
    expect(selectChildProvider({ ...input, candidates: [flash, { ...pro, connected: false }] }).selected).toBeUndefined();
    const unknown = { ...pro, model: "user-finetune" };
    expect(selectChildProvider({ task, candidates: [unknown], override: unknown }).selected?.model).toBe(unknown.model);
    expect(selectChildProvider({ task: { ...task, maxCostUsd: 0.001 }, candidates: [unknown], override: unknown }).selected).toBeUndefined();
  });

  it("requires a price for an overridden model when a dollar cap applies", () => {
    const unknownPrice = { ...flash, cost: undefined };
    expect(selectChildProvider({ task, candidates: [unknownPrice], override: flash }).selected).toBeDefined();
    expect(selectChildProvider({ task: { ...task, maxCostUsd: 1 }, candidates: [unknownPrice], override: flash }).selected).toBeUndefined();
  });

  it("can use a connected subscription without inventing an API price, unless a dollar cap applies", () => {
    const subscribed = { ...astra, billingSource: "sign_in" as const };
    const uncapped = choose([subscribed]);
    expect(uncapped.selected?.model).toBe(astra.model);
    expect(uncapped.selected?.estimatedCostUsd).toBeUndefined();
    expect(uncapped.reason).toContain("connected subscription");
    expect(choose([subscribed], { maxCostUsd: 10 }).rejected[0]?.reason).toBe("price_unknown");
  });

  it("excludes all models on a provider during cooldown and honors Retry-After expiry", () => {
    const input = { task, candidates: [flash, pro, astra], outcomes: { aggregates: [], health: [
      { provider: "deepseek", cooldownUntilMs: 101_000, consecutiveFailures: 1 },
    ] } };
    expect(selectChildProvider({ ...input, nowMs: 100_000 }).selected?.provider).toBe("openai");
    expect(selectChildProvider({ ...input, nowMs: 101_000 }).selected?.model).toBe(flash.model);
  });

  it("does not silently expire funds or authentication blocks", () => {
    for (const blockedReason of ["insufficient_funds", "auth_required"] as const) {
      const result = selectChildProvider({ task, candidates: [flash, astra], nowMs: 1e12,
        outcomes: { aggregates: [], health: [{ provider: "deepseek", cooldownUntilMs: 0, consecutiveFailures: 1, blockedReason }] } });
      expect(result.selected?.provider).toBe("openai");
    }
  });

  it("learns from repeated task failures without overreacting to one sample", () => {
    const aggregate: ChildRoutingAggregate = { provider: flash.provider, model: flash.model, taskKind: task.kind,
      complexity: task.complexity, profileRevision: CHILD_ROUTING_PROFILE_REVISION,
      attempts: 1, successes: 0, infrastructureFailures: 0, qualityObservations: 1, qualitySuccesses: 0,
      latencySamples: 1, latencyTotalMs: 2_000, costSamples: 1, costTotalUsd: 0.001, lastObservedAtMs: 100_000 };
    const input = { task, candidates: [flash, pro], nowMs: 100_000 };
    expect(selectChildProvider({ ...input, outcomes: { aggregates: [aggregate], health: [] } }).selected?.model).toBe(flash.model);
    const failures = { ...aggregate, attempts: 20, qualityObservations: 20 };
    expect(selectChildProvider({ ...input, outcomes: { aggregates: [failures], health: [] } }).selected?.model).toBe(pro.model);
    // Evidence from another task or a different profile revision does not transfer silently.
    expect(selectChildProvider({ ...input, outcomes: { aggregates: [{ ...failures, taskKind: "coding" }], health: [] } }).selected?.model).toBe(flash.model);
    expect(selectChildProvider({ ...input, outcomes: { aggregates: [{ ...failures, profileRevision: "old" }], health: [] } }).selected?.model).toBe(flash.model);
    expect(selectChildProvider({ ...input, nowMs: 100_000 + 365 * 86_400_000,
      outcomes: { aggregates: [failures], health: [] } }).selected?.model).toBe(flash.model);
  });

  it("learns that repeated costly loops outweigh a cheap token price", () => {
    const costly: ChildRoutingAggregate = { provider: flash.provider, model: flash.model, taskKind: task.kind,
      complexity: task.complexity, profileRevision: CHILD_ROUTING_PROFILE_REVISION,
      attempts: 3, successes: 3, infrastructureFailures: 0, qualityObservations: 3, qualitySuccesses: 3,
      latencySamples: 3, latencyTotalMs: 900_000, costSamples: 3, costTotalUsd: 3, lastObservedAtMs: 100_000 };
    const result = selectChildProvider({ task, candidates: [flash, pro], nowMs: 100_000,
      outcomes: { aggregates: [costly], health: [] } });
    expect(result.selected?.model).toBe(pro.model);
    expect(result.ranked.find(item => item.model === flash.model)?.estimatedCostUsd).toBe(1);
  });

  it("is deterministic, deduplicates identical pairs and gives a short visible explanation", () => {
    const first = choose([astra, pro, flash, flash]);
    const second = choose([flash, pro, astra]);
    expect(first).toEqual(second);
    expect(first.selected?.reason).toMatch(/^deepseek\/deepseek-v4-flash fits this simple review/);
    expect(first.selected?.reason).not.toContain("\u2014");
  });

  it.each([
    ["Extract the three IDs", undefined, "extraction", "simple"],
    ["Extract the three IDs", "worker", "extraction", "simple"],
    ["Audit concurrency and security", "reviewer", "review", "hard"],
    ["Implement the parser", "worker", "coding", "standard"],
    ["Prove this theorem", undefined, "reasoning", "hard"],
    ["Research primary sources", undefined, "research", "standard"],
  ] as const)("classifies local task hints", (text, role, kind, complexity) => {
    expect(classifyChildTask(text, role)).toEqual({ kind, complexity });
  });
});
