import { describe, expect, it } from "vitest";

import {
  buildRuntimeEconomicsPolicy,
  buildRuntimeEconomicsSummary,
  createRuntimeEconomicsState,
  getRuntimeBudgetPressure,
  mapPhaseToRunClass,
  recordRuntimeModelCall,
} from "./run-budget.js";

describe("buildRuntimeEconomicsPolicy", () => {
  it("derives finite ceilings from runtime settings", () => {
    const policy = buildRuntimeEconomicsPolicy({
      sessionTokenBudget: 512,
      plannerMaxTokens: 96,
      requestTimeoutMs: 20_000,
      childTimeoutMs: 5_000,
      childTokenBudget: 128,
      maxFanoutPerTurn: 3,
      mode: "enforce",
    });

    expect(policy.mode).toBe("enforce");
    expect(policy.budgets.planner.tokenCeiling).toBe(96);
    expect(policy.budgets.executor.tokenCeiling).toBe(512);
    expect(policy.budgets.verifier.tokenCeiling).toBe(96);
    expect(policy.budgets.child.tokenCeiling).toBe(128);
    expect(policy.budgets.executor.latencyCeilingMs).toBe(20_000);
    expect(policy.budgets.child.latencyCeilingMs).toBe(5_000);
    expect(policy.childFanoutSoftCap).toBe(3);
    expect(policy.negativeDelegationMarginUnits).toBe(0.2);
    expect(policy.negativeDelegationMarginTokens).toBe(64);
    expect(mapPhaseToRunClass("compaction")).toBe("planner");
    expect(mapPhaseToRunClass("planner_verifier")).toBe("verifier");
    expect(mapPhaseToRunClass("initial")).toBe("executor");
  });
});

describe("recordRuntimeModelCall", () => {
  it("tracks reroutes and budget ceiling breaches once usage crosses the limit", () => {
    const policy = buildRuntimeEconomicsPolicy({
      sessionTokenBudget: 80,
      requestTimeoutMs: 5_000,
      mode: "enforce",
    });
    const state = createRuntimeEconomicsState();

    expect(getRuntimeBudgetPressure(policy, state, "executor").hardExceeded).toBe(
      false,
    );

    recordRuntimeModelCall({
      policy,
      state,
      runClass: "executor",
      provider: "fallback-secondary",
      model: "fallback-secondary-model",
      usage: {
        promptTokens: 30,
        completionTokens: 60,
        totalTokens: 90,
      },
      durationMs: 250,
      rerouted: true,
      downgraded: false,
      phase: "initial",
      reason: "degraded_provider",
    });

    const pressure = getRuntimeBudgetPressure(policy, state, "executor");
    const summary = buildRuntimeEconomicsSummary(policy, state);

    expect(pressure.hardExceeded).toBe(true);
    expect(summary.totalTokens).toBe(90);
    expect(summary.totalSpendUnits).toBeCloseTo(0.3516, 4);
    expect(summary.rerouteCount).toBe(1);
    expect(summary.budgetViolationCount).toBe(1);
    expect(summary.runClasses.executor.usage.calls).toBe(1);
    expect(summary.runClasses.executor.usage.reroutes).toBe(1);
    expect(summary.runClasses.executor.usage.ceilingBreaches).toBe(1);
    expect(summary.runClasses.executor.lastProvider).toBe("fallback-secondary");
    expect(summary.routes).toHaveLength(1);
    expect(summary.routes[0]?.reason).toBe("degraded_provider");
  });
});
