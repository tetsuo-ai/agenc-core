import { createHash } from "node:crypto";

export const BENCHMARK_SCHEMA_VERSION = 1;
export const BENCHMARK_SUITE_ID = "agenc.fnd.algorithm-baseline.v1";
export const BENCHMARK_ARTIFACT_KIND = "known-failure-observations";
export const BENCHMARK_PRODUCTION_TREE_PATH = "runtime/src";
export const MAX_WORKER_OUTPUT_BYTES = 1_048_576;
export const MAX_BASELINE_JSON_BYTES = 2_097_152;
export const MAX_BASELINE_MARKDOWN_BYTES = 262_144;
export const MAX_PRODUCTION_MODULES_PER_CASE = 512;
export const BENCHMARK_WORKER_COMPLETION_PREFIX = "AGENC_FND_BENCH_COMPLETE ";
export const BENCHMARK_EVIDENCE_PATHS = Object.freeze([
  ".gitattributes",
  "package-lock.json",
  "runtime/benchmarks/fnd/artifact-output.mjs",
  "runtime/benchmarks/fnd/bounded-file.mjs",
  "runtime/benchmarks/fnd/case-worker.mjs",
  "runtime/benchmarks/fnd/contract.mjs",
  "runtime/benchmarks/fnd/environment.mjs",
  "runtime/benchmarks/fnd/fixtures.mjs",
  "runtime/benchmarks/fnd/isolation.mjs",
  "runtime/benchmarks/fnd/metadata-command-worker.mjs",
  "runtime/benchmarks/fnd/module-closure.mjs",
  "runtime/benchmarks/fnd/provenance.mjs",
  "runtime/benchmarks/fnd/run-baselines.mjs",
  "runtime/benchmarks/fnd/supervisor.mjs",
  "runtime/native/agenc-process-broker.c",
  "runtime/native/agenc-process-job-broker.cs",
  "runtime/package.json",
]);

const KNOWN_FAILURE_ASSESSMENT = Object.freeze({
  classification: "known_failure_observation",
  gateEnforced: false,
  threshold: null,
});

export const BENCHMARK_PLAN = Object.freeze({
  schemaVersion: BENCHMARK_SCHEMA_VERSION,
  suiteId: BENCHMARK_SUITE_ID,
  cases: Object.freeze([
    Object.freeze({
      id: "csv_scheduler_progress_scan",
      family: "csv",
      implementation: "production_api",
      measurementKind: "end_to_end_microbenchmark",
      inputSeries: Object.freeze([
        Object.freeze({ rowCount: 1_000 }),
        Object.freeze({ rowCount: 2_000 }),
        Object.freeze({ rowCount: 4_000 }),
      ]),
      maxInput: Object.freeze({
        rowCount: 4_096,
        generatedUtf8Bytes: 524_288,
      }),
      warmups: 1,
      repetitions: 5,
      supervisorTrials: 1,
      timeoutMs: 45_000,
      expectedTermination: "completed",
      expectedOracleMatch: true,
      assessment: Object.freeze({
        ...KNOWN_FAILURE_ASSESSMENT,
        observation:
          "Array.shift queue movement and full progress-map scans have quadratic operation counts; the prior audit observed about 35/112/392 ms at 8k/16k/32k items.",
      }),
    }),
    Object.freeze({
      id: "patch_delete_parser_suffix_slicing",
      family: "patch",
      implementation: "production_api",
      measurementKind: "parser_microbenchmark",
      inputSeries: Object.freeze([
        Object.freeze({ hunkCount: 8_000 }),
        Object.freeze({ hunkCount: 16_000 }),
        Object.freeze({ hunkCount: 32_000 }),
      ]),
      maxInput: Object.freeze({
        hunkCount: 32_768,
        generatedUtf8Bytes: 2_097_152,
      }),
      warmups: 1,
      repetitions: 5,
      supervisorTrials: 1,
      timeoutMs: 45_000,
      expectedTermination: "completed",
      expectedOracleMatch: true,
      assessment: Object.freeze({
        ...KNOWN_FAILURE_ASSESSMENT,
        observation:
          "Delete-only parsing repeatedly slices the unconsumed suffix; the prior audit observed about 28 ms/238 ms/2.98 s at 16k/32k/64k lines.",
      }),
    }),
  ]),
});

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const GIT_REVISION_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const CASE_ID_PATTERN = /^[a-z0-9]+(?:_[a-z0-9]+)*$/u;

