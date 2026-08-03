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
  const sorted = samples.map(finiteNonnegative).sort((left, right) => left - right);
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
    throw new TypeError(`invalid fuzzy benchmark status ${String(point.status)}`);
  }
  positiveSafeInteger(point.corpus?.size, "point.corpus.size");
  hexDigest(point.corpus?.digest, 64, "point.corpus.digest");
  nonemptyString(point.corpus?.generatorVersion, "point.corpus.generatorVersion");
  nonnegativeSafeInteger(point.corpus?.pathBytes, "point.corpus.pathBytes");
  const expectedBuildKind =
    point.mode === "matcher_only" ? "prepared_candidates" : "persistent_generation";
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
    throw new TypeError("logical index bytes must equal generated corpus path bytes");
  }

  if (point.query !== null) {
    requireObject(point.query, "point.query");
    validateSummary(point.query.cold, "point.query.cold");
    validateSummary(point.query.warm, "point.query.warm");
  } else if (point.status === "completed") {
    throw new TypeError("completed fuzzy benchmark point requires query metrics");
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
      point.invalidation.generationAfter <= point.invalidation.generationBefore
    ) {
      throw new TypeError("invalidation must publish a newer generation");
    }
    positiveSafeInteger(
      point.invalidation.pollIntervalMs,
      "point.invalidation.pollIntervalMs",
    );
    if (point.invalidation.sentinelVisible !== true) {
      throw new TypeError("invalidation must observe the changed sentinel");
    }
    positiveSafeInteger(
      point.invalidation.discoveryCalls,
      "point.invalidation.discoveryCalls",
    );
    nonemptyString(point.invalidation.path, "point.invalidation.path");
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
      if (!Number.isSafeInteger(point.indexBytes[key]) || point.indexBytes[key] <= 0) {
        throw new TypeError(`completed end-to-end point requires positive ${key}`);
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
    throw new TypeError("completed end-to-end point requires invalidation metrics");
  }
  if (point.status === "completed" && point.error !== null) {
    throw new TypeError("completed fuzzy benchmark point cannot report an error");
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

  const expectedSizes = options.quick === true ? QUICK_CORPUS_SIZES : FULL_CORPUS_SIZES;
  const expected = new Set(
    FUZZY_BENCHMARK_MODES.flatMap((mode) =>
      expectedSizes.map((size) => `${mode}:${size}`),
    ),
  );
  const actualKeys = report.points.map((point) => `${point.mode}:${point.corpus.size}`);
  const actual = new Set(actualKeys);
  if (
    actualKeys.length !== expected.size ||
    actual.size !== actualKeys.length ||
    [...expected].some((key) => !actual.has(key))
  ) {
    throw new TypeError("fuzzy benchmark report does not contain the exact plan");
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
    nonemptyString(filesystem.type, `report.environment.filesystems.${name}.type`);
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
    throw new TypeError("fuzzy benchmark report requires the pinned Node/npm toolchain");
  }
  nonemptyString(environment.runtime.v8, "report.environment.runtime.v8");

  requireObject(environment.sqlite, "report.environment.sqlite");
  nonemptyString(environment.sqlite.version, "report.environment.sqlite.version");
  if (
    !Array.isArray(environment.sqlite.compileOptions) ||
    environment.sqlite.compileOptions.length === 0 ||
    environment.sqlite.compileOptions.length > 4_096
  ) {
    throw new TypeError("report.environment.sqlite.compileOptions is not bounded");
  }
  for (const option of environment.sqlite.compileOptions) {
    nonemptyString(option, "report.environment.sqlite.compileOptions[]");
  }
  const sortedOptions = [...environment.sqlite.compileOptions].sort();
  if (JSON.stringify(sortedOptions) !== JSON.stringify(environment.sqlite.compileOptions)) {
    throw new TypeError("report.environment.sqlite.compileOptions must be sorted");
  }

  requireObject(environment.ripgrep, "report.environment.ripgrep");
  if (environment.ripgrep.distribution !== "pinned_package") {
    throw new TypeError("report.environment.ripgrep must use the pinned package");
  }
  nonemptyString(environment.ripgrep.version, "report.environment.ripgrep.version");
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
  if (endpoints.some((value) => value === null) || memory.peakRssBytes === null) {
    throw new TypeError("memory observations must be either complete or unavailable");
  }
  if (memory.peakRssBytes < Math.max(...endpoints)) {
    throw new TypeError("point.memory.peakRssBytes is below an endpoint observation");
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
  positiveSafeInteger(indexBytes.logicalPathBytes, "point.indexBytes.logicalPathBytes");
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
      throw new TypeError(`point.indexBytes.${prefix} open-file metrics are partial`);
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
    throw new TypeError("point.indexBytes.initialOpenTotalBytes is inconsistent");
  }
  if (
    indexBytes.finalDatabaseBytes !== null &&
    indexBytes.finalWalBytes !== null &&
    indexBytes.finalShmBytes !== null &&
    indexBytes.finalOpenTotalBytes !==
      indexBytes.finalDatabaseBytes + indexBytes.finalWalBytes + indexBytes.finalShmBytes
  ) {
    throw new TypeError("point.indexBytes.finalOpenTotalBytes is inconsistent");
  }
}

function validateSummary(summary, label) {
  requireObject(summary, label);
  positiveSafeInteger(summary.sampleCount, `${label}.sampleCount`);
  if (!Array.isArray(summary.samplesMs) || summary.samplesMs.length !== summary.sampleCount) {
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
    throw new TypeError(`expected a finite nonnegative number, received ${String(value)}`);
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
    throw new TypeError(`${label} must be ${length} lowercase hexadecimal characters`);
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
