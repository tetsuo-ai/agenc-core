export const FUZZY_BENCHMARK_SCHEMA_VERSION = 1;
export const FUZZY_BENCHMARK_SUITE_ID = "agenc.d2.fuzzy-search.v1";
export const FULL_CORPUS_SIZES = Object.freeze([10_000, 100_000, 1_000_000]);
export const QUICK_CORPUS_SIZES = Object.freeze([100, 1_000]);
export const FUZZY_BENCHMARK_MODES = Object.freeze([
  "matcher_only",
  "end_to_end",
]);
export const FULL_QUERY_SAMPLE_COUNT = 20;
export const QUICK_QUERY_SAMPLE_COUNT = 3;
export const FUZZY_BENCHMARK_MAXIMUM_CACHE_BYTES = 536_870_912;

const MILLION_ENTRY_ACCEPTANCE_SIZE = 1_000_000;
const MINIMUM_RESOURCE_LIMITED_ACCEPTANCE_SIZE = 100_000;
const CORPUS_GENERATOR_VERSION = "agenc-d2-fuzzy-corpus-v1";
const FIRST_CORPUS_PATH = "src/d2alpha/d2alpha-exact-0000.ts";
const EXPECTED_CORPUS_DESCRIPTORS = Object.freeze({
  100: Object.freeze({
    digest: "915205bdcfb1d35fde0ea8fb797c069a8d4f8ae953df1ce6fc5eb0d96b55e491",
    generatorVersion: CORPUS_GENERATOR_VERSION,
    pathBytes: 3_244,
  }),
  1_000: Object.freeze({
    digest: "61ba341ddf6440069bd18eba177c2b0b5652decad61b66e499deadc3c5968a8c",
    generatorVersion: CORPUS_GENERATOR_VERSION,
    pathBytes: 32_224,
  }),
  10_000: Object.freeze({
    digest: "219bfdca4c2dbec4461f9db4f7998ef29b63ccbc2c841c1ac18be9cf08d76f16",
    generatorVersion: CORPUS_GENERATOR_VERSION,
    pathBytes: 322_024,
  }),
  100_000: Object.freeze({
    digest: "1d2e3dcee2439f22eda84d605c64adbf9b8b889dc4cfcce0084ec872916f35d0",
    generatorVersion: CORPUS_GENERATOR_VERSION,
    pathBytes: 3_220_024,
  }),
  1_000_000: Object.freeze({
    digest: "188ab058412cb524fbed38c12ff39346a3ca8948fc58ff117a4caf46e9cba330",
    generatorVersion: CORPUS_GENERATOR_VERSION,
    pathBytes: 32_200_024,
  }),
});

const POINT_STATUSES = new Set([
  "completed",
  "resource_limited",
  "timed_out",
  "failed",
]);

export function summarizeFuzzySamples(samples) {
  if (!Array.isArray(samples) || samples.length === 0) {
    throw new TypeError("fuzzy benchmark samples must be a nonempty array");
  }
  const sorted = samples
    .map(finiteNonnegative)
    .sort((left, right) => left - right);
  return Object.freeze({
    maxMs: sorted.at(-1),
    minMs: sorted[0],
    p50Ms: nearestRank(sorted, 0.5),
    p95Ms: nearestRank(sorted, 0.95),
    sampleCount: sorted.length,
    samplesMs: Object.freeze([...samples]),
  });
}

