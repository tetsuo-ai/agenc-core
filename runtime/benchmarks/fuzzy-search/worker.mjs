#!/usr/bin/env node

import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import {
  prepareFuzzyCandidate,
  rankFuzzyCandidatesSync,
} from "../../src/search/fuzzy-match.ts";

import {
  summarizeFuzzySamples,
  validateFuzzyBenchmarkPoint,
} from "./contract.mjs";
import {
  fuzzyBenchmarkFinalPathBytes,
  fuzzyBenchmarkInvalidationPath,
  generateFuzzyCorpus,
  isFullQuerySubsequence,
} from "./corpus.mjs";

const INVALIDATION_POLL_INTERVAL_MS = 25;
const RESULT_LIMIT = 50;
const requested = parseArguments(process.argv.slice(2));

try {
  const point =
    requested.mode === "matcher_only"
      ? runMatcherOnly(requested)
      : await runEndToEnd(requested);
  validateFuzzyBenchmarkPoint(point);
  process.stdout.write(`${JSON.stringify(point)}\n`);
} catch (error) {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

function runMatcherOnly(options) {
  const baselineRssBytes = process.memoryUsage().rss;
  const corpus = generateFuzzyCorpus(options.size);
  const afterCorpusRssBytes = process.memoryUsage().rss;
  const buildStartedAt = performance.now();
  const prepared = corpus.paths.map((path) => prepareFuzzyCandidate(path));
  const buildElapsedMs = performance.now() - buildStartedAt;
  const afterBuildRssBytes = process.memoryUsage().rss;

  rankFuzzyCandidatesSync(corpus.queryPairs[0].base, corpus.paths, {
    limit: RESULT_LIMIT,
  });
  rankFuzzyCandidatesSync(corpus.queryPairs[0].extension, prepared, {
    limit: RESULT_LIMIT,
  });

  const coldSamples = [];
  const warmSamples = [];
  for (let index = 0; index < options.samples; index += 1) {
    const pair = corpus.queryPairs[index % corpus.queryPairs.length];
    let startedAt = performance.now();
    const cold = rankFuzzyCandidatesSync(pair.base, corpus.paths, {
      limit: RESULT_LIMIT,
    });
    coldSamples.push(performance.now() - startedAt);
    assertRankedResults(cold, pair.base);

    rankFuzzyCandidatesSync(pair.base, prepared, { limit: RESULT_LIMIT });
    startedAt = performance.now();
    const warm = rankFuzzyCandidatesSync(pair.extension, prepared, {
      limit: RESULT_LIMIT,
    });
    warmSamples.push(performance.now() - startedAt);
    assertRankedResults(warm, pair.extension);
  }

  const afterQueryRssBytes = process.memoryUsage().rss;
  return Object.freeze({
    build: Object.freeze({
      elapsedMs: buildElapsedMs,
      kind: "prepared_candidates",
    }),
    corpus: corpusDescriptor(corpus),
    error: null,
    indexBytes: emptyIndexBytes(corpus.pathBytes),
    invalidation: null,
    memory: memoryDescriptor(
      baselineRssBytes,
      afterCorpusRssBytes,
      afterBuildRssBytes,
      afterQueryRssBytes,
    ),
    mode: options.mode,
    query: Object.freeze({
      cold: summarizeFuzzySamples(coldSamples),
      warm: summarizeFuzzySamples(warmSamples),
    }),
    status: "completed",
    telemetry: Object.freeze({
      coldDefinition: "raw_candidate_normalization_and_match",
      resultLimit: RESULT_LIMIT,
      warmDefinition: "prepared_candidate_match_after_warmup",
    }),
  });
}

async function runEndToEnd(options) {
  const [searchModule, indexModule] = await Promise.all([
    import("../../src/app-server/fuzzy-file-search.ts"),
    import("../../src/app-server/fuzzy-file-index.ts"),
  ]);
  const {
    AgenCFuzzyFileSearchService,
    FuzzyFileSearchBoundaryError,
    MAX_FUZZY_CACHE_BYTES,
  } = searchModule;
  const { createFuzzyFileDiscoveryResult, PersistentFuzzyFileIndex } =
    indexModule;
  const baselineRssBytes = process.memoryUsage().rss;
  const temporaryRoot = options.temporaryRoot;
  const databasePath = join(temporaryRoot, "fuzzy-index.sqlite");
  let index;
  let service;
  let closedDatabaseBytes = 0;
  try {
    let corpus = generateFuzzyCorpus(options.size, {
      includeEntries: true,
      includePaths: false,
    });
    let activeEntries = corpus.entries;
    const corpusDetails = corpusDescriptor(corpus);
    const initialLogicalPathBytes = corpus.pathBytes;
    const initialFirstPathBytes = activeEntries[0].pathBytes.byteLength;
    const queryPairs = corpus.queryPairs;
    corpus = null;
    const afterCorpusRssBytes = process.memoryUsage().rss;
    let discoveryCalls = 0;
    let watcherChange = null;
    let watcherEvents = 0;
    index = new PersistentFuzzyFileIndex({ databasePath });

    const buildStartedAt = performance.now();
    const buildSignal = new AbortController().signal;
    let initialSnapshot = await index.publish(
      temporaryRoot,
      await createFuzzyFileDiscoveryResult(
        discovery(activeEntries),
        buildSignal,
      ),
      buildSignal,
      { sourceBoundary: "benchmark:initial" },
    );
    const buildElapsedMs = performance.now() - buildStartedAt;
    if (initialSnapshot === null)
      throw new Error("benchmark generation was not published");
    const initialGeneration = initialSnapshot.generationId;
    initialSnapshot = null;
    globalThis.gc?.();
    const afterBuildRssBytes = process.memoryUsage().rss;
    const initialOpenBytes = await openIndexFileBytes(databasePath);

    service = new AgenCFuzzyFileSearchService({
      discover: async () => {
        discoveryCalls += 1;
        return discovery(activeEntries);
      },
      index,
      now: () => 1_000_000,
      watchRoot: (_root, onChange) => {
        watcherChange = onChange;
        return { close() {} };
      },
    });

    let pointStatus = "completed";
    let pointError = null;
    let query = null;
    let invalidation = null;
    let resourceLimitedQueries = 0;
    let firstLoadElapsedMs = null;
    let firstLoadDiscoveryCalls = null;
    let firstLoadGenerationId = null;
    let finalLogicalPathBytes = initialLogicalPathBytes;

    try {
      const coldSamples = [];
      const warmSamples = [];
      const firstLoadStartedAt = performance.now();
      const firstLoad = await search(service, temporaryRoot, "d2t");
      firstLoadElapsedMs = performance.now() - firstLoadStartedAt;
      firstLoadDiscoveryCalls = discoveryCalls;
      firstLoadGenerationId =
        firstLoad.freshness?.roots[0]?.generationId ?? null;
      if (firstLoadGenerationId !== initialGeneration) {
        throw new Error(
          `first service load observed generation ${String(firstLoadGenerationId)}, expected ${initialGeneration}`,
        );
      }
      if (firstLoadDiscoveryCalls !== 0) {
        throw new Error(
          "first persistent service load unexpectedly invoked discovery",
        );
      }
      const discoveryBeforeQueries = discoveryCalls;
      for (let sample = 0; sample < options.samples; sample += 1) {
        const pair = queryPairs[sample % queryPairs.length];
        let startedAt = performance.now();
        const cold = await search(service, temporaryRoot, pair.base);
        coldSamples.push(performance.now() - startedAt);
        assertSearchResponse(cold, pair.base);
        if (cold.matcher?.resourceLimited === true) resourceLimitedQueries += 1;

        await search(service, temporaryRoot, pair.base);
        startedAt = performance.now();
        const warm = await search(service, temporaryRoot, pair.extension);
        warmSamples.push(performance.now() - startedAt);
        assertSearchResponse(warm, pair.extension);
        if (warm.matcher?.resourceLimited === true) resourceLimitedQueries += 1;
      }
      if (discoveryCalls !== discoveryBeforeQueries) {
        throw new Error(
          "stable indexed queries unexpectedly invoked discovery",
        );
      }
      query = Object.freeze({
        cold: summarizeFuzzySamples(coldSamples),
        warm: summarizeFuzzySamples(warmSamples),
      });

      if (typeof watcherChange !== "function") {
        throw new Error("benchmark watcher callback was not installed");
      }
      const invalidatedPath = fuzzyBenchmarkInvalidationPath(options.size);
      activeEntries = [...activeEntries];
      activeEntries[0] = Object.freeze({
        matchType: "file",
        pathBytes: Buffer.from(invalidatedPath, "utf8"),
        relativePath: invalidatedPath,
      });
      const invalidationStartedAt = performance.now();
      watcherEvents += 1;
      watcherChange();
      const observed = await waitForInvalidation({
        expectedEntryCount: options.size,
        index,
        initialGeneration,
        maximumCacheBytes: MAX_FUZZY_CACHE_BYTES,
        path: invalidatedPath,
        root: temporaryRoot,
        service,
        startedAt: invalidationStartedAt,
        timeoutMs: options.invalidationTimeoutMs,
      });
      invalidation = Object.freeze({
        discoveryCalls,
        elapsedMs: observed.serviceCutoverElapsedMs,
        generationAfter: observed.generationId,
        generationBefore: initialGeneration,
        maximumCacheBytes: MAX_FUZZY_CACHE_BYTES,
        path: invalidatedPath,
        persistedEntryCount: observed.persistedEntryCount,
        persistedEntryStoreRetainedBytes:
          observed.persistedEntryStoreRetainedBytes,
        persistedGenerationId: observed.persistedGenerationId,
        persistedOracleElapsedMs: observed.persistedOracleElapsedMs,
        persistedSentinelCount: observed.persistedSentinelCount,
        pollIntervalMs: INVALIDATION_POLL_INTERVAL_MS,
        priorGenerationObservations: observed.priorGenerationObservations,
        priorServiceSentinelCount: observed.priorServiceSentinelCount,
        serviceEvaluatedCandidates: observed.serviceEvaluatedCandidates,
        serviceFinalSentinelCount: observed.serviceFinalSentinelCount,
        serviceResourceLimited: observed.serviceResourceLimited,
        serviceTotalCandidates: observed.serviceTotalCandidates,
        serviceTruncated: observed.serviceTruncated,
      });
      if (discoveryCalls !== 1) {
        throw new Error(
          `watcher invalidation invoked discovery ${discoveryCalls} times, expected exactly once`,
        );
      }
      if (observed.serviceResourceLimited) resourceLimitedQueries += 1;
      if (resourceLimitedQueries > 0) {
        pointStatus = "resource_limited";
        pointError = Object.freeze({
          code: "QUERY_RESOURCE_LIMIT",
          message: `${resourceLimitedQueries} measured or invalidation queries reached a production resource limit`,
        });
      }
      finalLogicalPathBytes = fuzzyBenchmarkFinalPathBytes(
        options.size,
        initialLogicalPathBytes,
      );
      if (
        finalLogicalPathBytes !==
        initialLogicalPathBytes -
          initialFirstPathBytes +
          Buffer.byteLength(invalidatedPath, "utf8")
      ) {
        throw new Error(
          "deterministic invalidation path-byte accounting diverged",
        );
      }
    } catch (error) {
      if (error instanceof FuzzyFileSearchBoundaryError) {
        pointStatus = "resource_limited";
        pointError = errorDescriptor(error);
      } else {
        throw error;
      }
    }

    const afterQueryRssBytes = process.memoryUsage().rss;
    const finalOpenBytes = await openIndexFileBytes(databasePath);
    await service.close();
    service = undefined;
    index.close();
    index = undefined;
    closedDatabaseBytes = await fileSize(databasePath);
    const indexBytes = indexByteDescriptor({
      closedDatabaseBytes,
      finalLogicalPathBytes,
      finalOpenBytes,
      initialLogicalPathBytes,
      initialOpenBytes,
    });
    return Object.freeze({
      build: Object.freeze({
        elapsedMs: buildElapsedMs,
        kind: "persistent_generation",
      }),
      corpus: corpusDetails,
      error: pointStatus === "completed" ? null : pointError,
      indexBytes,
      invalidation,
      memory: memoryDescriptor(
        baselineRssBytes,
        afterCorpusRssBytes,
        afterBuildRssBytes,
        afterQueryRssBytes,
      ),
      mode: options.mode,
      query,
      status: pointStatus,
      telemetry: Object.freeze({
        discoveryCalls,
        firstLoadDiscoveryCalls,
        firstLoadElapsedMs,
        firstLoadGenerationId,
        resourceLimitedQueries,
        watcherDebounceIncluded: true,
        watcherEvents,
      }),
    });
  } finally {
    if (service !== undefined) await service.close().catch(() => {});
    if (index !== undefined) index.close();
    await rm(temporaryRoot, { force: true, recursive: true });
  }
}

async function waitForInvalidation(options) {
  const deadline = performance.now() + options.timeoutMs;
  let priorGenerationObservations = 0;
  while (performance.now() < deadline) {
    const response = await search(
      options.service,
      options.root,
      "d2invalidated",
    );
    const freshness = response.freshness?.roots[0];
    const generationId = freshness?.generationId ?? null;
    const serviceSentinelCount = response.files.filter(
      (file) => file.path === options.path,
    ).length;
    if (generationId === options.initialGeneration) {
      priorGenerationObservations += 1;
      if (serviceSentinelCount !== 0) {
        throw new Error(
          "the prior generation exposed the invalidation sentinel",
        );
      }
    } else if (generationId !== null) {
      if (generationId !== options.initialGeneration + 1) {
        throw new Error(
          `invalidation observed generation ${generationId}, expected ${options.initialGeneration + 1}`,
        );
      }
      if (priorGenerationObservations === 0) {
        throw new Error(
          "invalidation cut over before observing the prior generation",
        );
      }
      const matcher = response.matcher;
      if (matcher === undefined) {
        throw new Error("the final generation omitted matcher metadata");
      }
      const serviceResourceLimited = matcher.resourceLimited === true;
      const serviceTruncated = response.freshness?.truncated === true;
      if (serviceResourceLimited !== serviceTruncated) {
        throw new Error(
          "the final service response did not expose its query limit as truncation",
        );
      }
      if (!serviceResourceLimited && serviceSentinelCount !== 1) {
        throw new Error(
          `the unrestricted final service response exposed ${serviceSentinelCount} exact sentinels, expected one`,
        );
      }
      if (serviceSentinelCount > 1) {
        throw new Error(
          "the final service response exposed duplicate invalidation sentinels",
        );
      }
      const serviceCutoverElapsedMs = performance.now() - options.startedAt;
      const persistedOracleStartedAt = performance.now();
      let persistedSnapshot = await options.index.readCurrent(options.root);
      if (persistedSnapshot === null) {
        throw new Error("the persisted final generation was unavailable");
      }
      const persistedGenerationId = persistedSnapshot.generationId;
      if (persistedGenerationId !== generationId) {
        throw new Error(
          `persisted generation ${persistedGenerationId} did not match service generation ${generationId}`,
        );
      }
      if (persistedSnapshot.entryCount !== options.expectedEntryCount) {
        throw new Error(
          `persisted generation contained ${persistedSnapshot.entryCount} entries, expected ${options.expectedEntryCount}`,
        );
      }
      const persistedSentinelCount = countExactStoredPath(
        persistedSnapshot.entryStore,
        options.path,
      );
      if (persistedSentinelCount !== 1) {
        throw new Error(
          `persisted generation contained ${persistedSentinelCount} exact sentinels, expected one`,
        );
      }
      const persistedEntryCount = persistedSnapshot.entryCount;
      const persistedEntryStoreRetainedBytes =
        persistedSnapshot.entryStore.retainedBytes;
      if (persistedEntryStoreRetainedBytes > options.maximumCacheBytes) {
        throw new Error(
          "persisted entry store exceeded the production cache ceiling",
        );
      }
      persistedSnapshot = null;
      globalThis.gc?.();
      const persistedOracleElapsedMs =
        performance.now() - persistedOracleStartedAt;
      return {
        generationId,
        persistedEntryCount,
        persistedEntryStoreRetainedBytes,
        persistedGenerationId,
        persistedOracleElapsedMs,
        persistedSentinelCount,
        priorGenerationObservations,
        priorServiceSentinelCount: 0,
        serviceEvaluatedCandidates: matcher.evaluatedCandidates,
        serviceFinalSentinelCount: serviceSentinelCount,
        serviceResourceLimited,
        serviceCutoverElapsedMs,
        serviceTotalCandidates: matcher.totalCandidates,
        serviceTruncated,
      };
    }
    await new Promise((resolve) =>
      setTimeout(resolve, INVALIDATION_POLL_INTERVAL_MS),
    );
  }
  throw new Error(
    `fuzzy benchmark invalidation exceeded ${options.timeoutMs}ms`,
  );
}

function countExactStoredPath(entryStore, path) {
  const target = Buffer.from(path, "utf8");
  let lower = 0;
  let upper = entryStore.entryCount;
  while (lower < upper) {
    const middle = lower + Math.floor((upper - lower) / 2);
    const order = Buffer.compare(entryStore.pathBytesAt(middle), target);
    if (order < 0) lower = middle + 1;
    else upper = middle;
  }
  if (lower >= entryStore.entryCount) return 0;
  if (Buffer.compare(entryStore.pathBytesAt(lower), target) !== 0) return 0;
  if (
    lower + 1 < entryStore.entryCount &&
    Buffer.compare(entryStore.pathBytesAt(lower + 1), target) === 0
  ) {
    return 2;
  }
  return 1;
}

function search(service, root, query) {
  return service.search(
    { limit: RESULT_LIMIT, query, roots: [root] },
    { allowedRoots: [root] },
  );
}

function discovery(entries) {
  return Object.freeze({
    directoryCoverage: "complete",
    entries,
    truncated: false,
  });
}

function assertRankedResults(results, query) {
  if (results.length === 0)
    throw new Error(`matcher returned no results for ${query}`);
  for (const result of results) {
    if (!isFullQuerySubsequence(result.candidate, query)) {
      throw new Error(`matcher returned a partial-query result for ${query}`);
    }
  }
}

function assertSearchResponse(response, query) {
  if (
    response.files.length === 0 &&
    response.matcher?.resourceLimited !== true
  ) {
    throw new Error(`indexed search returned no results for ${query}`);
  }
  for (const result of response.files) {
    if (!isFullQuerySubsequence(result.path, query)) {
      throw new Error(
        `indexed search returned a partial-query result for ${query}`,
      );
    }
  }
}

function corpusDescriptor(corpus) {
  return Object.freeze({
    digest: corpus.digest,
    generatorVersion: corpus.generatorVersion,
    pathBytes: corpus.pathBytes,
    size: corpus.size,
  });
}

function emptyIndexBytes(logicalPathBytes) {
  return Object.freeze({
    closedDatabaseBytes: null,
    finalDatabaseBytes: null,
    finalLogicalPathBytes: logicalPathBytes,
    finalOpenTotalBytes: null,
    finalShmBytes: null,
    finalWalBytes: null,
    initialDatabaseBytes: null,
    initialOpenTotalBytes: null,
    initialShmBytes: null,
    initialWalBytes: null,
    logicalPathBytes,
  });
}

async function openIndexFileBytes(databasePath) {
  const databaseBytes = await fileSize(databasePath);
  const walBytes = await fileSize(`${databasePath}-wal`);
  const shmBytes = await fileSize(`${databasePath}-shm`);
  return Object.freeze({
    databaseBytes,
    totalBytes: databaseBytes + walBytes + shmBytes,
    shmBytes,
    walBytes,
  });
}

function indexByteDescriptor(options) {
  return Object.freeze({
    closedDatabaseBytes: options.closedDatabaseBytes,
    finalDatabaseBytes: options.finalOpenBytes.databaseBytes,
    finalLogicalPathBytes: options.finalLogicalPathBytes,
    finalOpenTotalBytes: options.finalOpenBytes.totalBytes,
    finalShmBytes: options.finalOpenBytes.shmBytes,
    finalWalBytes: options.finalOpenBytes.walBytes,
    initialDatabaseBytes: options.initialOpenBytes.databaseBytes,
    initialOpenTotalBytes: options.initialOpenBytes.totalBytes,
    initialShmBytes: options.initialOpenBytes.shmBytes,
    initialWalBytes: options.initialOpenBytes.walBytes,
    logicalPathBytes: options.initialLogicalPathBytes,
  });
}

async function fileSize(path) {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if (error?.code === "ENOENT") return 0;
    throw error;
  }
}

