import { execFile } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

import { describe, expect, test } from "vitest";

import {
  FUZZY_BENCHMARK_SCHEMA_VERSION,
  FUZZY_BENCHMARK_SUITE_ID,
  summarizeFuzzySamples,
  validateFuzzyBenchmarkReport,
} from "../../benchmarks/fuzzy-search/contract.mjs";
import {
  generateFuzzyCorpus,
  isFullQuerySubsequence,
} from "../../benchmarks/fuzzy-search/corpus.mjs";

const execFileAsync = promisify(execFile);

describe("D2 fuzzy benchmark contract", () => {
  test("generates deterministic bounded corpora without checked-in bulk data", () => {
    const first = generateFuzzyCorpus(100, { includeEntries: true });
    const second = generateFuzzyCorpus(100, { includeEntries: true });

    expect(first.digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(first.digest).toBe(second.digest);
    expect(first.paths).toEqual(second.paths);
    expect(first.entries).toHaveLength(100);
    expect(new Set(first.paths).size).toBe(100);
    expect(first.pathBytes).toBeLessThan(134_217_728);
    for (const pair of first.queryPairs) {
      expect(first.paths.some((path) => isFullQuerySubsequence(path, pair.extension))).toBe(true);
    }
  });

  test("uses nearest-rank ordered p50/p95 summaries", () => {
    expect(summarizeFuzzySamples([9, 1, 5, 3, 7])).toEqual({
      maxMs: 9,
      minMs: 1,
      p50Ms: 5,
      p95Ms: 9,
      sampleCount: 5,
      samplesMs: [9, 1, 5, 3, 7],
    });
  });

  test("rejects duplicate/malformed plans and missing completed metrics", () => {
    const report = validQuickReport();
    expect(() => validateFuzzyBenchmarkReport(report, { quick: true })).not.toThrow();

    const duplicate = structuredClone(report);
    duplicate.points.push(structuredClone(duplicate.points[0]));
    expect(() => validateFuzzyBenchmarkReport(duplicate, { quick: true })).toThrow();

    const missing = structuredClone(report);
    missing.points[0].query = null;
    expect(() => validateFuzzyBenchmarkReport(missing, { quick: true })).toThrow();

    const fabricated = structuredClone(report);
    fabricated.points[0].query.cold.p95Ms = 999;
    expect(() => validateFuzzyBenchmarkReport(fabricated, { quick: true })).toThrow();
  });

  test("runs the quick matcher and persistent-index workers through the public script", async () => {
    const runtimeRoot = new URL("../..", import.meta.url);
    const { stdout } = await execFileAsync(
      process.execPath,
      ["benchmarks/fuzzy-search/run.mjs", "--quick", "--check"],
      {
        cwd: runtimeRoot,
        env: { ...process.env, NODE_OPTIONS: "" },
        maxBuffer: 4 * 1024 * 1024,
        timeout: 120_000,
      },
    );
    const report = JSON.parse(stdout);
    expect(() => validateFuzzyBenchmarkReport(report, { quick: true })).not.toThrow();
    expect(report.points).toHaveLength(4);
    expect(report.points.every((point: { status: string }) => point.status === "completed")).toBe(true);
  }, 120_000);

  test("refuses an untracked benchmark evidence file", async () => {
    const runtimeRoot = new URL("../..", import.meta.url);
    const marker = new URL(
      "../../benchmarks/fuzzy-search/provenance-test-marker.tmp",
      import.meta.url,
    );
    await writeFile(marker, "untracked benchmark evidence\n", "utf8");
    try {
      let failure: any = null;
      try {
        await execFileAsync(
          process.execPath,
          ["benchmarks/fuzzy-search/run.mjs", "--quick"],
          {
            cwd: runtimeRoot,
            env: { ...process.env, NODE_OPTIONS: "" },
            maxBuffer: 4 * 1024 * 1024,
            timeout: 10_000,
          },
        );
      } catch (error) {
        failure = error;
      }
      expect(failure).not.toBeNull();
      expect(String(failure.stderr)).toContain(
        "refuses untracked files in benchmark evidence tree",
      );
    } finally {
      await rm(marker, { force: true });
    }
  });
});

function validQuickReport(): any {
  const points = ["matcher_only", "end_to_end"].flatMap((mode) =>
    [100, 1_000].map((size) => point(mode, size)),
  );
  return {
    environment: {
      cpu: { logicalCount: 1, model: "test" },
      filesystems: {
        sourceCheckout: { blockSizeBytes: 1, type: "test" },
        temporaryFixtures: { blockSizeBytes: 1, type: "test" },
      },
      memory: { totalBytes: 1 },
      os: { arch: "test", platform: "test", release: "test" },
      ripgrep: { distribution: "pinned_package", version: "ripgrep test" },
      runtime: { node: "v26.5.0", npm: "11.17.0", v8: "test" },
      sqlite: { compileOptions: ["TEST"], version: "test" },
    },
    points,
    productionTree: "1".repeat(40),
    schemaVersion: FUZZY_BENCHMARK_SCHEMA_VERSION,
    sourceRevision: "2".repeat(40),
    suiteId: FUZZY_BENCHMARK_SUITE_ID,
  };
}

function point(mode: string, size: number): any {
  const summary = summarizeFuzzySamples([1, 2, 3]);
  return {
    build: {
      elapsedMs: 1,
      kind: mode === "matcher_only" ? "prepared_candidates" : "persistent_generation",
    },
    corpus: { digest: "a".repeat(64), generatorVersion: "test", pathBytes: size, size },
    error: null,
    indexBytes: {
      closedDatabaseBytes: mode === "end_to_end" ? 1 : null,
      finalDatabaseBytes: mode === "end_to_end" ? 1 : null,
      finalLogicalPathBytes: size,
      finalOpenTotalBytes: mode === "end_to_end" ? 1 : null,
      finalShmBytes: mode === "end_to_end" ? 0 : null,
      finalWalBytes: mode === "end_to_end" ? 0 : null,
      initialDatabaseBytes: mode === "end_to_end" ? 1 : null,
      initialOpenTotalBytes: mode === "end_to_end" ? 1 : null,
      initialShmBytes: mode === "end_to_end" ? 0 : null,
      initialWalBytes: mode === "end_to_end" ? 0 : null,
      logicalPathBytes: size,
    },
    invalidation:
      mode === "end_to_end"
        ? {
            elapsedMs: 1,
            generationAfter: 2,
            generationBefore: 1,
            discoveryCalls: 1,
            path: "src/d2invalidated.ts",
            pollIntervalMs: 25,
            sentinelVisible: true,
          }
        : null,
    memory: {
      afterBuildRssBytes: 1,
      afterCorpusRssBytes: 1,
      afterQueryRssBytes: 1,
      baselineRssBytes: 1,
      peakRssBytes: 1,
    },
    mode,
    query: { cold: summary, warm: summary },
    status: "completed",
    telemetry: {},
  };
}