export function validateFuzzyBenchmarkPoint(point) {
  requireObject(point, "point");
  if (!FUZZY_BENCHMARK_MODES.includes(point.mode)) {
    throw new TypeError(`invalid fuzzy benchmark mode ${String(point.mode)}`);
  }
  if (!POINT_STATUSES.has(point.status)) {
    throw new TypeError(
      `invalid fuzzy benchmark status ${String(point.status)}`,
    );
  }
  positiveSafeInteger(point.corpus?.size, "point.corpus.size");
  hexDigest(point.corpus?.digest, 64, "point.corpus.digest");
  nonemptyString(
    point.corpus?.generatorVersion,
    "point.corpus.generatorVersion",
  );
  nonnegativeSafeInteger(point.corpus?.pathBytes, "point.corpus.pathBytes");
  const expectedCorpus = expectedCorpusDescriptor(point.corpus.size);
  for (const key of ["digest", "generatorVersion", "pathBytes"]) {
    if (point.corpus[key] !== expectedCorpus[key]) {
      throw new TypeError(
        `point.corpus.${key} does not match deterministic corpus ${point.corpus.size}`,
      );
    }
  }
  const expectedBuildKind =
    point.mode === "matcher_only"
      ? "prepared_candidates"
      : "persistent_generation";
  if (point.build?.kind !== expectedBuildKind) {
    throw new TypeError(`point.build.kind must be ${expectedBuildKind}`);
  }
  if (point.build.elapsedMs === null) {
    if (point.status === "completed") {
      throw new TypeError("completed point requires build elapsed time");
    }
  } else {
    finiteNonnegative(point.build.elapsedMs);
  }
  validateMemory(point.memory, point.status);
  validateIndexBytes(point.indexBytes);
  if (point.indexBytes.logicalPathBytes !== point.corpus.pathBytes) {
    throw new TypeError(
      "logical index bytes must equal generated corpus path bytes",
    );
  }
  const requiredFinalPathBytes =
    point.invalidation === null
      ? point.corpus.pathBytes
      : deterministicFinalPathBytes(point.corpus.size, point.corpus.pathBytes);
  if (point.indexBytes.finalLogicalPathBytes !== requiredFinalPathBytes) {
    throw new TypeError(
      "final logical index bytes do not match deterministic invalidation",
    );
  }

  if (point.query !== null) {
    requireObject(point.query, "point.query");
    validateSummary(point.query.cold, "point.query.cold");
    validateSummary(point.query.warm, "point.query.warm");
  } else if (point.status === "completed") {
    throw new TypeError(
      "completed fuzzy benchmark point requires query metrics",
    );
  }

  if (point.invalidation !== null) {
    finiteNonnegative(point.invalidation.elapsedMs);
    positiveSafeInteger(
      point.invalidation.generationAfter,
      "point.invalidation.generationAfter",
    );
    positiveSafeInteger(
      point.invalidation.generationBefore,
      "point.invalidation.generationBefore",
    );
    if (
      point.invalidation.generationAfter !==
      point.invalidation.generationBefore + 1
    ) {
      throw new TypeError(
        "invalidation must publish exactly the next generation",
      );
    }
    positiveSafeInteger(
      point.invalidation.pollIntervalMs,
      "point.invalidation.pollIntervalMs",
    );
    if (point.invalidation.discoveryCalls !== 1) {
      throw new TypeError("invalidation must perform exactly one discovery");
    }
    positiveSafeInteger(
      point.invalidation.priorGenerationObservations,
      "point.invalidation.priorGenerationObservations",
    );
    if (point.invalidation.priorServiceSentinelCount !== 0) {
      throw new TypeError("the prior generation must not expose the sentinel");
    }
    if (
      point.invalidation.persistedGenerationId !==
      point.invalidation.generationAfter
    ) {
      throw new TypeError(
        "the persisted generation must match the service cutover generation",
      );
    }
    if (point.invalidation.persistedSentinelCount !== 1) {
      throw new TypeError(
        "the persisted final generation must contain the sentinel exactly once",
      );
    }
    if (point.invalidation.persistedEntryCount !== point.corpus.size) {
      throw new TypeError(
        "the persisted final generation must contain the complete corpus",
      );
    }
    positiveSafeInteger(
      point.invalidation.persistedEntryStoreRetainedBytes,
      "point.invalidation.persistedEntryStoreRetainedBytes",
    );
    finiteNonnegative(point.invalidation.persistedOracleElapsedMs);
    if (
      point.invalidation.maximumCacheBytes !==
      FUZZY_BENCHMARK_MAXIMUM_CACHE_BYTES
    ) {
      throw new TypeError(
        "invalidation must report the production fuzzy cache ceiling",
      );
    }
    if (
      point.invalidation.persistedEntryStoreRetainedBytes >
      point.invalidation.maximumCacheBytes
    ) {
      throw new TypeError(
        "persisted final entry store exceeds the production cache ceiling",
      );
    }
    nonnegativeSafeInteger(
      point.invalidation.serviceFinalSentinelCount,
      "point.invalidation.serviceFinalSentinelCount",
    );
    if (point.invalidation.serviceFinalSentinelCount > 1) {
      throw new TypeError(
        "the final service response cannot contain duplicate sentinels",
      );
    }
    nonnegativeSafeInteger(
      point.invalidation.serviceEvaluatedCandidates,
      "point.invalidation.serviceEvaluatedCandidates",
    );
    positiveSafeInteger(
      point.invalidation.serviceTotalCandidates,
      "point.invalidation.serviceTotalCandidates",
    );
    if (point.invalidation.serviceTotalCandidates !== point.corpus.size) {
      throw new TypeError(
        "the final service response must bind the complete corpus size",
      );
    }
    if (
      point.invalidation.serviceEvaluatedCandidates >
      point.invalidation.serviceTotalCandidates
    ) {
      throw new TypeError(
        "the final service response evaluated too many candidates",
      );
    }
    if (typeof point.invalidation.serviceResourceLimited !== "boolean") {
      throw new TypeError(
        "point.invalidation.serviceResourceLimited must be boolean",
      );
    }
    if (typeof point.invalidation.serviceTruncated !== "boolean") {
      throw new TypeError(
        "point.invalidation.serviceTruncated must be boolean",
      );
    }
    if (
      point.invalidation.serviceResourceLimited !==
      point.invalidation.serviceTruncated
    ) {
      throw new TypeError(
        "a final service query limit must be reported as truncation",
      );
    }
    if (
      !point.invalidation.serviceResourceLimited &&
      point.invalidation.serviceFinalSentinelCount !== 1
    ) {
      throw new TypeError(
        "an unrestricted final service response must expose the sentinel exactly once",
      );
    }
    if (
      !point.invalidation.serviceResourceLimited &&
      point.invalidation.serviceEvaluatedCandidates !==
        point.invalidation.serviceTotalCandidates
    ) {
      throw new TypeError(
        "an unrestricted final service response must evaluate the complete corpus",
      );
    }
    const expectedInvalidationPath = expectedInvalidationPathForSize(
      point.corpus.size,
    );
    if (point.invalidation.path !== expectedInvalidationPath) {
      throw new TypeError(
        "point.invalidation.path does not match the deterministic sentinel",
      );
    }
    requireObject(point.telemetry, "point.telemetry");
    if (
      point.telemetry.firstLoadGenerationId !==
      point.invalidation.generationBefore
    ) {
      throw new TypeError(
        "the first service load must hydrate the initial generation",
      );
    }
    if (point.telemetry.firstLoadDiscoveryCalls !== 0) {
      throw new TypeError("the first service load must not invoke discovery");
    }
    if (point.telemetry.watcherEvents !== 1) {
      throw new TypeError(
        "invalidation must begin from exactly one watcher event",
      );
    }
    nonnegativeSafeInteger(
      point.telemetry.resourceLimitedQueries,
      "point.telemetry.resourceLimitedQueries",
    );
    if (
      point.invalidation.serviceResourceLimited &&
      point.telemetry.resourceLimitedQueries === 0
    ) {
      throw new TypeError(
        "a limited invalidation query must increment resourceLimitedQueries",
      );
    }
  }
  if (point.mode === "matcher_only") {
    if (point.invalidation !== null) {
      throw new TypeError("matcher-only point cannot report invalidation");
    }
    for (const key of [
      "initialDatabaseBytes",
      "initialWalBytes",
      "initialShmBytes",
      "initialOpenTotalBytes",
      "finalDatabaseBytes",
      "finalWalBytes",
      "finalShmBytes",
      "finalOpenTotalBytes",
      "closedDatabaseBytes",
    ]) {
      if (point.indexBytes[key] !== null) {
        throw new TypeError(`matcher-only point cannot report ${key}`);
      }
    }
  }
  if (point.mode === "end_to_end" && point.status === "completed") {
    for (const key of [
      "initialDatabaseBytes",
      "initialOpenTotalBytes",
      "finalDatabaseBytes",
      "finalOpenTotalBytes",
      "closedDatabaseBytes",
    ]) {
      if (
        !Number.isSafeInteger(point.indexBytes[key]) ||
        point.indexBytes[key] <= 0
      ) {
        throw new TypeError(
          `completed end-to-end point requires positive ${key}`,
        );
      }
    }
    for (const key of [
      "initialWalBytes",
      "initialShmBytes",
      "finalWalBytes",
      "finalShmBytes",
    ]) {
      nonnegativeSafeInteger(point.indexBytes[key], `point.indexBytes.${key}`);
    }
  }
  if (
    point.mode === "end_to_end" &&
    point.status === "completed" &&
    point.invalidation === null
  ) {
    throw new TypeError(
      "completed end-to-end point requires invalidation metrics",
    );
  }
  if (point.status === "completed" && point.error !== null) {
    throw new TypeError(
      "completed fuzzy benchmark point cannot report an error",
    );
  }
  if (point.status !== "completed") {
    requireObject(point.error, "point.error");
    nonemptyString(point.error.code, "point.error.code");
    nonemptyString(point.error.message, "point.error.message");
  }
  return point;
}

