import { describe, expect, it } from "vitest";
import { abilityPrior, abilitySource, extractTaskFeatures, predictSuccess, sigmoid, updateAbility } from "../../src/agents/provider-selector-irt.js";
import { cascadeThreshold, conditionalRecovery, pairKey, selectChildProviderV2, utilityWeights } from "../../src/agents/provider-selector-v2.js";
import type { ChildProviderCandidate } from "../../src/agents/provider-selector-types.js";
const parent: ChildProviderCandidate = { provider: "deepseek", model: "deepseek-flash", allowed: true, connected: true,
  supportsToolUse: true, supportsVision: true, supportsReasoning: true, contextWindow: 100_000, maxOutputTokens: 8192,
  cost: { inputUsdPer1K: 0.0003, outputUsdPer1K: 0.0012 } };
const cheap: ChildProviderCandidate = { ...parent, provider: "meta", model: "muse-spark-1.3-contributor",
  cost: { inputUsdPer1K: 0.0001, outputUsdPer1K: 0.0002 } };
const features = { skill: "extraction" as const, difficulty: -2, discrimination: 1 };
const task = { kind: "extraction" as const, complexity: "simple" as const, requiresTools: false, inputTokens: 500, outputTokens: 1000, maxCostUsd: 0.05 };
const base = { parent, candidates: [cheap, parent], task, features, nowMs: 1000 };
const evidence = [{ first: pairKey(cheap), second: pairKey(parent), failures: 8, recovered: 7 }];
const verification = { available: true as const, retrySafe: true, costUsd: 0, latencyMs: 1, targetQuality: 0.75, conditional: evidence };

