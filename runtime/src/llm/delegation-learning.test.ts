import { describe, expect, it } from "vitest";
import {
  InMemoryDelegationTrajectorySink,
  computeDelegationFinalReward,
  deriveDelegationContextClusterId,
} from "./delegation-learning.js";

describe("delegation-learning", () => {
  it("computes bounded final reward components", () => {
    const reward = computeDelegationFinalReward({
      qualityProxy: 0.9,
      tokenCost: 30_000,
      latencyMs: 15_000,
      errorCount: 0,
    });

    expect(reward.value).toBeGreaterThan(0);
    expect(reward.qualityComponent).toBeCloseTo(0.9, 3);
    expect(reward.costPenalty).toBeGreaterThan(0);
    expect(reward.latencyPenalty).toBeGreaterThan(0);
    expect(reward.errorPenalty).toBe(0);
  });

  it("derives stable context cluster ids from planning features", () => {
    const cluster = deriveDelegationContextClusterId({
      complexityScore: 8,
      subagentStepCount: 3,
      hasHistory: true,
      highRiskPlan: false,
    });

    expect(cluster).toBe("high:fanout:history:normal");
  });

  it("stores bounded trajectory records in memory sink", () => {
    const sink = new InMemoryDelegationTrajectorySink({ maxRecords: 2 });

    sink.record({
      schemaVersion: 1,
      traceId: "trace-1",
      turnId: "turn-1",
      turnType: "parent",
      timestampMs: 1,
      stateFeatures: {
        sessionId: "s-1",
        contextClusterId: "low:none:fresh:normal",
        complexityScore: 1,
        plannerStepCount: 0,
        subagentStepCount: 0,
        deterministicStepCount: 0,
        synthesisStepCount: 0,
        dependencyDepth: 0,
        fanout: 0,
      },
      action: {
        delegated: false,
        strategyArmId: "balanced",
        threshold: 0.6,
        selectedTools: [],
        childConfig: {
          maxDepth: 4,
          maxFanoutPerTurn: 8,
          timeoutMs: 120_000,
        },
      },
      immediateOutcome: {
        qualityProxy: 1,
        tokenCost: 10,
        latencyMs: 5,
        errorCount: 0,
      },
      finalReward: {
        value: 0.95,
        qualityComponent: 1,
        costPenalty: 0,
        latencyPenalty: 0,
        errorPenalty: 0,
      },
    });
    sink.record({
      schemaVersion: 1,
      traceId: "trace-2",
      turnId: "turn-2",
      turnType: "child",
      timestampMs: 2,
      stateFeatures: {
        sessionId: "s-2",
        contextClusterId: "medium:single:history:normal",
        complexityScore: 5,
        plannerStepCount: 2,
        subagentStepCount: 1,
        deterministicStepCount: 1,
        synthesisStepCount: 0,
        dependencyDepth: 1,
        fanout: 1,
      },
      action: {
        delegated: true,
        strategyArmId: "balanced",
        threshold: 0.6,
        selectedTools: ["system.readFile"],
        childConfig: {
          maxDepth: 4,
          maxFanoutPerTurn: 8,
          timeoutMs: 120_000,
        },
      },
      immediateOutcome: {
        qualityProxy: 0.8,
        tokenCost: 100,
        latencyMs: 20,
        errorCount: 0,
      },
      finalReward: {
        value: 0.7,
        qualityComponent: 0.8,
        costPenalty: 0.001,
        latencyPenalty: 0.001,
        errorPenalty: 0,
      },
    });
    sink.record({
      schemaVersion: 1,
      traceId: "trace-3",
      turnId: "turn-3",
      turnType: "parent",
      timestampMs: 3,
      stateFeatures: {
        sessionId: "s-3",
        contextClusterId: "critical:fanout:history:highrisk",
        complexityScore: 10,
        plannerStepCount: 4,
        subagentStepCount: 3,
        deterministicStepCount: 1,
        synthesisStepCount: 1,
        dependencyDepth: 2,
        fanout: 3,
      },
      action: {
        delegated: true,
        strategyArmId: "aggressive",
        threshold: 0.5,
        selectedTools: ["system.readFile", "system.searchFiles"],
        childConfig: {
          maxDepth: 4,
          maxFanoutPerTurn: 8,
          timeoutMs: 120_000,
        },
      },
      immediateOutcome: {
        qualityProxy: 0.5,
        tokenCost: 50_000,
        latencyMs: 8_000,
        errorCount: 1,
      },
      finalReward: {
        value: -0.1,
        qualityComponent: 0.5,
        costPenalty: 0.4,
        latencyPenalty: 0.08,
        errorPenalty: 1,
      },
    });

    const snapshot = sink.snapshot();
    expect(snapshot).toHaveLength(2);
    expect(snapshot[0]?.turnId).toBe("turn-2");
    expect(snapshot[1]?.turnId).toBe("turn-3");
  });

});