export function validateFuzzyBenchmarkReport(report, options = {}) {
  requireObject(report, "report");
  if (report.schemaVersion !== FUZZY_BENCHMARK_SCHEMA_VERSION) {
    throw new TypeError("unsupported fuzzy benchmark schema version");
  }
  if (report.suiteId !== FUZZY_BENCHMARK_SUITE_ID) {
    throw new TypeError("unexpected fuzzy benchmark suite id");
  }
  hexDigest(report.sourceRevision, 40, "report.sourceRevision");
  hexDigest(report.productionTree, 40, "report.productionTree");
  validateEnvironment(report.environment);
  if (!Array.isArray(report.points) || report.points.length === 0) {
    throw new TypeError("fuzzy benchmark report requires points");
  }
  for (const point of report.points) validateFuzzyBenchmarkPoint(point);

  const expectedSizes =
    options.quick === true ? QUICK_CORPUS_SIZES : FULL_CORPUS_SIZES;
  const expected = new Set(
    FUZZY_BENCHMARK_MODES.flatMap((mode) =>
      expectedSizes.map((size) => `${mode}:${size}`),
    ),
  );
  const actualKeys = report.points.map(
    (point) => `${point.mode}:${point.corpus.size}`,
  );
  const actual = new Set(actualKeys);
  if (
    actualKeys.length !== expected.size ||
    actual.size !== actualKeys.length ||
    [...expected].some((key) => !actual.has(key))
  ) {
    throw new TypeError(
      "fuzzy benchmark report does not contain the exact plan",
    );
  }
  const expectedSampleCount =
    options.quick === true ? QUICK_QUERY_SAMPLE_COUNT : FULL_QUERY_SAMPLE_COUNT;
  for (const point of report.points) {
    if (point.query === null) continue;
    for (const label of ["cold", "warm"]) {
      if (point.query[label].sampleCount !== expectedSampleCount) {
        throw new TypeError(
          `${point.mode}/${point.corpus.size} ${label} sample count does not match the plan`,
        );
      }
    }
  }
  return report;
}

