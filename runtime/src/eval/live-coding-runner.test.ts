import { describe, expect, it } from "vitest";

import { runLiveCodingSuite } from "./live-coding-runner.js";

describe("live coding runner", () => {
  it("executes temp-repo coding scenarios and returns a green artifact", async () => {
    const artifact = await runLiveCodingSuite({
      now: () => 1_700_000_000_000,
    });

    expect(artifact.scenarioCount).toBe(3);
    expect(artifact.passRate).toBe(1);
    expect(artifact.wrongRootIncidents).toBe(0);
    expect(artifact.effectLedgerCompletenessRate).toBe(1);
    expect(
      artifact.scenarios.some((scenario) => scenario.shellMutationCount > 0),
    ).toBe(true);
  });
});
