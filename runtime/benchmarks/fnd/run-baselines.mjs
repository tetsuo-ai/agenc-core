#!/usr/bin/env node

import { cpus, release, tmpdir, totalmem } from "node:os";
import { randomBytes } from "node:crypto";
import { statfsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { rgPath } from "@vscode/ripgrep";

import { publishBenchmarkArtifacts } from "./artifact-output.mjs";
import { readBoundedRegularFile } from "./bounded-file.mjs";

import {
  BENCHMARK_ARTIFACT_KIND,
  BENCHMARK_EVIDENCE_PATHS,
  BENCHMARK_PLAN,
  BENCHMARK_PRODUCTION_TREE_PATH,
  BENCHMARK_SCHEMA_VERSION,
  BENCHMARK_SUITE_ID,
  BENCHMARK_WORKER_COMPLETION_PREFIX,
  MAX_BASELINE_JSON_BYTES,
  MAX_BASELINE_MARKDOWN_BYTES,
  MAX_PRODUCTION_MODULES_PER_CASE,
  MAX_WORKER_OUTPUT_BYTES,
  benchmarkPlanDigest,
  canonicalJson,
  renderBaselineMarkdown,
  sha256Hex,
  summarizeSamples,
  validateBenchmarkReport,
} from "./contract.mjs";
import {
  assertNoBenchmarkExecArguments,
  assertNoUnsafeBenchmarkEnvironment,
  createBenchmarkWorkerEnvironment,
} from "./environment.mjs";
import { describeFixture } from "./fixtures.mjs";
import { withOwnedTemporaryRoot } from "./isolation.mjs";
import {
  PRODUCTION_MODULE_RECORD_PREFIX,
  registerProductionModuleTracker,
} from "./module-closure.mjs";
import {
  bindProductionModuleClosures,
  captureBenchmarkProvenance,
  resolveBenchmarkNpmCliPath,
  runBoundedCommandText,
  verifyBenchmarkCapture,
  verifyCheckedBenchmarkProvenance,
} from "./provenance.mjs";
import { runBoundedChild } from "./supervisor.mjs";

const benchmarkRoot = dirname(fileURLToPath(import.meta.url));
const runtimeRoot = resolve(benchmarkRoot, "../..");
const repositoryRoot = resolve(runtimeRoot, "..");
const workerPath = join(benchmarkRoot, "case-worker.mjs");
const baselineJsonPath = join(benchmarkRoot, "baseline.v1.json");
const baselineMarkdownPath = join(benchmarkRoot, "baseline.v1.md");
const START_PREFIX = "AGENC_FND_BENCH_START ";
const RSS_TIMEOUT_LIMITATION =
  "The child reported RSS immediately before entering synchronous work and was then externally terminated; this is a lower-bound diagnostic, not a process peak.";

assertNoBenchmarkExecArguments(process.execArgv);
assertNoUnsafeBenchmarkEnvironment(process.env);
const options = parseArguments(process.argv.slice(2));

if (options.mode === "plan") {
  const plan = canonicalJson({
    fixtures: BENCHMARK_PLAN.cases.flatMap((definition) =>
      definition.inputSeries.map((_, pointIndex) =>
        describeFixture(definition.id, pointIndex),
      ),
    ),
    plan: BENCHMARK_PLAN,
    planDigest: benchmarkPlanDigest(),
  });
  assertSerializedArtifactWithinBounds(
    plan,
    MAX_BASELINE_JSON_BYTES,
    "benchmark plan",
  );
  process.stdout.write(plan);
} else if (options.mode === "check") {
  checkBaseline();
  process.stdout.write("FND benchmark baseline contract is valid.\n");
} else {
  const report = await runSuite();
  validateBenchmarkReport(report);
  const json = canonicalJson(report);
  const digest = sha256Hex(json);
  const markdown = renderBaselineMarkdown(report, digest);
  assertSerializedArtifactWithinBounds(
    json,
    MAX_BASELINE_JSON_BYTES,
    "baseline JSON",
  );
  assertSerializedArtifactWithinBounds(
    markdown,
    MAX_BASELINE_MARKDOWN_BYTES,
    "baseline Markdown",
  );
  publishBenchmarkArtifacts({
    json,
    jsonPath: options.outputPath,
    markdown,
    markdownPath: options.markdownOutputPath,
  });
  process.stdout.write(
    `${JSON.stringify({
      jsonSha256: digest,
      markdownOutput: options.markdownOutputPath,
      output: options.outputPath,
    })}\n`,
  );
}

async function runSuite() {
  const provenance = captureBenchmarkProvenance({
    evidencePaths: BENCHMARK_EVIDENCE_PATHS,
    productionTreePath: BENCHMARK_PRODUCTION_TREE_PATH,
    repositoryRoot,
    sourceRevision: options.sourceRevision,
  });
  const parentModuleTracker = registerProductionModuleTracker({
    productionRoot: join(runtimeRoot, "src"),
    repositoryRoot,
    writeRecord() {},
  });
  const cases = [];
  const observedModuleClosures = [];
  try {
    for (const definition of BENCHMARK_PLAN.cases) {
      process.stderr.write(`benchmark ${definition.id}\n`);
      const points = [];
      const productionModulePaths = new Set();
      for (
        let pointIndex = 0;
        pointIndex < definition.inputSeries.length;
        pointIndex += 1
      ) {
        const observation = await runPoint(definition, pointIndex);
        points.push(observation.point);
        for (const path of observation.productionModulePaths) {
          productionModulePaths.add(path);
        }
      }
      cases.push({
        assessment: definition.assessment,
        family: definition.family,
        id: definition.id,
        implementation: definition.implementation,
        measurementKind: definition.measurementKind,
        points,
      });
      observedModuleClosures.push({
        caseId: definition.id,
        paths: [...productionModulePaths].sort(),
      });
    }
  } finally {
    await parentModuleTracker.close();
  }

  const parentModulePaths = parentModuleTracker.paths();
  for (const closure of observedModuleClosures) {
    closure.paths = [
      ...new Set([...closure.paths, ...parentModulePaths]),
    ].sort();
  }

  const environment = collectEnvironment();
  verifyBenchmarkCapture(provenance);
  const productionModuleClosures = bindProductionModuleClosures(
    provenance,
    observedModuleClosures,
  );
  verifyBenchmarkCapture(provenance);
  return {
    artifactKind: BENCHMARK_ARTIFACT_KIND,
    cases,
    environment,
    evidenceBindings: provenance.evidenceBindings,
    planDigest: benchmarkPlanDigest(),
    productionModuleClosures,
    productionTreeBinding: provenance.productionTreeBinding,
    schemaVersion: BENCHMARK_SCHEMA_VERSION,
    sourceRevision: provenance.sourceRevision,
    suiteId: BENCHMARK_SUITE_ID,
  };
}

async function runPoint(definition, pointIndex) {
  if (definition.expectedTermination === "timed_out") {
    const trials = [];
    for (let trial = 0; trial < definition.supervisorTrials; trial += 1) {
      trials.push(await runWorker(definition, pointIndex));
    }
    const expectedFixture = describeFixture(definition.id, pointIndex);
    for (const trial of trials) {
      if (!trial.timedOut) {
        throw new Error(
          `${definition.id} completed instead of reproducing its known timeout; review and refresh the baseline policy`,
        );
      }
      validateStartMessage(trial.startMessage, expectedFixture, definition.id);
    }
    const rssObservationsBytes = trials.map(
      (trial) => trial.startMessage.rssBytes,
    );
    return {
      point: {
        correctness: {
          expected: "fallback completes without blocking its owner event loop",
          matchesOracle: false,
          observed: `externally terminated after ${definition.timeoutMs} ms`,
          oracle: "externally supervised responsiveness oracle",
        },
        elapsed: {
          clock: "performance.now",
          ...summarizeSamples(trials.map((trial) => trial.elapsedMs)),
        },
        fixtureDigest: expectedFixture.fixtureDigest,
        input: expectedFixture.descriptor.input,
        memory: {
          lowerBound: {
            limitation: RSS_TIMEOUT_LIMITATION,
            maximumObservedBytes: Math.max(...rssObservationsBytes),
            method: "child_start_rss_lower_bound",
            observationsBytes: rssObservationsBytes,
          },
          peakRssBytes: null,
          peakRssMethod: "unavailable_after_forced_termination",
        },
        operations: expectedFixture.operations,
        status: "timed_out",
      },
      productionModulePaths: mergeProductionModulePaths(trials),
    };
  }

  const trial = await runWorker(definition, pointIndex);
  if (trial.timedOut) {
    throw new Error(
      `${definition.id} point ${pointIndex} exceeded its ${definition.timeoutMs} ms supervisor bound`,
    );
  }
  if (trial.exitCode !== 0) {
    throw new Error(
      `${definition.id} point ${pointIndex} failed with exit ${trial.exitCode}: ${trimDiagnostic(trial.stderr)}`,
    );
  }
  const expectedFixture = describeFixture(definition.id, pointIndex);
  validateStartMessage(trial.startMessage, expectedFixture, definition.id);
  let result;
  try {
    result = JSON.parse(trial.stdout);
  } catch (error) {
    throw new Error(
      `${definition.id} returned invalid worker JSON: ${trimDiagnostic(trial.stdout)}`,
      { cause: error },
    );
  }
  if (
    canonicalJson(result.input) !==
      canonicalJson(expectedFixture.descriptor.input) ||
    result.fixtureDigest !== expectedFixture.fixtureDigest ||
    canonicalJson(result.operations) !==
      canonicalJson(expectedFixture.operations)
  ) {
    throw new Error(
      `${definition.id} worker result diverged from its fixture plan`,
    );
  }
  return {
    point: result,
    productionModulePaths: trial.productionModulePaths,
  };
}

function runWorker(definition, pointIndex) {
  return withOwnedTemporaryRoot(async (temporaryRoot) => {
    const completionNonce = randomBytes(32).toString("hex");
    const expectedCompletionRecord = `${BENCHMARK_WORKER_COMPLETION_PREFIX}${completionNonce}`;
    const trial = await runBoundedChild({
      args: [
        workerPath,
        "--case",
        definition.id,
        "--point",
        String(pointIndex),
        "--temporary-root",
        temporaryRoot,
        "--completion-nonce",
        completionNonce,
      ],
      command: process.execPath,
      cwd: repositoryRoot,
      env: createBenchmarkWorkerEnvironment(
        process.env,
        process.platform,
        temporaryRoot,
      ),
      expectedCompletionRecord,
      maxOutputBytes: MAX_WORKER_OUTPUT_BYTES,
      timeoutMs: definition.timeoutMs,
    });
    const startMessage = parseStartMessage(trial.stderr);
    if (startMessage === undefined) {
      throw new Error(
        `${definition.id} did not emit a start record: ${trimDiagnostic(trial.stderr)}`,
      );
    }
    return {
      ...trial,
      productionModulePaths: parseProductionModulePaths(trial.stderr),
      startMessage,
      stdout: trial.stdout.trim(),
    };
  });
}

function checkBaseline() {
  const jsonBytes = readBoundedRegularFile(
    baselineJsonPath,
    MAX_BASELINE_JSON_BYTES,
    "baseline JSON",
  );
  const markdownBytes = readBoundedRegularFile(
    baselineMarkdownPath,
    MAX_BASELINE_MARKDOWN_BYTES,
    "baseline Markdown",
  );
  const jsonText = jsonBytes.toString("utf8");
  let report;
  try {
    report = JSON.parse(jsonText);
  } catch (error) {
    throw new Error("baseline JSON is malformed", { cause: error });
  }
  validateBenchmarkReport(report);
  if (canonicalJson(report) !== jsonText) {
    throw new Error("baseline JSON is not in canonical stable form");
  }
  verifyCheckedBenchmarkProvenance(report, {
    evidencePaths: BENCHMARK_EVIDENCE_PATHS,
    productionTreePath: BENCHMARK_PRODUCTION_TREE_PATH,
    repositoryRoot,
  });
  verifyFixtureBindings(report.cases);
  const jsonDigest = sha256Hex(jsonBytes);
  const expectedMarkdown = renderBaselineMarkdown(report, jsonDigest);
  if (markdownBytes.toString("utf8") !== expectedMarkdown) {
    throw new Error("baseline Markdown or embedded JSON digest is stale");
  }
}

function collectEnvironment() {
  const processorList = cpus();
  const sourceFilesystem = statfsSync(repositoryRoot);
  const temporaryFilesystem = statfsSync(resolve(tmpdir()));
  const sqlite = new DatabaseSync(":memory:");
  let sqliteVersion;
  let sqliteCompileOptions;
  try {
    sqliteVersion = sqlite
      .prepare("SELECT sqlite_version() AS version")
      .get().version;
    sqliteCompileOptions = sqlite
      .prepare("PRAGMA compile_options")
      .all()
      .map((row) => row.compile_options)
      .sort();
  } finally {
    sqlite.close();
  }
  const ripgrepVersion = runBoundedCommandText(
    rgPath,
    ["--no-config", "--version"],
    {
      cwd: repositoryRoot,
      label: "read pinned ripgrep version",
      maxOutputBytes: 262_144,
    },
  )
    .split(/\r?\n/u)[0]
    .trim();
  return {
    cpu: {
      logicalCount: processorList.length,
      model: processorList[0]?.model ?? "unknown",
    },
    filesystems: {
      sourceCheckout: {
        blockSizeBytes: sourceFilesystem.bsize,
        type: String(sourceFilesystem.type),
      },
      temporaryFixtures: {
        blockSizeBytes: temporaryFilesystem.bsize,
        type: String(temporaryFilesystem.type),
      },
    },
    memory: { totalBytes: totalmem() },
    os: {
      arch: process.arch,
      platform: process.platform,
      release: release(),
    },
    ripgrep: {
      distribution: "pinned_package",
      version: ripgrepVersion,
    },
    runtime: {
      node: process.version,
      npm: runBoundedCommandText(
        process.execPath,
        [resolveBenchmarkNpmCliPath(), "--version"],
        {
          cwd: repositoryRoot,
          label: "read npm version",
          maxOutputBytes: 65_536,
        },
      ),
      v8: process.versions.v8,
    },
    sqlite: {
      compileOptions: sqliteCompileOptions,
      version: String(sqliteVersion),
    },
  };
}

function verifyFixtureBindings(caseReports) {
  BENCHMARK_PLAN.cases.forEach((definition, caseIndex) => {
    definition.inputSeries.forEach((_, pointIndex) => {
      const expected = describeFixture(definition.id, pointIndex);
      const point = caseReports[caseIndex].points[pointIndex];
      if (
        point.fixtureDigest !== expected.fixtureDigest ||
        canonicalJson(point.input) !==
          canonicalJson(expected.descriptor.input) ||
        canonicalJson(point.operations) !== canonicalJson(expected.operations)
      ) {
        throw new Error(
          `${definition.id} point ${pointIndex} fixture binding is stale`,
        );
      }
    });
  });
}

function validateStartMessage(message, expectedFixture, caseId) {
  if (
    message.caseId !== caseId ||
    message.fixtureDigest !== expectedFixture.fixtureDigest ||
    canonicalJson(message.input) !==
      canonicalJson(expectedFixture.descriptor.input) ||
    canonicalJson(message.operations) !==
      canonicalJson(expectedFixture.operations) ||
    !Number.isSafeInteger(message.rssBytes) ||
    message.rssBytes <= 0
  ) {
    throw new Error(
      `${caseId} emitted an invalid or nondeterministic start record`,
    );
  }
}

function parseStartMessage(stderr) {
  for (const line of stderr.split(/\r?\n/u)) {
    if (!line.startsWith(START_PREFIX)) continue;
    try {
      return JSON.parse(line.slice(START_PREFIX.length));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function parseProductionModulePaths(stderr) {
  const paths = [];
  for (const line of stderr.split(/\r?\n/u)) {
    if (!line.startsWith(PRODUCTION_MODULE_RECORD_PREFIX)) continue;
    let record;
    try {
      record = JSON.parse(line.slice(PRODUCTION_MODULE_RECORD_PREFIX.length));
    } catch (error) {
      throw new Error("worker emitted a malformed production module record", {
        cause: error,
      });
    }
    if (
      record === null ||
      typeof record !== "object" ||
      Array.isArray(record) ||
      Object.keys(record).length !== 1 ||
      typeof record.path !== "string" ||
      !record.path.startsWith(`${BENCHMARK_PRODUCTION_TREE_PATH}/`) ||
      record.path.includes("\\") ||
      record.path
        .split("/")
        .some(
          (segment) =>
            segment.length === 0 || segment === "." || segment === "..",
        )
    ) {
      throw new Error("worker emitted an invalid production module record");
    }
    paths.push(record.path);
  }
  const canonicalPaths = [...new Set(paths)].sort();
  if (canonicalPaths.length !== paths.length) {
    throw new Error("worker repeated a production module record");
  }
  if (canonicalPaths.length === 0) {
    throw new Error("worker did not report its production module closure");
  }
  if (canonicalPaths.length > MAX_PRODUCTION_MODULES_PER_CASE) {
    throw new Error("worker production module closure exceeds its named bound");
  }
  return canonicalPaths;
}

function mergeProductionModulePaths(trials) {
  const paths = new Set();
  for (const trial of trials) {
    for (const path of trial.productionModulePaths) paths.add(path);
  }
  if (paths.size > MAX_PRODUCTION_MODULES_PER_CASE) {
    throw new Error("case production module closure exceeds its named bound");
  }
  return [...paths].sort();
}

function trimDiagnostic(value) {
  const maximumCharacters = 2_000;
  return value.length <= maximumCharacters
    ? value
    : `${value.slice(0, maximumCharacters)}…`;
}

function assertSerializedArtifactWithinBounds(value, maximumBytes, label) {
  const bytes = Buffer.byteLength(value);
  if (bytes > maximumBytes) {
    throw new Error(`${label} exceeds its ${maximumBytes} byte ceiling`);
  }
}

function parseArguments(args) {
  if (args.length === 1 && args[0] === "--check") return { mode: "check" };
  if (args.length === 1 && args[0] === "--plan") return { mode: "plan" };
  const hasSourceRevision = args[0] === "--source-revision";
  const argumentOffset = hasSourceRevision ? 2 : 0;
  if (
    args.length === argumentOffset + 4 &&
    args[argumentOffset] === "--output" &&
    args[argumentOffset + 2] === "--markdown-output"
  ) {
    const outputPath = resolve(args[argumentOffset + 1]);
    const markdownOutputPath = resolve(args[argumentOffset + 3]);
    if (outputPath === markdownOutputPath) {
      throw new Error("JSON and Markdown outputs must use different paths");
    }
    return {
      sourceRevision: hasSourceRevision ? args[1] : "HEAD",
      mode: "run",
      outputPath,
      markdownOutputPath,
    };
  }
  throw new Error(
    "usage: run-baselines.mjs --check | --plan | [--source-revision REVISION] --output FILE --markdown-output FILE",
  );
}
