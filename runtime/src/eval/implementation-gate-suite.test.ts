import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { runImplementationGateSuite } from "./implementation-gate-suite.js";

const INCIDENT_FIXTURE_DIR = fileURLToPath(
  new URL("../../benchmarks/v1/incidents", import.meta.url),
);

describe("implementation gate suite", () => {
  it("covers the mandatory false-completion and wrong-artifact cutover regressions", async () => {
    const artifact = await runImplementationGateSuite({
      incidentFixtureDir: INCIDENT_FIXTURE_DIR,
    });

    expect(artifact.mandatoryScenarioCount).toBe(4);
    expect(artifact.falseCompletedScenarios).toBe(0);
    expect(artifact.mandatoryPassRate).toBe(1);
    expect(
      artifact.scenarios.map((scenario) => scenario.scenarioId),
    ).toEqual(
      expect.arrayContaining([
        "shell_stub_false_completion_replay_gate",
        "live_runtime_false_completion_gate",
        "non_empty_wrong_artifact_verifier_gate",
        "resume_after_partial_completion",
      ]),
    );
  });
});
