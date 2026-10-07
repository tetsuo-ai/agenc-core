import { describe, expect, it } from "vitest";
import { REFERENCE_DIFFICULTY, abilityPrior, extractTaskFeatures, predictSuccess, sigmoid, updateAbility } from "../../src/agents/provider-selector-irt.js";
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
  it("has stable probability math and anchors every prior on the maintained tier", () => {
    expect(sigmoid(1000)).toBe(1); expect(sigmoid(-1000)).toBe(0);
    // At the reference difficulty a prior reproduces its tier quality.
    const level = (provider: string, model: string, skill: "coding" | "reasoning" | "tool_use") =>
      sigmoid(abilityPrior(provider, model, skill).mean - REFERENCE_DIFFICULTY);
    expect(level("deepseek", "deepseek-v4-pro", "reasoning")).toBeCloseTo(0.96);
    expect(level("deepseek", "deepseek-flash", "reasoning")).toBeCloseTo(0.84);
    expect(level("openai", "gpt-6-luna", "reasoning")).toBeCloseTo(0.72);
    expect(level("openai", "gpt-6-astra", "tool_use")).toBeCloseTo(0.95);
    // The same scale for every vendor: no benchmark that only one model reports.
    for (const skill of ["coding", "reasoning", "tool_use"] as const) {
      expect(abilityPrior("deepseek", "deepseek-v4-pro", skill).mean).toBeGreaterThan(abilityPrior("deepseek", "deepseek-flash", skill).mean);
      expect(abilityPrior("deepseek", "deepseek-flash", skill).mean).toBe(abilityPrior("meta", "muse-spark-1.3-contributor", skill).mean);
    }
    expect(abilityPrior("fake", "premium-ultra", "coding").mean).toBe(REFERENCE_DIFFICULTY);
    expect(abilityPrior("deepseek", "deepseek-flash-unknown", "coding").mean).toBe(REFERENCE_DIFFICULTY);
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
  it("weighs price only under a cap, so an uncapped session is never the most price averse", () => {
    for (const cost of ["quality", "balanced", "economy"] as const) {
      expect(utilityWeights({ cost }).lambda).toBe(0);
      for (const cap of [0.001, 0.05, 1, 20, 1_000]) {
        expect(utilityWeights({ cost }).lambda).toBeLessThanOrEqual(utilityWeights({ cost }, cap).lambda);
      }
    }
    expect(utilityWeights({}, 20).lambda).toBeLessThan(utilityWeights({}, 0.05).lambda);
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
describe("maintained adequacy and parent-first price handling", () => {
  const model = (provider: string, name: string, inputUsdPer1K: number, outputUsdPer1K: number): ChildProviderCandidate =>
    ({ ...parent, provider, model: name, cost: { inputUsdPer1K, outputUsdPer1K } });
  const astra = model("openai", "gpt-6-astra", 0.01, 0.05);
  const luna = model("openai", "gpt-6-luna", 0.0001, 0.0005);
  const flash = model("deepseek", "deepseek-flash", 0.0003, 0.0012);
  const pro = model("deepseek", "deepseek-v4-pro", 0.00132, 0.00396);
  const reasoning = (complexity: "simple" | "standard" | "hard", maxCostUsd?: number) => ({
    // The call and output estimates routeChildTask uses for each complexity.
    task: { kind: "reasoning" as const, complexity, requiresTools: true, requiresReasoning: true, inputTokens: 20_000,
      outputTokens: complexity === "hard" ? 8_192 : 4_096, expectedModelCalls: complexity === "simple" ? 2 : complexity === "hard" ? 8 : 4,
      ...(maxCostUsd !== undefined ? { maxCostUsd } : {}) },
    features: { skill: "reasoning" as const, difficulty: -1, discrimination: 1 }, nowMs: 1000 });

  it("keeps an uncapped strong parent for simple and hard reasoning", () => {
    for (const complexity of ["simple", "standard", "hard"] as const) {
      const r = selectChildProviderV2({ ...reasoning(complexity), parent: astra, candidates: [luna, flash, pro, astra] });
      expect(r.lambda).toBe(0);
      expect(r).toMatchObject({ mode: "parent", selected: { provider: "openai", model: "gpt-6-astra" } });
    }
  });
  it("never lets price alone move an adequate parent without a cap", () => {
    // Same tier, a fraction of the price: still no reason to leave.
    const r = selectChildProviderV2({ ...reasoning("standard"), parent: astra, candidates: [astra, pro] });
    expect(r.mode).toBe("parent");
    expect(r.selected?.estimatedCostUsd).toBeGreaterThan(5 * r.ranked.find(item => item.model === pro.model)!.estimatedCostUsd!);
    // A cap of the user's own makes the same saving count.
    expect(selectChildProviderV2({ ...reasoning("standard", 2), parent: astra, candidates: [astra, pro],
      preferences: { cost: "economy" } }).selected?.model).toBe(pro.model);
  });
  it("requires the maintained tier to meet the task's complexity floor", () => {
    const r = selectChildProviderV2({ ...reasoning("standard", 2), parent: astra, candidates: [astra, luna],
      preferences: { cost: "economy" } });
    expect(r.rejected).toContainEqual(expect.objectContaining({ model: luna.model, reason: "quality_below_task_floor" }));
    expect(r.selected?.model).toBe(astra.model);
    // An explicit override is the user's choice and skips the floor.
    expect(selectChildProviderV2({ ...reasoning("hard"), parent: astra, candidates: [luna], override: luna }).selected?.model).toBe(luna.model);
  });
  it("sends a hard task from a parent below the floor to the least expensive adequate model", () => {
    const r = selectChildProviderV2({ ...reasoning("hard"), parent: flash, candidates: [flash, luna, astra, pro] });
    expect(r).toMatchObject({ mode: "utility", selected: { model: pro.model } });
    expect(r.reason).toContain("meets the quality this hard reasoning task needs and your model does not");
    expect(r.rejected.map(item => item.model).sort()).toEqual([flash.model, luna.model].sort());
    const none = selectChildProviderV2({ ...reasoning("hard"), parent: flash, candidates: [flash, luna] });
    expect(none.selected).toBeUndefined();
    expect(none.reason).toBe("No connected and allowed model meets this task's requirements.");
  });
  it("does not move a hard task below the parent's rating, nor away from an unrated parent", () => {
    // Equal tier under a generous cap may still save money; a lower tier may not.
    const capped = selectChildProviderV2({ ...reasoning("hard", 5), parent: astra, candidates: [astra, pro],
      preferences: { cost: "economy" } });
    expect(capped.selected?.model).toBe(pro.model);
    const unrated = { ...astra, model: "gpt-unlisted" };
    const r = selectChildProviderV2({ ...reasoning("hard", 5), parent: unrated, candidates: [unrated, pro],
      preferences: { cost: "economy" } });
    expect(r).toMatchObject({ mode: "parent", selected: { model: "gpt-unlisted" } });
  });
  it("treats a higher tier as adequacy, not as a reason to leave the parent, until verified outcomes support it", () => {
    const cold = selectChildProviderV2({ ...reasoning("standard"), parent: flash, candidates: [flash, pro] });
    expect(cold.mode).toBe("parent");
    const verified = [{ ...abilityPrior(pro.provider, pro.model, "reasoning"), mean: 6, variance: 0.05, observations: 60 },
      { ...abilityPrior(flash.provider, flash.model, "reasoning"), mean: -3, variance: 0.05, observations: 60 }];
    expect(selectChildProviderV2({ ...reasoning("standard"), parent: flash, candidates: [flash, pro], abilities: verified })
      .selected?.model).toBe(pro.model);
  });
  it("does not plan a verified cascade on a higher tier alone", () => {
    const check = { available: true as const, retrySafe: true, costUsd: 0, latencyMs: 1, targetQuality: 0.75 };
    const cold = selectChildProviderV2({ ...reasoning("standard"), parent: flash, candidates: [flash, pro], verification: check });
    expect(cold).toMatchObject({ mode: "parent", selected: { model: flash.model } });
    expect(cold.cascade).toBeUndefined();
    // Paired outcomes, where the parent rescued the first model's failures, do support one.
    const paired = selectChildProviderV2({ ...reasoning("standard"), parent: flash, candidates: [flash, pro],
      verification: { ...check, conditional: [{ first: pairKey(pro), second: pairKey(flash), failures: 20, recovered: 19 }] } });
    expect(paired.cascade?.candidates.map(pairKey)).toEqual([pairKey(pro), pairKey(flash)]);
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
