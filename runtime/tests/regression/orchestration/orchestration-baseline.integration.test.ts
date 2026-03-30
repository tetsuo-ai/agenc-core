import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipelineQualitySuite } from "../../../src/eval/pipeline-quality-runner.js";

const INCIDENT_FIXTURE_DIR = fileURLToPath(
  new URL("../../../benchmarks/v1/incidents", import.meta.url),
);

describe("orchestration baseline regression corpus", () => {
  it("replays the normalized failure catalog and produces a stable baseline report", async () => {
    const artifact = await runPipelineQualitySuite({
      now: () => 1_700_000_300_000,
      runId: "orchestration-baseline-regression",
      turns: 2,
      desktopRuns: 0,
      incidentFixtureDir: INCIDENT_FIXTURE_DIR,
      delegationBenchmarkK: 2,
    });

    expect(artifact.offlineReplay.fixtureCount).toBe(13);
    expect(artifact.offlineReplay.parseFailures).toBe(0);
    expect(artifact.offlineReplay.replayFailures).toBe(0);

    expect(artifact.orchestrationBaseline.scenarioCount).toBe(13);
    expect(artifact.orchestrationBaseline.passingScenarios).toBe(13);
    expect(artifact.orchestrationBaseline.passRate).toBe(1);
    expect(artifact.orchestrationBaseline.averageToolCalls).toBeCloseTo(
      23 / 13,
      8,
    );
    expect(artifact.orchestrationBaseline.fallbackCount).toBe(5);
    expect(artifact.orchestrationBaseline.spuriousSubagentCount).toBe(12);
    expect(artifact.orchestrationBaseline.approvalCount).toBe(0);
    expect(artifact.orchestrationBaseline.restartRecoverySuccessRate).toBe(0);
  });
});