describe("local item response model", () => {
  it("has stable probability math and honest benchmark provenance", () => {
    expect(sigmoid(1000)).toBe(1); expect(sigmoid(-1000)).toBe(0);
    expect(abilitySource("deepseek", "deepseek-flash", "coding")).toMatchObject({ published: "2026-09-10", score: 0.742 });
    expect(abilitySource("kimi", "kimi-k3", "coding")).toBeUndefined();
    expect(abilityPrior("fake", "premium-ultra", "coding").mean).toBe(0);
    expect(abilityPrior("deepseek", "deepseek-flash-unknown", "coding").mean).toBe(0);
  });
  it("updates from pass/fail with uncertainty, and harder items imply lower success", () => {
    const prior = abilityPrior(parent.provider, parent.model, features.skill);
    const success = updateAbility(prior, features, true), failure = updateAbility(prior, features, false);
    expect(success.mean).toBeGreaterThan(prior.mean); expect(failure.mean).toBeLessThan(prior.mean);
    expect(success.variance).toBeLessThan(prior.variance);
    const prediction = predictSuccess(prior, features);
    expect(prediction.lower).toBeLessThan(prediction.mean); expect(prediction.upper).toBeGreaterThan(prediction.mean);
    expect(predictSuccess(prior, { ...features, difficulty: 2 }).mean).toBeLessThan(prediction.mean);
    expect(() => updateAbility(prior, { ...features, discrimination: NaN }, true)).toThrow();
  });
  it("extracts task features locally without treating incidental tool access as tool work", () => {
    expect(extractTaskFeatures("Extract names", true).skill).toBe("extraction");
    expect(extractTaskFeatures("Read files in the workspace", true).skill).toBe("tool_use");
    expect(extractTaskFeatures("Write Python function solve(data)").skill).toBe("coding");
    expect(extractTaskFeatures("Find shortest graph paths").skill).toBe("reasoning");
    expect(extractTaskFeatures("Archive record ".repeat(3000)).skill).toBe("long_context");
    expect(extractTaskFeatures("if ".repeat(10000)).difficulty).toBeLessThanOrEqual(1.5);
  });
});
describe("parent-first constrained utility", () => {
  it("retains the parent on cold start even with an available cheaper provider", () => {
    const r = selectChildProviderV2(base);
    expect(r.mode).toBe("parent"); expect(r.selected?.model).toBe(parent.model);
    expect(r.reason).toContain("handoff"); expect(r.reason).not.toContain("\\n");
  });
  it("uses user preferences, not price divided by a heuristic score", () => {
    expect(utilityWeights({ cost: "quality" }, 0.05).lambda).toBe(0);
    expect(utilityWeights({ cost: "economy" }, 0.01).lambda).toBeGreaterThan(utilityWeights({}, 0.05).lambda);
    expect(utilityWeights({ speed: "fast" }).mu).toBeGreaterThan(utilityWeights().mu);
  });
  it.each([
    [{ connected: false }, {}, "provider_not_connected"],
    [{ allowed: false }, {}, "provider_not_allowed"],
    [{ supportsToolUse: false }, { requiresTools: true }, "client_tools_unsupported"],
    [{ supportsVision: false }, { requiresVision: true }, "vision_unsupported"],
    [{ supportsReasoning: false }, { requiresReasoning: true }, "reasoning_unsupported"],
    [{ contextWindow: 1500 }, {}, "context_insufficient"],
    [{ maxOutputTokens: 900 }, {}, "output_limit_insufficient"],
    [{ cost: undefined }, {}, "price_unknown"],
    [{}, { maxCostUsd: 0 }, "task_budget_insufficient"],
    [{}, { inputTokens: NaN }, "invalid_task_requirements"],
  ])("never relaxes hard filters for override or exploration (%s)", (change, requirements, reason) => {
    const c = { ...cheap, ...change };
    const r = selectChildProviderV2({ ...base, candidates: [c], task: { ...task, ...requirements }, override: c,
      preferences: { explore: true }, verification });
    expect(r.selected).toBeUndefined(); expect(r.rejected[0]?.reason).toBe(reason);
  });
  it("respects permanent funds blocks and temporary cooldowns", () => {
    for (const health of [{ provider: "meta", cooldownUntilMs: 2000, consecutiveFailures: 1 },
      { provider: "meta", cooldownUntilMs: 0, consecutiveFailures: 1, blockedReason: "insufficient_funds" as const }]) {
      expect(selectChildProviderV2({ ...base, verification, outcomes: { aggregates: [], health: [health] } }).selected?.model).toBe(parent.model);
    }
  });
  it("allows a manual model override, while retaining explanation", () => {
    const r = selectChildProviderV2({ ...base, override: cheap });
    expect(r.mode).toBe("override"); expect(r.selected?.model).toBe(cheap.model); expect(r.reason).toContain("override");
  });
  it("does not treat subscription dollars as free", () => {
    const subscribed = { ...parent, billingSource: "sign_in" as const, cost: undefined };
    expect(selectChildProviderV2({ ...base, candidates: [subscribed] }).selected).toBeUndefined();
    expect(selectChildProviderV2({ ...base, candidates: [subscribed, cheap], task: { ...task, maxCostUsd: undefined } }).mode).toBe("parent");
  });
  it("delegates when verified local ability dominates the parent's uncertainty and handoff", () => {
    const abilities = [ { ...abilityPrior(parent.provider, parent.model, features.skill), mean: -2, variance: 0.05, observations: 40 },
      { ...abilityPrior(cheap.provider, cheap.model, features.skill), mean: 2, variance: 0.05, observations: 40 } ];
    expect(selectChildProviderV2({ ...base, abilities }).selected?.model).toBe(cheap.model);
    expect(selectChildProviderV2({ ...base, abilities, handoffTokens: 1_000_000 }).selected?.model).toBe(parent.model);
  });
});
describe("verified cost cascade", () => {
  it("uses conditional failure evidence and solves the cost threshold", () => {
    expect(conditionalRecovery("a", "b")).toBe(0);
    expect(conditionalRecovery("a", "b", [{ first: "a", second: "b", failures: 0, recovered: 0 }])).toBe(0);
    expect(conditionalRecovery("a", "b", [{ first: "a", second: "b", failures: 9, recovered: 9 }])).toBe(0.95);
    expect(cascadeThreshold(1, 4, 2)).toBe(0.75); expect(cascadeThreshold(2, 4, 1)).toBeUndefined();
  });
  it("requires a real verifier and a safe replay contract", () => {
    expect(selectChildProviderV2(base).cascade).toBeUndefined();
    expect(selectChildProviderV2({ ...base, verification: { ...verification, retrySafe: false } }).cascade).toBeUndefined();
    expect(selectChildProviderV2({ ...base, verification: { ...verification, conditional: [] } }).cascade).toBeUndefined();
    const r = selectChildProviderV2({ ...base, verification });
    expect(r.mode).toBe("cascade"); expect(r.cascade?.candidates.map(pairKey)).toEqual([pairKey(cheap), pairKey(parent)]);
    expect(r.cascade!.worstCaseCostUsd).toBeGreaterThan(r.cascade!.expectedCostUsd);
    expect(r.reason).toContain("only on failure");
  });
  it("refuses a chain whose worst case does not fit, even when its expectation fits", () => {
    const r = selectChildProviderV2({ ...base, verification });
    const cap = (r.cascade!.expectedCostUsd + r.cascade!.worstCaseCostUsd) / 2;
    expect(selectChildProviderV2({ ...base, verification, task: { ...task, maxCostUsd: cap } }).cascade).toBeUndefined();
    expect(selectChildProviderV2({ ...base, verification: { ...verification, costUsd: 1 } }).cascade).toBeUndefined();
  });
});
describe("safe contextual Thompson sampling", () => {
  it("does not explore cold models or permit malformed risk budgets", () => {
    for (const maxExpectedLoss of [0.01, -1, NaN, 1]) {
      const r = selectChildProviderV2({ ...base, preferences: { explore: true, maxExpectedLoss }, random: () => { throw Error("unsafe sample"); } });
      expect(r.mode).toBe("parent");
    }
  });
  it("samples only in the conservative quality and cost loss envelope", () => {
    const abilities = [parent, cheap].map(c => ({ ...abilityPrior(c.provider, c.model, features.skill), mean: 8, variance: 0.01, observations: 100 }));
    let samples = 0;
    const r = selectChildProviderV2({ ...base, abilities, preferences: { explore: true, maxExpectedLoss: 0.01 }, random: () => { samples++; return 0.5; } });
    expect(samples).toBeGreaterThan(0); expect([parent.model, cheap.model]).toContain(r.selected?.model);
    const blocked = selectChildProviderV2({ ...base, abilities, candidates: [{ ...cheap, allowed: false }, parent], preferences: { explore: true }, random: () => 0.5 });
    expect(blocked.selected?.model).toBe(parent.model);
  });
});