export function canonicalJson(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

export function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function benchmarkPlanDigest() {
  return sha256Hex(canonicalJson(BENCHMARK_PLAN));
}

export function summarizeSamples(samples) {
  if (!Array.isArray(samples) || samples.length === 0) {
    throw new Error("elapsed samples must be a non-empty array");
  }
  const values = samples.map((sample) => {
    if (!Number.isFinite(sample) || sample < 0) {
      throw new Error("elapsed samples must be finite non-negative numbers");
    }
    return sample;
  });
  const sorted = [...values].sort((left, right) => left - right);
  const medianMs = medianOfSorted(sorted);
  const deviations = sorted
    .map((sample) => Math.abs(sample - medianMs))
    .sort((left, right) => left - right);
  return {
    sampleCount: values.length,
    samplesMs: values.map(roundMetric),
    medianMs: roundMetric(medianMs),
    madMs: roundMetric(medianOfSorted(deviations)),
    minMs: roundMetric(sorted[0]),
    maxMs: roundMetric(sorted[sorted.length - 1]),
  };
}

export function normalizeResourceUsageMaxRssBytes(maxRssKibibytes) {
  if (!Number.isSafeInteger(maxRssKibibytes) || maxRssKibibytes <= 0) {
    throw new Error(
      "process.resourceUsage().maxRSS must be a positive integer in KiB",
    );
  }
  const bytes = maxRssKibibytes * 1_024;
  if (!Number.isSafeInteger(bytes)) {
    throw new Error(
      "normalized process peak RSS exceeds the safe integer range",
    );
  }
  return bytes;
}

export function validateBenchmarkReport(report) {
  requireRecord(report, "report");
  requireExactKeys(
    report,
    [
      "artifactKind",
      "cases",
      "environment",
      "evidenceBindings",
      "planDigest",
      "productionModuleClosures",
      "productionTreeBinding",
      "schemaVersion",
      "sourceRevision",
      "suiteId",
    ],
    "report",
  );
  requireEqual(
    report.schemaVersion,
    BENCHMARK_SCHEMA_VERSION,
    "report.schemaVersion",
  );
  requireEqual(report.suiteId, BENCHMARK_SUITE_ID, "report.suiteId");
  requireEqual(
    report.artifactKind,
    BENCHMARK_ARTIFACT_KIND,
    "report.artifactKind",
  );
  requireEqual(report.planDigest, benchmarkPlanDigest(), "report.planDigest");
  requireGitRevision(report.sourceRevision, "report.sourceRevision");
  validateProductionTreeBinding(report.productionTreeBinding);
  validateProductionModuleClosures(report.productionModuleClosures);
  validateEnvironment(report.environment);
  validateEvidenceBindings(report.evidenceBindings);
  if (!Array.isArray(report.cases)) {
    throw new Error("report.cases must be an array");
  }
  requireEqual(
    report.cases.length,
    BENCHMARK_PLAN.cases.length,
    "report.cases.length",
  );
  BENCHMARK_PLAN.cases.forEach((definition, index) => {
    validateCaseReport(report.cases[index], definition, index);
  });
  return report;
}

export function renderBaselineMarkdown(report, jsonDigest) {
  validateBenchmarkReport(report);
  requireSha(jsonDigest, "jsonDigest");
  const lines = [
    "# FND algorithm baseline v1",
    "",
    "This artifact records bounded observations of known failures. Every row is",
    "informational: no current result is a passing performance threshold or gate.",
    "Generated inputs are synthetic and created only for the benchmark process.",
    "",
    `- JSON SHA-256: \`${jsonDigest}\``,
    `- Source revision: \`${report.sourceRevision}\``,
    `- Production tree: \`${report.productionTreeBinding.path}\` at Git object \`${report.productionTreeBinding.gitObjectId}\``,
    `- Loaded production closure: \`${report.productionModuleClosures.reduce((count, closure) => count + closure.modules.length, 0)}\` module bindings across \`${report.productionModuleClosures.length}\` cases`,
    `- Plan SHA-256: \`${report.planDigest}\``,
    `- Node/npm: \`${report.environment.runtime.node}\` / \`${report.environment.runtime.npm}\``,
    `- OS/CPU: \`${report.environment.os.platform} ${report.environment.os.release} ${report.environment.os.arch}\` / \`${report.environment.cpu.model}\` (${report.environment.cpu.logicalCount} logical)`,
    `- RAM: \`${report.environment.memory.totalBytes}\` bytes`,
    `- Source filesystem: type \`${report.environment.filesystems.sourceCheckout.type}\`, block \`${report.environment.filesystems.sourceCheckout.blockSizeBytes}\` bytes`,
    `- Fixture filesystem: type \`${report.environment.filesystems.temporaryFixtures.type}\`, block \`${report.environment.filesystems.temporaryFixtures.blockSizeBytes}\` bytes`,
    `- SQLite/ripgrep: \`${report.environment.sqlite.version}\` / \`${report.environment.ripgrep.version}\``,
    "",
    "| Case | Input | Status | Median ms | MAD ms | Worker peak RSS bytes | RSS lower-bound bytes |",
    "| --- | ---: | --- | ---: | ---: | ---: | ---: |",
  ];
  for (const benchmarkCase of report.cases) {
    for (const point of benchmarkCase.points) {
      lines.push(
        `| \`${benchmarkCase.id}\` | \`${compactInput(point.input)}\` | \`${point.status}\` | ${formatMetric(point.elapsed.medianMs)} | ${formatMetric(point.elapsed.madMs)} | ${formatOptionalInteger(point.memory.peakRssBytes)} | ${point.memory.lowerBound.maximumObservedBytes} |`,
      );
    }
  }
  lines.push("", "## Known-failure policy", "");
  for (const benchmarkCase of report.cases) {
    lines.push(
      `- \`${benchmarkCase.id}\`: ${benchmarkCase.assessment.observation}`,
    );
  }
  lines.push(
    "",
    "## Reproduce",
    "",
    "Run on the same pinned runtime and machine state; compare medians, MAD,",
    "operation counts, and relative scaling rather than one wall-clock sample.",
    "",
    "```sh",
    `npm run benchmark:fnd-baseline --workspace=@tetsuo-ai/runtime -- --source-revision ${report.sourceRevision} --output /tmp/agenc-fnd-baseline.v1.json --markdown-output /tmp/agenc-fnd-baseline.v1.md`,
    "npm run check:fnd-benchmark-baseline --workspace=@tetsuo-ai/runtime",
    "```",
    "",
    "Completed workers report their actual process high-water RSS from",
    "`process.resourceUsage().maxRSS`, normalized from KiB to bytes. A worker",
    "terminated during synchronous work cannot emit that final high-water mark,",
    "so its peak is `n/a`; its last start RSS remains a clearly labeled lower",
    "bound. Endpoint observations are retained as diagnostics and are never",
    "presented as the worker peak.",
    "",
  );
  return lines.join("\n");
}

function validateCaseReport(value, definition, index) {
  const label = `report.cases[${index}]`;
  requireRecord(value, label);
  requireExactKeys(
    value,
    [
      "assessment",
      "family",
      "id",
      "implementation",
      "measurementKind",
      "points",
    ],
    label,
  );
  for (const key of ["id", "family", "implementation", "measurementKind"]) {
    requireEqual(value[key], definition[key], `${label}.${key}`);
  }
  requireRecord(value.assessment, `${label}.assessment`);
  requireExactKeys(
    value.assessment,
    ["classification", "gateEnforced", "observation", "threshold"],
    `${label}.assessment`,
  );
  requireEqual(
    value.assessment.classification,
    "known_failure_observation",
    `${label}.assessment.classification`,
  );
  requireEqual(
    value.assessment.gateEnforced,
    false,
    `${label}.assessment.gateEnforced`,
  );
  requireEqual(
    value.assessment.threshold,
    null,
    `${label}.assessment.threshold`,
  );
  requireEqual(
    value.assessment.observation,
    definition.assessment.observation,
    `${label}.assessment.observation`,
  );
  if (!Array.isArray(value.points)) {
    throw new Error(`${label}.points must be an array`);
  }
  requireEqual(
    value.points.length,
    definition.inputSeries.length,
    `${label}.points.length`,
  );
  definition.inputSeries.forEach((expectedInput, pointIndex) => {
    validatePoint(
      value.points[pointIndex],
      definition,
      expectedInput,
      `${label}.points[${pointIndex}]`,
    );
  });
}

function validatePoint(value, definition, expectedInput, label) {
  requireRecord(value, label);
  requireExactKeys(
    value,
    [
      "correctness",
      "elapsed",
      "fixtureDigest",
      "input",
      "memory",
      "operations",
      "status",
    ],
    label,
  );
  requireRecord(value.input, `${label}.input`);
  for (const [key, expected] of Object.entries(expectedInput)) {
    requireEqual(value.input[key], expected, `${label}.input.${key}`);
  }
  requireBoundedInteger(
    value.input.generatedUtf8Bytes,
    0,
    definition.maxInput.generatedUtf8Bytes,
    `${label}.input.generatedUtf8Bytes`,
  );
  for (const [key, maximum] of Object.entries(definition.maxInput)) {
    if (key === "generatedUtf8Bytes") continue;
    if (value.input[key] !== undefined) {
      requireBoundedInteger(
        value.input[key],
        0,
        maximum,
        `${label}.input.${key}`,
      );
    }
  }
  requireSha(value.fixtureDigest, `${label}.fixtureDigest`);
  requireEqual(value.status, definition.expectedTermination, `${label}.status`);
  validateElapsed(value.elapsed, definition, label);
  validateMemory(value.memory, definition, `${label}.memory`);
  validateOperations(value.operations, `${label}.operations`);
  validateCorrectness(value.correctness, definition, `${label}.correctness`);
}

function validateElapsed(value, definition, pointLabel) {
  const label = `${pointLabel}.elapsed`;
  requireRecord(value, label);
  requireExactKeys(
    value,
    [
      "clock",
      "madMs",
      "maxMs",
      "medianMs",
      "minMs",
      "sampleCount",
      "samplesMs",
    ],
    label,
  );
  requireEqual(value.clock, "performance.now", `${label}.clock`);
  const expectedCount =
    definition.expectedTermination === "timed_out"
      ? definition.supervisorTrials
      : definition.repetitions;
  requireEqual(value.sampleCount, expectedCount, `${label}.sampleCount`);
  if (!Array.isArray(value.samplesMs)) {
    throw new Error(`${label}.samplesMs must be an array`);
  }
  const summary = summarizeSamples(value.samplesMs);
  for (const key of ["sampleCount", "medianMs", "madMs", "minMs", "maxMs"]) {
    requireEqual(value[key], summary[key], `${label}.${key}`);
  }
}

function validateMemory(value, definition, label) {
  requireRecord(value, label);
  requireExactKeys(
    value,
    ["lowerBound", "peakRssBytes", "peakRssMethod"],
    label,
  );
  const completed = definition.expectedTermination === "completed";
  requireEqual(
    value.peakRssMethod,
    completed
      ? "process.resourceUsage.maxRSS_kib_to_bytes"
      : "unavailable_after_forced_termination",
    `${label}.peakRssMethod`,
  );
  if (completed) {
    requireBoundedInteger(
      value.peakRssBytes,
      1,
      Number.MAX_SAFE_INTEGER,
      `${label}.peakRssBytes`,
    );
  } else {
    requireEqual(value.peakRssBytes, null, `${label}.peakRssBytes`);
  }

  const lowerBound = value.lowerBound;
  requireRecord(lowerBound, `${label}.lowerBound`);
  requireExactKeys(
    lowerBound,
    ["limitation", "maximumObservedBytes", "method", "observationsBytes"],
    `${label}.lowerBound`,
  );
  if (
    lowerBound.method !== "endpoint_rss_lower_bound" &&
    lowerBound.method !== "child_start_rss_lower_bound"
  ) {
    throw new Error(`${label}.lowerBound.method is unsupported`);
  }
  requireEqual(
    lowerBound.method,
    completed ? "endpoint_rss_lower_bound" : "child_start_rss_lower_bound",
    `${label}.lowerBound.method`,
  );
  if (
    typeof lowerBound.limitation !== "string" ||
    lowerBound.limitation.length === 0
  ) {
    throw new Error(`${label}.lowerBound.limitation must be non-empty`);
  }
  if (
    !Array.isArray(lowerBound.observationsBytes) ||
    lowerBound.observationsBytes.length === 0
  ) {
    throw new Error(
      `${label}.lowerBound.observationsBytes must be a non-empty array`,
    );
  }
  for (const [index, observation] of lowerBound.observationsBytes.entries()) {
    requireBoundedInteger(
      observation,
      1,
      Number.MAX_SAFE_INTEGER,
      `${label}.lowerBound.observationsBytes[${index}]`,
    );
  }
  requireEqual(
    lowerBound.maximumObservedBytes,
    Math.max(...lowerBound.observationsBytes),
    `${label}.lowerBound.maximumObservedBytes`,
  );
}

function validateProductionTreeBinding(value) {
  requireRecord(value, "report.productionTreeBinding");
  requireExactKeys(
    value,
    ["gitObjectId", "objectType", "path"],
    "report.productionTreeBinding",
  );
  requireEqual(
    value.path,
    BENCHMARK_PRODUCTION_TREE_PATH,
    "report.productionTreeBinding.path",
  );
  requireEqual(
    value.objectType,
    "tree",
    "report.productionTreeBinding.objectType",
  );
  requireGitRevision(
    value.gitObjectId,
    "report.productionTreeBinding.gitObjectId",
  );
}

function validateOperations(value, label) {
  requireRecord(value, label);
  const entries = Object.entries(value);
  if (entries.length === 0) throw new Error(`${label} must not be empty`);
  for (const [key, count] of entries) {
    if (!CASE_ID_PATTERN.test(key)) {
      throw new Error(`${label}.${key} is not a stable operation name`);
    }
    requireBoundedInteger(count, 0, Number.MAX_SAFE_INTEGER, `${label}.${key}`);
  }
}

function validateCorrectness(value, definition, label) {
  requireRecord(value, label);
  requireExactKeys(
    value,
    ["expected", "matchesOracle", "observed", "oracle"],
    label,
  );
  for (const key of ["expected", "observed", "oracle"]) {
    if (typeof value[key] !== "string" || value[key].length === 0) {
      throw new Error(`${label}.${key} must be a non-empty string`);
    }
  }
  requireEqual(
    value.matchesOracle,
    definition.expectedOracleMatch,
    `${label}.matchesOracle`,
  );
}

function validateEnvironment(value) {
  requireRecord(value, "report.environment");
  requireExactKeys(
    value,
    ["cpu", "filesystems", "memory", "os", "ripgrep", "runtime", "sqlite"],
    "report.environment",
  );
  requireRecord(value.cpu, "report.environment.cpu");
  requireExactKeys(
    value.cpu,
    ["logicalCount", "model"],
    "report.environment.cpu",
  );
  requireBoundedInteger(
    value.cpu.logicalCount,
    1,
    65_536,
    "report.environment.cpu.logicalCount",
  );
  requireNonEmptyString(value.cpu.model, "report.environment.cpu.model");

  requireRecord(value.filesystems, "report.environment.filesystems");
  requireExactKeys(
    value.filesystems,
    ["sourceCheckout", "temporaryFixtures"],
    "report.environment.filesystems",
  );
  for (const filesystemName of ["sourceCheckout", "temporaryFixtures"]) {
    const filesystem = value.filesystems[filesystemName];
    const label = `report.environment.filesystems.${filesystemName}`;
    requireRecord(filesystem, label);
    requireExactKeys(filesystem, ["blockSizeBytes", "type"], label);
    requireBoundedInteger(
      filesystem.blockSizeBytes,
      1,
      Number.MAX_SAFE_INTEGER,
      `${label}.blockSizeBytes`,
    );
    requireNonEmptyString(filesystem.type, `${label}.type`);
  }

  requireRecord(value.memory, "report.environment.memory");
  requireExactKeys(value.memory, ["totalBytes"], "report.environment.memory");
  requireBoundedInteger(
    value.memory.totalBytes,
    1,
    Number.MAX_SAFE_INTEGER,
    "report.environment.memory.totalBytes",
  );

  requireRecord(value.os, "report.environment.os");
  requireExactKeys(
    value.os,
    ["arch", "platform", "release"],
    "report.environment.os",
  );
  for (const key of ["arch", "platform", "release"]) {
    requireNonEmptyString(value.os[key], `report.environment.os.${key}`);
  }

  requireRecord(value.runtime, "report.environment.runtime");
  requireExactKeys(
    value.runtime,
    ["node", "npm", "v8"],
    "report.environment.runtime",
  );
  for (const key of ["node", "npm", "v8"]) {
    requireNonEmptyString(
      value.runtime[key],
      `report.environment.runtime.${key}`,
    );
  }

  requireRecord(value.sqlite, "report.environment.sqlite");
  requireExactKeys(
    value.sqlite,
    ["compileOptions", "version"],
    "report.environment.sqlite",
  );
  requireNonEmptyString(
    value.sqlite.version,
    "report.environment.sqlite.version",
  );
  if (!Array.isArray(value.sqlite.compileOptions)) {
    throw new Error(
      "report.environment.sqlite.compileOptions must be an array",
    );
  }
  for (const [index, option] of value.sqlite.compileOptions.entries()) {
    requireNonEmptyString(
      option,
      `report.environment.sqlite.compileOptions[${index}]`,
    );
  }
  const sortedOptions = [...value.sqlite.compileOptions].sort();
  requireEqual(
    JSON.stringify(value.sqlite.compileOptions),
    JSON.stringify(sortedOptions),
    "report.environment.sqlite.compileOptions order",
  );

  requireRecord(value.ripgrep, "report.environment.ripgrep");
  requireExactKeys(
    value.ripgrep,
    ["distribution", "version"],
    "report.environment.ripgrep",
  );
  requireEqual(
    value.ripgrep.distribution,
    "pinned_package",
    "report.environment.ripgrep.distribution",
  );
  requireNonEmptyString(
    value.ripgrep.version,
    "report.environment.ripgrep.version",
  );
}

function validateProductionModuleClosures(value) {
  if (!Array.isArray(value)) {
    throw new Error("report.productionModuleClosures must be an array");
  }
  requireEqual(
    value.length,
    BENCHMARK_PLAN.cases.length,
    "report.productionModuleClosures.length",
  );
  BENCHMARK_PLAN.cases.forEach((definition, closureIndex) => {
    const closure = value[closureIndex];
    const closureLabel = `report.productionModuleClosures[${closureIndex}]`;
    requireRecord(closure, closureLabel);
    requireExactKeys(closure, ["caseId", "modules"], closureLabel);
    requireEqual(closure.caseId, definition.id, `${closureLabel}.caseId`);
    if (!Array.isArray(closure.modules) || closure.modules.length === 0) {
      throw new Error(`${closureLabel}.modules must be a non-empty array`);
    }
    if (closure.modules.length > MAX_PRODUCTION_MODULES_PER_CASE) {
      throw new Error(`${closureLabel}.modules exceeds its named bound`);
    }
    const paths = [];
    closure.modules.forEach((binding, bindingIndex) => {
      const bindingLabel = `${closureLabel}.modules[${bindingIndex}]`;
      requireRecord(binding, bindingLabel);
      requireExactKeys(binding, ["path", "sha256"], bindingLabel);
      requireProductionModulePath(binding.path, `${bindingLabel}.path`);
      requireSha(binding.sha256, `${bindingLabel}.sha256`);
      paths.push(binding.path);
    });
    requireEqual(
      JSON.stringify(paths),
      JSON.stringify([...new Set(paths)].sort()),
      `${closureLabel}.modules path order`,
    );
  });
}

function requireProductionModulePath(value, label) {
  if (
    typeof value !== "string" ||
    !value.startsWith(`${BENCHMARK_PRODUCTION_TREE_PATH}/`) ||
    value.includes("\\") ||
    value
      .split("/")
      .some(
        (segment) =>
          segment.length === 0 || segment === "." || segment === "..",
      )
  ) {
    throw new Error(`${label} must stay inside the production tree`);
  }
}

function validateEvidenceBindings(value) {
  if (!Array.isArray(value)) {
    throw new Error("report.evidenceBindings must be an array");
  }
  requireEqual(
    value.length,
    BENCHMARK_EVIDENCE_PATHS.length,
    "report.evidenceBindings.length",
  );
  BENCHMARK_EVIDENCE_PATHS.forEach((expectedPath, index) => {
    const binding = value[index];
    const label = `report.evidenceBindings[${index}]`;
    requireRecord(binding, label);
    requireExactKeys(binding, ["normalization", "path", "sha256"], label);
    requireEqual(binding.path, expectedPath, `${label}.path`);
    requireEqual(binding.normalization, "utf8_lf", `${label}.normalization`);
    requireSha(binding.sha256, `${label}.sha256`);
  });
}

function canonicalize(value) {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new Error("canonical JSON rejects non-finite numbers");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  requireRecord(value, "canonical JSON value");
  const output = {};
  for (const key of Object.keys(value).sort()) {
    const child = value[key];
    if (child === undefined)
      throw new Error("canonical JSON rejects undefined values");
    output[key] = canonicalize(child);
  }
  return output;
}

function medianOfSorted(sorted) {
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function roundMetric(value) {
  return Number(value.toFixed(6));
}

function compactInput(input) {
  return Object.entries(input)
    .filter(([key]) => key !== "generatedUtf8Bytes")
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join(",");
}

function formatMetric(value) {
  return Number(value).toFixed(3);
}

function formatOptionalInteger(value) {
  return value === null ? "n/a" : String(value);
}

function requireRecord(value, label) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error(`${label} must be a plain object`);
  }
}

function requireExactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(sortedExpected)) {
    throw new Error(
      `${label} keys differ: expected ${sortedExpected.join(",")}; received ${actual.join(",")}`,
    );
  }
}

function requireEqual(actual, expected, label) {
  if (!Object.is(actual, expected)) {
    throw new Error(`${label} must equal ${JSON.stringify(expected)}`);
  }
}

function requireSha(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
}

function requireGitRevision(value, label) {
  if (typeof value !== "string" || !GIT_REVISION_PATTERN.test(value)) {
    throw new Error(`${label} must be a full Git object ID`);
  }
}

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function requireBoundedInteger(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer in [${minimum}, ${maximum}]`);
  }
}
