import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  runPipelineQualitySuite,
  type PipelineDesktopRunner,
} from "./pipeline-quality-runner.js";
import { serializePipelineQualityArtifact } from "./pipeline-quality.js";

const INCIDENT_FIXTURE_DIR = fileURLToPath(
  new URL("../../benchmarks/v1/incidents", import.meta.url),
);

describe("pipeline-quality runner", () => {
  it("is deterministic under fixed runId/time/inputs", async () => {
    const desktopRunner: PipelineDesktopRunner = async ({ runIndex }) => ({
      runId: `desktop-${runIndex + 1}`,
      ok: true,
      timedOut: false,
      durationMs: 1500,
      preview: "ok",
    });

    const config = {
      now: () => 1_700_000_200_000,
      runId: "phase9-runner-deterministic",
      turns: 3,
      desktopRuns: 1,
      desktopRunner,
      incidentFixtureDir: INCIDENT_FIXTURE_DIR,
      delegationBenchmarkK: 2,
    } as const;

    const first = await runPipelineQualitySuite(config);
    const second = await runPipelineQualitySuite(config);

    expect(serializePipelineQualityArtifact(first)).toBe(
      serializePipelineQualityArtifact(second),
    );
  });
});
