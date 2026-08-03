#!/usr/bin/env node

import { performance } from "node:perf_hooks";
import { writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BENCHMARK_WORKER_COMPLETION_PREFIX,
  normalizeResourceUsageMaxRssBytes,
  summarizeSamples,
} from "./contract.mjs";
import {
  assertBenchmarkWorkerEnvironment,
  removeDarwinInjectedBenchmarkEnvironment,
  removeWindowsInjectedBenchmarkEnvironment,
} from "./environment.mjs";
import { buildFixture } from "./fixtures.mjs";
import { assertOwnedTemporaryRoot } from "./isolation.mjs";
import { registerProductionModuleTracker } from "./module-closure.mjs";

const START_PREFIX = "AGENC_FND_BENCH_START ";
const RSS_LIMITATION =
  "RSS is sampled at setup and operation endpoints; these observations are retained as a lower-bound diagnostic separate from the process high-water RSS.";
const COMPLETION_HOLD_INTERVAL_MS = 60_000;
const benchmarkRoot = dirname(fileURLToPath(import.meta.url));
const runtimeRoot = resolve(benchmarkRoot, "../..");
const repositoryRoot = resolve(runtimeRoot, "..");
const productionRoot = join(runtimeRoot, "src");

const requested = parseArguments(process.argv.slice(2));
let prepared;
let productionModuleTracker;

