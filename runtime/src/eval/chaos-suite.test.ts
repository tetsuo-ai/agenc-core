import { describe, expect, it } from "vitest";
import { runChaosSuite } from "./chaos-suite.js";

describe("runChaosSuite", () => {
  it("covers all degraded-runtime fault scenarios and passes cleanly", async () => {
    const artifact = await runChaosSuite();

    expect(artifact.scenarioCount).toBe(6);
    expect(artifact.passingScenarios).toBe(6);
    expect(artifact.passRate).toBe(1);
    expect(artifact.providerTimeoutRecoveryRate).toBe(1);
    expect(artifact.toolTimeoutContainmentRate).toBe(1);
    expect(artifact.persistenceSafeModeRate).toBe(1);
    expect(artifact.approvalStoreSafeModeRate).toBe(1);
    expect(artifact.childRunCrashContainmentRate).toBe(1);
    expect(artifact.daemonRestartRecoveryRate).toBe(1);
    expect(
      artifact.scenarios.some((entry) => entry.runtimeMode !== "healthy"),
    ).toBe(true);
  });
});