export function assertFuzzyBenchmarkAcceptance(report) {
  validateFuzzyBenchmarkReport(report, { quick: false });
  const millionEntryPoint = report.points.find(
    (point) =>
      point?.mode === "end_to_end" &&
      point?.corpus?.size === MILLION_ENTRY_ACCEPTANCE_SIZE,
  );
  if (
    millionEntryPoint?.invalidation === null ||
    millionEntryPoint === undefined
  ) {
    throw new TypeError(
      "full fuzzy benchmark acceptance requires the million-entry atomic invalidation",
    );
  }
  for (const point of report.points) {
    const persistent = point.mode === "end_to_end";
    requireAcceptanceMeasurements(point, persistent);
    if (!persistent) {
      if (point.status !== "completed") {
        throw new TypeError(
          `full matcher acceptance must complete at ${point.corpus.size}`,
        );
      }
      continue;
    }
    if (point.invalidation === null) {
      throw new TypeError(
        `full end-to-end acceptance requires atomic invalidation at ${point.corpus.size}`,
      );
    }
    if (
      point.status !== "completed" &&
      !(
        point.status === "resource_limited" &&
        point.error?.code === "QUERY_RESOURCE_LIMIT"
      )
    ) {
      throw new TypeError(
        `end-to-end acceptance at ${point.corpus.size} permits only completed queries or a measured query resource limit`,
      );
    }
    if (
      point.corpus.size < MINIMUM_RESOURCE_LIMITED_ACCEPTANCE_SIZE &&
      point.status !== "completed"
    ) {
      throw new TypeError(
        `full end-to-end acceptance must complete at ${point.corpus.size}`,
      );
    }
    if (point.status === "resource_limited") {
      positiveSafeInteger(
        point.telemetry?.resourceLimitedQueries,
        `${point.corpus.size} resourceLimitedQueries`,
      );
    } else if (point.telemetry?.resourceLimitedQueries !== 0) {
      throw new TypeError(
        `completed ${point.corpus.size} acceptance cannot report resource-limited queries`,
      );
    }
  }
  return report;
}

