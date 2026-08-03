import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, test } from "vitest";

import {
  assertFuzzyBenchmarkAcceptance,
  FUZZY_BENCHMARK_MAXIMUM_CACHE_BYTES,
  FUZZY_BENCHMARK_SCHEMA_VERSION,
  FUZZY_BENCHMARK_SUITE_ID,
  summarizeFuzzySamples,
  validateFuzzyBenchmarkReport,
} from "../../benchmarks/fuzzy-search/contract.mjs";
import {
  fuzzyBenchmarkFinalPathBytes,
  fuzzyBenchmarkInvalidationPath,
  generateFuzzyCorpus,
  isFullQuerySubsequence,
} from "../../benchmarks/fuzzy-search/corpus.mjs";
import { assertGitPathIsClean } from "../../benchmarks/fuzzy-search/run.mjs";

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
      expect(
        first.paths.some((path) =>
          isFullQuerySubsequence(path, pair.extension),
        ),
      ).toBe(true);
    }
    expect(
      [100, 1_000, 10_000, 100_000, 1_000_000].map((size) => {
        const corpus = generateFuzzyCorpus(size, {
          includeEntries: false,
          includePaths: false,
        });
        return [size, corpus.digest, corpus.pathBytes];
      }),
    ).toEqual([
      [
        100,
        "915205bdcfb1d35fde0ea8fb797c069a8d4f8ae953df1ce6fc5eb0d96b55e491",
        3_244,
      ],
      [
        1_000,
        "61ba341ddf6440069bd18eba177c2b0b5652decad61b66e499deadc3c5968a8c",
        32_224,
      ],
      [
        10_000,
        "219bfdca4c2dbec4461f9db4f7998ef29b63ccbc2c841c1ac18be9cf08d76f16",
        322_024,
      ],
      [
        100_000,
        "1d2e3dcee2439f22eda84d605c64adbf9b8b889dc4cfcce0084ec872916f35d0",
        3_220_024,
      ],
      [
        1_000_000,
        "188ab058412cb524fbed38c12ff39346a3ca8948fc58ff117a4caf46e9cba330",
        32_200_024,
      ],
    ]);
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
    expect(() =>
      validateFuzzyBenchmarkReport(report, { quick: true }),
    ).not.toThrow();

    const duplicate = structuredClone(report);
    duplicate.points.push(structuredClone(duplicate.points[0]));
    expect(() =>
      validateFuzzyBenchmarkReport(duplicate, { quick: true }),
    ).toThrow();

    const missing = structuredClone(report);
    missing.points[0].query = null;
    expect(() =>
      validateFuzzyBenchmarkReport(missing, { quick: true }),
    ).toThrow();

    const fabricated = structuredClone(report);
    fabricated.points[0].query.cold.p95Ms = 999;
    expect(() =>
      validateFuzzyBenchmarkReport(fabricated, { quick: true }),
    ).toThrow();
  });

  test("binds reports to the deterministic corpus and invalidation bytes", () => {
    const report = validQuickReport();
    for (const key of ["digest", "generatorVersion", "pathBytes"]) {
      const fabricated = structuredClone(report);
      fabricated.points[0].corpus[key] =
        key === "digest"
          ? "0".repeat(64)
          : key === "pathBytes"
            ? fabricated.points[0].corpus.pathBytes + 1
            : "fabricated";
      expect(() =>
        validateFuzzyBenchmarkReport(fabricated, { quick: true }),
      ).toThrow(/deterministic corpus/u);
    }

    const invalidFinalBytes = structuredClone(report);
    const endToEnd = invalidFinalBytes.points.find(
      (candidate: any) => candidate.mode === "end_to_end",
    );
    endToEnd.indexBytes.finalLogicalPathBytes += 1;
    expect(() =>
      validateFuzzyBenchmarkReport(invalidFinalBytes, { quick: true }),
    ).toThrow(/deterministic invalidation/u);
  });

  test("requires exact atomic invalidation evidence", () => {
    const mutations = [
      (invalidation: any) => {
        invalidation.generationAfter += 1;
      },
      (invalidation: any) => {
        invalidation.discoveryCalls = 2;
      },
      (invalidation: any) => {
        invalidation.priorGenerationObservations = 0;
      },
      (invalidation: any) => {
        invalidation.priorServiceSentinelCount = 1;
      },
      (invalidation: any) => {
        invalidation.serviceFinalSentinelCount = 2;
      },
      (invalidation: any) => {
        invalidation.persistedSentinelCount = 0;
      },
      (invalidation: any) => {
        invalidation.persistedGenerationId += 1;
      },
      (invalidation: any) => {
        invalidation.persistedEntryCount -= 1;
      },
      (invalidation: any) => {
        invalidation.persistedEntryStoreRetainedBytes =
          invalidation.maximumCacheBytes + 1;
      },
      (invalidation: any) => {
        invalidation.persistedOracleElapsedMs = -1;
      },
    ];
    for (const mutate of mutations) {
      const report = validQuickReport();
      const endToEnd = report.points.find(
        (candidate: any) => candidate.mode === "end_to_end",
      );
      mutate(endToEnd.invalidation);
      expect(() =>
        validateFuzzyBenchmarkReport(report, { quick: true }),
      ).toThrow();
    }
  });

  test("hard-gates full acceptance on measured million-entry invalidation", () => {
    const report = validFullReport();
    expect(() => assertFuzzyBenchmarkAcceptance(report)).not.toThrow();

    const missingInvalidation = structuredClone(report);
    const millionEntry = missingInvalidation.points.find(
      (candidate: any) =>
        candidate.mode === "end_to_end" && candidate.corpus.size === 1_000_000,
    );
    millionEntry.status = "resource_limited";
    millionEntry.error = {
      code: "CACHE_LIMIT",
      message: "synthetic cache rejection",
    };
    millionEntry.invalidation = null;
    millionEntry.indexBytes.finalLogicalPathBytes =
      millionEntry.indexBytes.logicalPathBytes;
    expect(() => assertFuzzyBenchmarkAcceptance(missingInvalidation)).toThrow(
      /million-entry atomic invalidation/u,
    );

    const unavailableMetrics = structuredClone(report);
    const unavailableMillion = unavailableMetrics.points.find(
      (candidate: any) =>
        candidate.mode === "end_to_end" && candidate.corpus.size === 1_000_000,
    );
    unavailableMillion.status = "resource_limited";
    unavailableMillion.error = {
      code: "QUERY_RESOURCE_LIMIT",
      message: "synthetic query limit",
    };
    unavailableMillion.build.elapsedMs = null;
    unavailableMillion.query = null;
    unavailableMillion.memory = {
      afterBuildRssBytes: null,
      afterCorpusRssBytes: null,
      afterQueryRssBytes: null,
      baselineRssBytes: null,
      peakRssBytes: null,
    };
    expect(() => assertFuzzyBenchmarkAcceptance(unavailableMetrics)).toThrow(
      /build and query measurements/u,
    );

    const measuredQueryLimit = structuredClone(report);
    const limitedMillion = measuredQueryLimit.points.find(
      (candidate: any) =>
        candidate.mode === "end_to_end" && candidate.corpus.size === 1_000_000,
    );
    limitedMillion.status = "resource_limited";
    limitedMillion.error = {
      code: "QUERY_RESOURCE_LIMIT",
      message: "synthetic measured query limit",
    };
    limitedMillion.telemetry.resourceLimitedQueries = 1;
    expect(() =>
      assertFuzzyBenchmarkAcceptance(measuredQueryLimit),
    ).not.toThrow();

    const limitedInvalidationQuery = structuredClone(report);
    const limitedInvalidationMillion = limitedInvalidationQuery.points.find(
      (candidate: any) =>
        candidate.mode === "end_to_end" && candidate.corpus.size === 1_000_000,
    );
    limitedInvalidationMillion.status = "resource_limited";
    limitedInvalidationMillion.error = {
      code: "QUERY_RESOURCE_LIMIT",
      message: "synthetic bounded invalidation query",
    };
    limitedInvalidationMillion.invalidation.serviceEvaluatedCandidates = 700_000;
    limitedInvalidationMillion.invalidation.serviceFinalSentinelCount = 0;
    limitedInvalidationMillion.invalidation.serviceResourceLimited = true;
    limitedInvalidationMillion.invalidation.serviceTruncated = true;
    limitedInvalidationMillion.telemetry.resourceLimitedQueries = 1;
    expect(() =>
      assertFuzzyBenchmarkAcceptance(limitedInvalidationQuery),
    ).not.toThrow();

    const unreportedInvalidationLimit = structuredClone(
      limitedInvalidationQuery,
    );
    const unreportedInvalidationMillion =
      unreportedInvalidationLimit.points.find(
        (candidate: any) =>
          candidate.mode === "end_to_end" &&
          candidate.corpus.size === 1_000_000,
      );
    unreportedInvalidationMillion.invalidation.serviceTruncated = false;
    expect(() =>
      assertFuzzyBenchmarkAcceptance(unreportedInvalidationLimit),
    ).toThrow(/query limit must be reported as truncation/u);

    const missingPersistedSentinel = structuredClone(limitedInvalidationQuery);
    const missingPersistedMillion = missingPersistedSentinel.points.find(
      (candidate: any) =>
        candidate.mode === "end_to_end" && candidate.corpus.size === 1_000_000,
    );
    missingPersistedMillion.invalidation.persistedSentinelCount = 0;
    expect(() =>
      assertFuzzyBenchmarkAcceptance(missingPersistedSentinel),
    ).toThrow(/persisted final generation/u);

    const zeroDatabaseBytes = structuredClone(measuredQueryLimit);
    const zeroDatabaseMillion = zeroDatabaseBytes.points.find(
      (candidate: any) =>
        candidate.mode === "end_to_end" && candidate.corpus.size === 1_000_000,
    );
    zeroDatabaseMillion.indexBytes.initialDatabaseBytes = 0;
    zeroDatabaseMillion.indexBytes.initialOpenTotalBytes = 0;
    expect(() => assertFuzzyBenchmarkAcceptance(zeroDatabaseBytes)).toThrow(
      /positive safe integer/u,
    );

    const falseQueryLimit = structuredClone(measuredQueryLimit);
    const falseQueryLimitMillion = falseQueryLimit.points.find(
      (candidate: any) =>
        candidate.mode === "end_to_end" && candidate.corpus.size === 1_000_000,
    );
    falseQueryLimitMillion.telemetry.resourceLimitedQueries = 0;
    expect(() => assertFuzzyBenchmarkAcceptance(falseQueryLimit)).toThrow(
      /positive safe integer/u,
    );

    const limitedTenThousand = structuredClone(report);
    const limitedSmallPoint = limitedTenThousand.points.find(
      (candidate: any) =>
        candidate.mode === "end_to_end" && candidate.corpus.size === 10_000,
    );
    limitedSmallPoint.status = "resource_limited";
    limitedSmallPoint.error = {
      code: "QUERY_RESOURCE_LIMIT",
      message: "synthetic small query limit",
    };
    limitedSmallPoint.telemetry.resourceLimitedQueries = 1;
    expect(() => assertFuzzyBenchmarkAcceptance(limitedTenThousand)).toThrow(
      /must complete at 10000/u,
    );

    const failedSmallerPoint = structuredClone(report);
    const smallerEndToEnd = failedSmallerPoint.points.find(
      (candidate: any) =>
        candidate.mode === "end_to_end" && candidate.corpus.size === 10_000,
    );
    smallerEndToEnd.status = "failed";
    smallerEndToEnd.error = { code: "FAILED", message: "synthetic failure" };
    smallerEndToEnd.invalidation = null;
    smallerEndToEnd.indexBytes.finalLogicalPathBytes =
      smallerEndToEnd.indexBytes.logicalPathBytes;
    expect(() => assertFuzzyBenchmarkAcceptance(failedSmallerPoint)).toThrow(
      /atomic invalidation/u,
    );
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
    expect(() =>
      validateFuzzyBenchmarkReport(report, { quick: true }),
    ).not.toThrow();
    expect(report.points).toHaveLength(4);
    expect(
      report.points.every(
        (point: { status: string }) => point.status === "completed",
      ),
    ).toBe(true);
  }, 120_000);

  test("refuses an untracked benchmark evidence file", async () => {
    const repositoryRoot = await mkdtemp(
      join(tmpdir(), "agenc-d2-provenance-test-"),
    );
    const evidencePath = "runtime/benchmarks/fuzzy-search";
    const evidenceRoot = join(repositoryRoot, evidencePath);
    try {
      await mkdir(evidenceRoot, { recursive: true });
      await writeFile(join(evidenceRoot, "tracked.mjs"), "export {};\n", "utf8");
      await execFileAsync("git", ["init", "--quiet"], { cwd: repositoryRoot });
      await execFileAsync("git", ["add", evidencePath], { cwd: repositoryRoot });
      await execFileAsync(
        "git",
        [
          "-c",
          "user.name=AgenC Test",
          "-c",
          "user.email=test@invalid.example",
          "commit",
          "--quiet",
          "-m",
          "fixture",
        ],
        { cwd: repositoryRoot },
      );
      await writeFile(
        join(evidenceRoot, "provenance-test-marker.tmp"),
        "untracked benchmark evidence\n",
        "utf8",
      );

      expect(() =>
        assertGitPathIsClean(
          evidencePath,
          "benchmark evidence tree",
          repositoryRoot,
        ),
      ).toThrow("refuses untracked files in benchmark evidence tree");
    } finally {
      await rm(repositoryRoot, { force: true, recursive: true });
    }
  });
});