function memoryDescriptor(baseline, afterCorpus, afterBuild, afterQuery) {
  return Object.freeze({
    afterBuildRssBytes: afterBuild,
    afterCorpusRssBytes: afterCorpus,
    afterQueryRssBytes: afterQuery,
    baselineRssBytes: baseline,
    peakRssBytes: normalizeMaximumRss(process.resourceUsage().maxRSS),
  });
}

function normalizeMaximumRss(value) {
  return process.platform === "darwin" ? value : value * 1_024;
}

function errorDescriptor(error) {
  return Object.freeze({
    code: error.reason ?? error.code ?? error.name,
    message: error.message,
  });
}

function parseArguments(args) {
  if (
    args.length !== 10 ||
    args[0] !== "--mode" ||
    args[2] !== "--size" ||
    args[4] !== "--samples" ||
    args[6] !== "--invalidation-timeout-ms" ||
    args[8] !== "--temporary-root"
  ) {
    throw new Error(
      "usage: worker.mjs --mode <matcher_only|end_to_end> --size <n> --samples <n> --invalidation-timeout-ms <n> --temporary-root <path>",
    );
  }
  const mode = args[1];
  const size = Number(args[3]);
  const samples = Number(args[5]);
  const invalidationTimeoutMs = Number(args[7]);
  const temporaryRoot = args[9];
  if (mode !== "matcher_only" && mode !== "end_to_end") {
    throw new Error(`invalid benchmark mode ${mode}`);
  }
  for (const [label, value] of [
    ["size", size],
    ["samples", samples],
    ["invalidation timeout", invalidationTimeoutMs],
  ]) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${label} must be a positive safe integer`);
    }
  }
  if (temporaryRoot.length === 0)
    throw new Error("temporary root must not be empty");
  return Object.freeze({
    invalidationTimeoutMs,
    mode,
    samples,
    size,
    temporaryRoot,
  });
}
