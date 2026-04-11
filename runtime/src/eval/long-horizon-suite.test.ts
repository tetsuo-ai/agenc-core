import { describe, expect, it } from "vitest";

import { runLongHorizonSuite } from "./long-horizon-suite.js";

describe("long horizon suite", () => {
  it("covers 100+ steps, compaction/continue, multi-worker completion, and durable recovery", async () => {
    const artifact = await runLongHorizonSuite({
      now: () => 1_700_000_000_000,
    });

    expect(artifact.scenarioCount).toBe(5);
    expect(artifact.passRate).toBe(1);
    expect(artifact.restartRecoverySuccessRate).toBeGreaterThan(0);
    expect(artifact.compactionContinuationRate).toBe(1);
    expect(artifact.backgroundPersistenceRate).toBe(1);
    expect(
      artifact.scenarios.some((scenario) => scenario.stepCount >= 100),
    ).toBe(true);
    expect(
      artifact.scenarios.some(
        (scenario) =>
          scenario.scenarioId === "multi_worker_task_contract_completion" &&
          scenario.passed,
      ),
    ).toBe(true);
  });
});