function validQuickReport(): any {
  return validReport([100, 1_000], 3);
}

function validFullReport(): any {
  return validReport([10_000, 100_000, 1_000_000], 20);
}

function validReport(sizes: readonly number[], sampleCount: number): any {
  const points = ["matcher_only", "end_to_end"].flatMap((mode) =>
    sizes.map((size) => point(mode, size, sampleCount)),
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

function point(mode: string, size: number, sampleCount: number): any {
  const corpus = generateFuzzyCorpus(size, {
    includeEntries: false,
    includePaths: false,
  });
  const summary = summarizeFuzzySamples(
    Array.from({ length: sampleCount }, (_, index) => index + 1),
  );
  const invalidationPath = fuzzyBenchmarkInvalidationPath(size);
  const invalidatedPathBytes = fuzzyBenchmarkFinalPathBytes(
    size,
    corpus.pathBytes,
  );
  return {
    build: {
      elapsedMs: 1,
      kind:
        mode === "matcher_only"
          ? "prepared_candidates"
          : "persistent_generation",
    },
    corpus: {
      digest: corpus.digest,
      generatorVersion: corpus.generatorVersion,
      pathBytes: corpus.pathBytes,
      size,
    },
    error: null,
    indexBytes: {
      closedDatabaseBytes: mode === "end_to_end" ? 1 : null,
      finalDatabaseBytes: mode === "end_to_end" ? 1 : null,
      finalLogicalPathBytes:
        mode === "end_to_end" ? invalidatedPathBytes : corpus.pathBytes,
      finalOpenTotalBytes: mode === "end_to_end" ? 1 : null,
      finalShmBytes: mode === "end_to_end" ? 0 : null,
      finalWalBytes: mode === "end_to_end" ? 0 : null,
      initialDatabaseBytes: mode === "end_to_end" ? 1 : null,
      initialOpenTotalBytes: mode === "end_to_end" ? 1 : null,
      initialShmBytes: mode === "end_to_end" ? 0 : null,
      initialWalBytes: mode === "end_to_end" ? 0 : null,
      logicalPathBytes: corpus.pathBytes,
    },
    invalidation:
      mode === "end_to_end"
        ? {
            elapsedMs: 1,
            generationAfter: 2,
            generationBefore: 1,
            discoveryCalls: 1,
            maximumCacheBytes: FUZZY_BENCHMARK_MAXIMUM_CACHE_BYTES,
            path: invalidationPath,
            persistedEntryCount: size,
            persistedEntryStoreRetainedBytes: 1,
            persistedGenerationId: 2,
            persistedOracleElapsedMs: 1,
            persistedSentinelCount: 1,
            pollIntervalMs: 25,
            priorGenerationObservations: 1,
            priorServiceSentinelCount: 0,
            serviceEvaluatedCandidates: size,
            serviceFinalSentinelCount: 1,
            serviceResourceLimited: false,
            serviceTotalCandidates: size,
            serviceTruncated: false,
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
    telemetry:
      mode === "end_to_end"
        ? {
            firstLoadDiscoveryCalls: 0,
            firstLoadGenerationId: 1,
            resourceLimitedQueries: 0,
            watcherEvents: 1,
          }
        : {},
  };
}
