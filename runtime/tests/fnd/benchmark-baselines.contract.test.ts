import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import {
  BENCHMARK_EVIDENCE_PATHS,
  BENCHMARK_PLAN,
  BENCHMARK_PRODUCTION_TREE_PATH,
  MAX_BASELINE_JSON_BYTES,
  MAX_BASELINE_MARKDOWN_BYTES,
  benchmarkPlanDigest,
  canonicalJson,
  renderBaselineMarkdown,
  validateBenchmarkReport,
} from "../../benchmarks/fnd/contract.mjs";
import { describeFixture } from "../../benchmarks/fnd/fixtures.mjs";
import {
  collectNormalizedFileBindings,
  verifyCheckedBenchmarkProvenance,
} from "../../benchmarks/fnd/provenance.mjs";

const BENCHMARK_ROOT = fileURLToPath(
  new URL("../../benchmarks/fnd/", import.meta.url),
);
const RUNTIME_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const REPOSITORY_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const BASELINE_JSON_PATH = join(BENCHMARK_ROOT, "baseline.v1.json");
const BASELINE_MARKDOWN_PATH = join(BENCHMARK_ROOT, "baseline.v1.md");
const RUNNER_PATH = join(BENCHMARK_ROOT, "run-baselines.mjs");
const PLAN_RUNNER_TIMEOUT_MS = 5_000;
const PROVENANCE_CONTRACT_TIMEOUT_MS = 90_000;