function expectedCorpusDescriptor(size) {
  const descriptor = EXPECTED_CORPUS_DESCRIPTORS[size];
  if (descriptor === undefined) {
    throw new TypeError(`no frozen corpus descriptor exists for size ${size}`);
  }
  return descriptor;
}

function expectedInvalidationPathForSize(size) {
  return `src/000-d2invalidated/d2invalidated-exact-${size}.ts`;
}

function deterministicFinalPathBytes(size, initialPathBytes) {
  return (
    initialPathBytes -
    Buffer.byteLength(FIRST_CORPUS_PATH, "utf8") +
    Buffer.byteLength(expectedInvalidationPathForSize(size), "utf8")
  );
}

function requireAcceptanceMeasurements(point, persistent) {
  if (
    point === undefined ||
    point.build?.elapsedMs === null ||
    point.query === null
  ) {
    throw new TypeError(
      "full acceptance requires build and query measurements",
    );
  }
  for (const key of [
    "baselineRssBytes",
    "afterCorpusRssBytes",
    "afterBuildRssBytes",
    "afterQueryRssBytes",
    "peakRssBytes",
  ]) {
    if (point.memory?.[key] === null || point.memory?.[key] === undefined) {
      throw new TypeError(`full acceptance requires point.memory.${key}`);
    }
  }
  if (!persistent) return;
  for (const key of [
    "initialDatabaseBytes",
    "initialOpenTotalBytes",
    "finalDatabaseBytes",
    "finalOpenTotalBytes",
    "closedDatabaseBytes",
  ]) {
    positiveSafeInteger(
      point.indexBytes?.[key],
      `full point.indexBytes.${key}`,
    );
  }
  for (const key of [
    "initialWalBytes",
    "initialShmBytes",
    "finalWalBytes",
    "finalShmBytes",
  ]) {
    nonnegativeSafeInteger(
      point.indexBytes?.[key],
      `full point.indexBytes.${key}`,
    );
  }
}