try {
  removeDarwinInjectedBenchmarkEnvironment(process.env);
  removeWindowsInjectedBenchmarkEnvironment(process.env);
  assertBenchmarkWorkerEnvironment(
    process.env,
    process.platform,
    requested.temporaryRoot,
  );
  productionModuleTracker = registerProductionModuleTracker({
    productionRoot,
    repositoryRoot,
    writeRecord(record) {
      process.stderr.write(record);
    },
  });
  const temporaryRoot = assertOwnedTemporaryRoot(requested.temporaryRoot, {
    requireEmpty: true,
    temporaryDirectory: dirname(requested.temporaryRoot),
  });
  const fixture = buildFixture(requested.caseId, requested.pointIndex);
  prepared = await prepareCase(fixture, temporaryRoot);
  const setupRssBytes = process.memoryUsage().rss;
  process.stderr.write(
    `${START_PREFIX}${JSON.stringify({
      caseId: requested.caseId,
      fixtureDigest: fixture.fixtureDigest,
      input: fixture.input,
      operations: fixture.operations,
      rssBytes: setupRssBytes,
    })}\n`,
  );

  for (let index = 0; index < fixture.definition.warmups; index += 1) {
    await prepared.beforeRun();
    await prepared.run();
  }

  const elapsedSamplesMs = [];
  const rssObservationsBytes = [setupRssBytes];
  let latestObservation;
  for (let index = 0; index < fixture.definition.repetitions; index += 1) {
    await prepared.beforeRun();
    rssObservationsBytes.push(process.memoryUsage().rss);
    const startedAt = performance.now();
    latestObservation = await prepared.run();
    elapsedSamplesMs.push(performance.now() - startedAt);
    rssObservationsBytes.push(process.memoryUsage().rss);
  }

  const correctness = prepared.correctness(latestObservation);
  const peakRssBytes = normalizeResourceUsageMaxRssBytes(
    process.resourceUsage().maxRSS,
  );
  const result = {
    correctness,
    elapsed: {
      clock: "performance.now",
      ...summarizeSamples(elapsedSamplesMs),
    },
    fixtureDigest: fixture.fixtureDigest,
    input: fixture.input,
    memory: {
      lowerBound: {
        limitation: RSS_LIMITATION,
        maximumObservedBytes: Math.max(...rssObservationsBytes),
        method: "endpoint_rss_lower_bound",
        observationsBytes: rssObservationsBytes,
      },
      peakRssBytes,
      peakRssMethod: "process.resourceUsage.maxRSS_kib_to_bytes",
    },
    operations: fixture.operations,
    status: "completed",
  };

  await prepared.cleanup();
  prepared = undefined;
  await productionModuleTracker.close();
  productionModuleTracker = undefined;
  await writeProcessStream(process.stdout, `${JSON.stringify(result)}\n`);
  await writeProcessStream(
    process.stderr,
    `${BENCHMARK_WORKER_COMPLETION_PREFIX}${requested.completionNonce}\n`,
  );
  setInterval(() => {}, COMPLETION_HOLD_INTERVAL_MS);
} catch (error) {
  if (prepared !== undefined) await prepared.cleanup().catch(() => {});
  if (productionModuleTracker !== undefined) {
    await productionModuleTracker.close().catch(() => {});
  }
  const message =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

async function prepareCase(fixture, temporaryRoot) {
  switch (fixture.definition.id) {
    case "csv_scheduler_progress_scan":
      return prepareCsvCase(fixture, temporaryRoot);
    case "patch_delete_parser_suffix_slicing":
      return preparePatchCase(fixture);
    default:
      throw new Error(`unknown benchmark case ${fixture.definition.id}`);
  }
}

async function prepareCsvCase(fixture, temporaryRoot) {
  const csvPath = join(temporaryRoot, "input.csv");
  await writeFile(csvPath, fixture.payload.content, "utf8");
  const [{ runAgentsOnCsv }, { createCsvInputRootCapability }] =
    await Promise.all([
      import("../../src/agents/jobs/job-orchestrator.ts"),
      import("../../src/agents/jobs/csv-reader.ts"),
    ]);
  const inputRootCapability = createCsvInputRootCapability(temporaryRoot);
  const spawn = {
    async spawn() {
      return { threadFinished: Promise.resolve() };
    },
    async cancelOutstanding() {},
  };
  return {
    async beforeRun() {},
    async run() {
      return runAgentsOnCsv({
        csvPath,
        inputRootCapability,
        idColumn: "source_id",
        instruction: "Process {task}",
        maxConcurrency: 1,
        progressEmitter() {},
        spawn,
      });
    },
    correctness(result) {
      const expectedCount = fixture.input.rowCount;
      const terminalCount =
        result.summary.completedItems +
        result.summary.failedItems +
        result.summary.cancelledItems +
        result.summary.unknownOutcomeItems;
      return {
        expected: `${expectedCount} generated rows reach one terminal state`,
        matchesOracle:
          result.summary.totalItems === expectedCount &&
          terminalCount === expectedCount,
        observed: `${result.summary.totalItems} rows summarized; ${terminalCount} terminal outcomes`,
        oracle: "generated row-count and terminal-state oracle",
      };
    },
    async cleanup() {},
  };
}

async function preparePatchCase(fixture) {
  const { parsePatch } = await import("../../src/tools/apply-patch/parser.ts");
  return {
    async beforeRun() {},
    async run() {
      return parsePatch(fixture.payload.patch);
    },
    correctness(result) {
      const deleteHunks = result.hunks.filter(
        (hunk) => hunk.kind === "delete",
      ).length;
      return {
        expected: `${fixture.input.hunkCount} ordered delete hunks`,
        matchesOracle:
          result.hunks.length === fixture.input.hunkCount &&
          deleteHunks === fixture.input.hunkCount,
        observed: `${result.hunks.length} hunks parsed; ${deleteHunks} delete hunks`,
        oracle: "generated patch grammar and hunk-count oracle",
      };
    },
    async cleanup() {},
  };
}

function parseArguments(args) {
  if (
    args.length !== 8 ||
    args[0] !== "--case" ||
    args[2] !== "--point" ||
    args[4] !== "--temporary-root" ||
    args[6] !== "--completion-nonce"
  ) {
    throw new Error(
      "usage: case-worker.mjs --case CASE_ID --point INDEX --temporary-root PATH --completion-nonce NONCE",
    );
  }
  const pointIndex = Number(args[3]);
  if (!Number.isSafeInteger(pointIndex) || pointIndex < 0) {
    throw new Error("point index must be a non-negative integer");
  }
  if (!/^[0-9a-f]{64}$/u.test(args[7])) {
    throw new Error("completion nonce must be 32 lowercase hexadecimal bytes");
  }
  return {
    caseId: args[1],
    completionNonce: args[7],
    pointIndex,
    temporaryRoot: args[5],
  };
}

function writeProcessStream(stream, value) {
  return new Promise((resolvePromise, rejectPromise) => {
    stream.write(value, (error) => {
      if (error === null || error === undefined) {
        resolvePromise();
      } else {
        rejectPromise(error);
      }
    });
  });
}