function readBaseline(): Record<string, any> {
  return JSON.parse(readFileSync(BASELINE_JSON_PATH, "utf8")) as Record<
    string,
    any
  >;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("FND benchmark baseline contract", () => {
  test("keeps evidence paths in canonical provenance order", () => {
    expect(BENCHMARK_EVIDENCE_PATHS).toEqual(
      [...new Set(BENCHMARK_EVIDENCE_PATHS)].sort(),
    );
  });

  test("keeps canonical JSON, generated Markdown, digest, and schema in lockstep", () => {
    const json = readFileSync(BASELINE_JSON_PATH, "utf8");
    const report = JSON.parse(json) as Record<string, any>;
    const digest = sha256(json);

    expect(validateBenchmarkReport(report)).toBe(report);
    expect(canonicalJson(report)).toBe(json);
    expect(readFileSync(BASELINE_MARKDOWN_PATH, "utf8")).toBe(
      renderBaselineMarkdown(report, digest),
    );
    expect(Buffer.byteLength(json)).toBeLessThanOrEqual(
      MAX_BASELINE_JSON_BYTES,
    );
    expect(
      Buffer.byteLength(readFileSync(BASELINE_MARKDOWN_PATH, "utf8")),
    ).toBeLessThanOrEqual(MAX_BASELINE_MARKDOWN_BYTES);
  });

  test("pins generated baseline artifacts to LF on every checkout", () => {
    const paths = [
      "runtime/benchmarks/fnd/baseline.v1.json",
      "runtime/benchmarks/fnd/baseline.v1.md",
    ];
    const attributes = execFileSync(
      "git",
      ["check-attr", "eol", "--", ...paths],
      {
        cwd: REPOSITORY_ROOT,
        encoding: "utf8",
        maxBuffer: 65_536,
        timeout: 5_000,
        windowsHide: true,
      },
    );
    for (const path of paths) {
      expect(attributes).toContain(`${path}: eol: lf`);
      expect(readFileSync(join(REPOSITORY_ROOT, path), "utf8")).not.toContain(
        "\r",
      );
    }
  });

  test("regenerates every fixture descriptor and plan deterministically", () => {
    for (const definition of BENCHMARK_PLAN.cases) {
      definition.inputSeries.forEach((_, pointIndex) => {
        expect(describeFixture(definition.id, pointIndex)).toEqual(
          describeFixture(definition.id, pointIndex),
        );
      });
    }
    expect(benchmarkPlanDigest()).toMatch(/^[0-9a-f]{64}$/u);

    const runnerEnvironment = { ...process.env };
    for (const name of Object.keys(runnerEnvironment)) {
      const normalizedName = name.toUpperCase();
      if (
        normalizedName.startsWith("NODE_") ||
        normalizedName.startsWith("TSX_")
      ) {
        delete runnerEnvironment[name];
      }
    }
    const first = execFileSync(process.execPath, [RUNNER_PATH, "--plan"], {
      cwd: RUNTIME_ROOT,
      encoding: "utf8",
      env: runnerEnvironment,
      maxBuffer: 2_097_152,
      timeout: PLAN_RUNNER_TIMEOUT_MS,
    });
    const second = execFileSync(process.execPath, [RUNNER_PATH, "--plan"], {
      cwd: RUNTIME_ROOT,
      encoding: "utf8",
      env: runnerEnvironment,
      maxBuffer: 2_097_152,
      timeout: PLAN_RUNNER_TIMEOUT_MS,
    });
    expect(second).toBe(first);
  });

  test("binds every measured point to its generated fixture and production source", () => {
    const report = readBaseline();
    for (const [caseIndex, definition] of BENCHMARK_PLAN.cases.entries()) {
      for (const pointIndex of definition.inputSeries.keys()) {
        const expected = describeFixture(definition.id, pointIndex);
        const point = report.cases[caseIndex].points[pointIndex];
        expect(point.fixtureDigest).toBe(expected.fixtureDigest);
        expect(point.input).toEqual(expected.descriptor.input);
        expect(point.operations).toEqual(expected.operations);
      }
    }
    expect(report.evidenceBindings).toEqual(
      collectNormalizedFileBindings(REPOSITORY_ROOT, BENCHMARK_EVIDENCE_PATHS),
    );
    expect(() =>
      verifyCheckedBenchmarkProvenance(report, {
        evidencePaths: BENCHMARK_EVIDENCE_PATHS,
        productionTreePath: BENCHMARK_PRODUCTION_TREE_PATH,
        repositoryRoot: REPOSITORY_ROOT,
      }),
    ).not.toThrow();
    expect(report.productionModuleClosures).toHaveLength(
      BENCHMARK_PLAN.cases.length,
    );
    for (const [index, closure] of report.productionModuleClosures.entries()) {
      expect(closure.caseId).toBe(BENCHMARK_PLAN.cases[index].id);
      expect(closure.modules.length).toBeGreaterThan(0);
    }
    const patchClosure = report.productionModuleClosures.find(
      (closure: Record<string, any>) =>
        closure.caseId === "patch_delete_parser_historical_comparison",
    );
    expect(
      patchClosure.modules.map((binding: Record<string, any>) => binding.path),
    ).toContain("runtime/src/tools/apply-patch/types.ts");
    expect(report.productionTreeBinding).toMatchObject({
      objectType: "tree",
      path: BENCHMARK_PRODUCTION_TREE_PATH,
    });
    expect(report.productionTreeBinding.gitObjectId).toMatch(
      /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u,
    );
  }, PROVENANCE_CONTRACT_TIMEOUT_MS);

  test("rejects a missing elapsed metric and additive schema drift", () => {
    const missingMetric = structuredClone(readBaseline());
    delete missingMetric.cases[0].points[0].elapsed.madMs;
    expect(() => validateBenchmarkReport(missingMetric)).toThrow(
      /keys differ/u,
    );

    const drifted = structuredClone(readBaseline());
    drifted.cases[0].points[0].elapsed.p95Ms = 42;
    expect(() => validateBenchmarkReport(drifted)).toThrow(/keys differ/u);

    const versionDrift = structuredClone(readBaseline());
    versionDrift.schemaVersion += 1;
    expect(() => validateBenchmarkReport(versionDrift)).toThrow(
      /schemaVersion/u,
    );

    const collapsedFilesystemMetadata = structuredClone(readBaseline());
    delete collapsedFilesystemMetadata.environment.filesystems
      .temporaryFixtures;
    expect(() => validateBenchmarkReport(collapsedFilesystemMetadata)).toThrow(
      /keys differ/u,
    );
  });

  test("never lets an informational observation become a passing threshold", () => {
    const passing = structuredClone(readBaseline());
    passing.cases[0].assessment.classification = "passing_threshold";
    expect(() => validateBenchmarkReport(passing)).toThrow(/classification/u);

    const gated = structuredClone(readBaseline());
    gated.cases[1].assessment.gateEnforced = true;
    expect(() => validateBenchmarkReport(gated)).toThrow(/gateEnforced/u);

    const thresholded = structuredClone(readBaseline());
    thresholded.cases[0].assessment.threshold = { elapsedMs: 2_500 };
    expect(() => validateBenchmarkReport(thresholded)).toThrow(/threshold/u);

    for (const [index, benchmarkCase] of readBaseline().cases.entries()) {
      expect(benchmarkCase.assessment).toMatchObject({
        classification: BENCHMARK_PLAN.cases[index].assessment.classification,
        gateEnforced: false,
        threshold: null,
      });
    }
    expect(readBaseline().cases[0].assessment.classification).toBe(
      "known_failure_observation",
    );
    expect(readBaseline().cases[1].assessment.classification).toBe(
      "historical_reference_observation",
    );
  });

  test("rejects fixture dimensions or generated bytes above named bounds", () => {
    const oversizedDimension = structuredClone(readBaseline());
    const csvMaxInput = BENCHMARK_PLAN.cases[0].maxInput;
    if (!("rowCount" in csvMaxInput)) {
      throw new Error("CSV benchmark maximum is missing rowCount");
    }
    oversizedDimension.cases[0].points[0].input.rowCount =
      csvMaxInput.rowCount + 1;
    expect(() => validateBenchmarkReport(oversizedDimension)).toThrow(
      /rowCount/u,
    );

    const oversizedBytes = structuredClone(readBaseline());
    oversizedBytes.cases[1].points[0].input.generatedUtf8Bytes =
      BENCHMARK_PLAN.cases[1].maxInput.generatedUtf8Bytes + 1;
    expect(() => validateBenchmarkReport(oversizedBytes)).toThrow(
      /generatedUtf8Bytes/u,
    );

    for (const definition of BENCHMARK_PLAN.cases) {
      expect(definition.timeoutMs).toBeGreaterThan(0);
      expect(definition.repetitions).toBeGreaterThan(0);
      expect(definition.supervisorTrials).toBeGreaterThan(0);
      expect(definition.inputSeries.length).toBeGreaterThan(0);
    }
  });

  test("requires repeated samples, memory approximation, operations, and oracle result", () => {
    const report = readBaseline();
    for (const benchmarkCase of report.cases) {
      for (const point of benchmarkCase.points) {
        expect(point.elapsed.sampleCount).toBeGreaterThanOrEqual(3);
        expect(point.elapsed.samplesMs).toHaveLength(point.elapsed.sampleCount);
        expect(point.elapsed.medianMs).toBeGreaterThanOrEqual(0);
        expect(point.elapsed.madMs).toBeGreaterThanOrEqual(0);
        expect(point.memory.lowerBound.method).toMatch(/rss_lower_bound$/u);
        expect(
          point.memory.lowerBound.observationsBytes.length,
        ).toBeGreaterThan(0);
        expect(point.memory.lowerBound.maximumObservedBytes).toBe(
          Math.max(...point.memory.lowerBound.observationsBytes),
        );
        if (point.status === "completed") {
          expect(point.memory.peakRssMethod).toBe(
            "process.resourceUsage.maxRSS_kib_to_bytes",
          );
          expect(point.memory.peakRssBytes).toBeGreaterThan(0);
        } else {
          expect(point.memory.peakRssMethod).toBe(
            "unavailable_after_forced_termination",
          );
          expect(point.memory.peakRssBytes).toBeNull();
        }
        expect(Object.keys(point.operations).length).toBeGreaterThan(0);
        expect(point.correctness.oracle.length).toBeGreaterThan(0);
      }
    }
  });

  test("contains only relative source bindings and no personal filesystem paths", () => {
    const json = readFileSync(BASELINE_JSON_PATH, "utf8");
    expect(json).not.toMatch(/\/(?:home|Users)\//u);
    expect(json).not.toMatch(/[A-Za-z]:\\Users\\/u);
    for (const closure of readBaseline().productionModuleClosures) {
      for (const binding of closure.modules) {
        expect(binding.path).not.toMatch(/^[/\\]/u);
        expect(binding.path).not.toContain("..");
      }
    }
    for (const binding of readBaseline().evidenceBindings) {
      expect(binding.path).not.toMatch(/^[/\\]/u);
      expect(binding.path).not.toContain("..");
    }
  });
});