function validateEnvironment(environment) {
  requireObject(environment, "report.environment");
  requireObject(environment.cpu, "report.environment.cpu");
  positiveSafeInteger(
    environment.cpu.logicalCount,
    "report.environment.cpu.logicalCount",
  );
  nonemptyString(environment.cpu.model, "report.environment.cpu.model");

  requireObject(environment.filesystems, "report.environment.filesystems");
  for (const name of ["sourceCheckout", "temporaryFixtures"]) {
    const filesystem = environment.filesystems[name];
    requireObject(filesystem, `report.environment.filesystems.${name}`);
    positiveSafeInteger(
      filesystem.blockSizeBytes,
      `report.environment.filesystems.${name}.blockSizeBytes`,
    );
    nonemptyString(
      filesystem.type,
      `report.environment.filesystems.${name}.type`,
    );
  }

  requireObject(environment.memory, "report.environment.memory");
  positiveSafeInteger(
    environment.memory.totalBytes,
    "report.environment.memory.totalBytes",
  );

  requireObject(environment.os, "report.environment.os");
  for (const key of ["arch", "platform", "release"]) {
    nonemptyString(environment.os[key], `report.environment.os.${key}`);
  }

  requireObject(environment.runtime, "report.environment.runtime");
  if (
    environment.runtime.node !== "v26.5.0" ||
    environment.runtime.npm !== "11.17.0"
  ) {
    throw new TypeError(
      "fuzzy benchmark report requires the pinned Node/npm toolchain",
    );
  }
  nonemptyString(environment.runtime.v8, "report.environment.runtime.v8");

  requireObject(environment.sqlite, "report.environment.sqlite");
  nonemptyString(
    environment.sqlite.version,
    "report.environment.sqlite.version",
  );
  if (
    !Array.isArray(environment.sqlite.compileOptions) ||
    environment.sqlite.compileOptions.length === 0 ||
    environment.sqlite.compileOptions.length > 4_096
  ) {
    throw new TypeError(
      "report.environment.sqlite.compileOptions is not bounded",
    );
  }
  for (const option of environment.sqlite.compileOptions) {
    nonemptyString(option, "report.environment.sqlite.compileOptions[]");
  }
  const sortedOptions = [...environment.sqlite.compileOptions].sort();
  if (
    JSON.stringify(sortedOptions) !==
    JSON.stringify(environment.sqlite.compileOptions)
  ) {
    throw new TypeError(
      "report.environment.sqlite.compileOptions must be sorted",
    );
  }

  requireObject(environment.ripgrep, "report.environment.ripgrep");
  if (environment.ripgrep.distribution !== "pinned_package") {
    throw new TypeError(
      "report.environment.ripgrep must use the pinned package",
    );
  }
  nonemptyString(
    environment.ripgrep.version,
    "report.environment.ripgrep.version",
  );
}

function validateMemory(memory, status) {
  requireObject(memory, "point.memory");
  const observations = [];
  for (const key of [
    "baselineRssBytes",
    "afterCorpusRssBytes",
    "afterBuildRssBytes",
    "afterQueryRssBytes",
    "peakRssBytes",
  ]) {
    if (memory[key] === null && status !== "completed") continue;
    nonnegativeSafeInteger(memory[key], `point.memory.${key}`);
    observations.push(memory[key]);
  }
  if (observations.length === 0) return;
  const endpoints = [
    memory.baselineRssBytes,
    memory.afterCorpusRssBytes,
    memory.afterBuildRssBytes,
    memory.afterQueryRssBytes,
  ];
  if (
    endpoints.some((value) => value === null) ||
    memory.peakRssBytes === null
  ) {
    throw new TypeError(
      "memory observations must be either complete or unavailable",
    );
  }
  if (memory.peakRssBytes < Math.max(...endpoints)) {
    throw new TypeError(
      "point.memory.peakRssBytes is below an endpoint observation",
    );
  }
}

