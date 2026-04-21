import { describe, expect, it } from "vitest";

import {
  assertMeasurementWithinBaseline,
  loadBenchmarkManifest,
  readBaselineArtifact,
  resolveArtifactPath,
  runFixtureMeasurement,
  validateBenchmarkManifest,
  writeBaselineArtifact,
} from "../benchmarks/v1/runtime-replacement/runner.js";

const manifest = loadBenchmarkManifest();
const captureEnabled = process.env.AGENC_RUNTIME_BENCHMARK_CAPTURE === "1";
const verifyEnabled = process.env.AGENC_RUNTIME_BENCHMARK_VERIFY === "1";

describe.sequential("runtime benchmark runner", () => {
  it("keeps the runtime-replacement benchmark manifest valid", () => {
    if (captureEnabled && verifyEnabled) {
      throw new Error(
        "AGENC_RUNTIME_BENCHMARK_CAPTURE=1 and AGENC_RUNTIME_BENCHMARK_VERIFY=1 cannot be combined",
      );
    }
    validateBenchmarkManifest(manifest);
    expect(manifest.fixtures).toHaveLength(4);
  });

  for (const fixture of manifest.fixtures) {
    it(`measures ${fixture.id}`, async () => {
      const measurement = await runFixtureMeasurement(manifest, fixture);

      expect(measurement.sampleCount).toBe(fixture.capture.measurementIterations);
      expect(measurement.stats.minMs).toBeGreaterThanOrEqual(0);
      expect(measurement.stats.maxMs).toBeGreaterThanOrEqual(
        measurement.stats.minMs,
      );

      if (captureEnabled) {
        const artifact = writeBaselineArtifact(manifest, fixture, measurement);
        expect(resolveArtifactPath(manifest, fixture)).toContain(
          `runtime-replacement/${fixture.id}.baseline.json`,
        );
        expect(artifact.measurement.sampleCount).toBe(
          fixture.capture.measurementIterations,
        );
        return;
      }

      if (verifyEnabled) {
        const baseline = readBaselineArtifact(manifest, fixture);
        assertMeasurementWithinBaseline(fixture, measurement, baseline);
      }
    });
  }
});