function validateIndexBytes(indexBytes) {
  requireObject(indexBytes, "point.indexBytes");
  for (const key of [
    "logicalPathBytes",
    "finalLogicalPathBytes",
    "initialDatabaseBytes",
    "initialWalBytes",
    "initialShmBytes",
    "initialOpenTotalBytes",
    "finalDatabaseBytes",
    "finalWalBytes",
    "finalShmBytes",
    "finalOpenTotalBytes",
    "closedDatabaseBytes",
  ]) {
    if (indexBytes[key] !== null) {
      nonnegativeSafeInteger(indexBytes[key], `point.indexBytes.${key}`);
    }
  }
  positiveSafeInteger(
    indexBytes.logicalPathBytes,
    "point.indexBytes.logicalPathBytes",
  );
  positiveSafeInteger(
    indexBytes.finalLogicalPathBytes,
    "point.indexBytes.finalLogicalPathBytes",
  );
  for (const prefix of ["initial", "final"]) {
    const values = [
      indexBytes[`${prefix}DatabaseBytes`],
      indexBytes[`${prefix}WalBytes`],
      indexBytes[`${prefix}ShmBytes`],
      indexBytes[`${prefix}OpenTotalBytes`],
    ];
    const present = values.filter((value) => value !== null).length;
    if (present !== 0 && present !== values.length) {
      throw new TypeError(
        `point.indexBytes.${prefix} open-file metrics are partial`,
      );
    }
  }
  if (
    indexBytes.initialDatabaseBytes !== null &&
    indexBytes.initialWalBytes !== null &&
    indexBytes.initialShmBytes !== null &&
    indexBytes.initialOpenTotalBytes !==
      indexBytes.initialDatabaseBytes +
        indexBytes.initialWalBytes +
        indexBytes.initialShmBytes
  ) {
    throw new TypeError(
      "point.indexBytes.initialOpenTotalBytes is inconsistent",
    );
  }
  if (
    indexBytes.finalDatabaseBytes !== null &&
    indexBytes.finalWalBytes !== null &&
    indexBytes.finalShmBytes !== null &&
    indexBytes.finalOpenTotalBytes !==
      indexBytes.finalDatabaseBytes +
        indexBytes.finalWalBytes +
        indexBytes.finalShmBytes
  ) {
    throw new TypeError("point.indexBytes.finalOpenTotalBytes is inconsistent");
  }
}

function validateSummary(summary, label) {
  requireObject(summary, label);
  positiveSafeInteger(summary.sampleCount, `${label}.sampleCount`);
  if (
    !Array.isArray(summary.samplesMs) ||
    summary.samplesMs.length !== summary.sampleCount
  ) {
    throw new TypeError(`${label}.samplesMs does not match sampleCount`);
  }
  for (const sample of summary.samplesMs) finiteNonnegative(sample);
  for (const key of ["minMs", "maxMs", "p50Ms", "p95Ms"]) {
    finiteNonnegative(summary[key]);
  }
  const expected = summarizeFuzzySamples(summary.samplesMs);
  for (const key of ["minMs", "maxMs", "p50Ms", "p95Ms"]) {
    if (summary[key] !== expected[key]) {
      throw new TypeError(`${label}.${key} does not match samplesMs`);
    }
  }
}

function nearestRank(sorted, quantile) {
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)];
}

function finiteNonnegative(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(
      `expected a finite nonnegative number, received ${String(value)}`,
    );
  }
  return value;
}

function positiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
}

function nonnegativeSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a nonnegative safe integer`);
  }
}

function hexDigest(value, length, label) {
  if (
    typeof value !== "string" ||
    !new RegExp(`^[0-9a-f]{${length}}$`, "u").test(value)
  ) {
    throw new TypeError(
      `${label} must be ${length} lowercase hexadecimal characters`,
    );
  }
}

function nonemptyString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a nonempty string`);
  }
}

function requireObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}
