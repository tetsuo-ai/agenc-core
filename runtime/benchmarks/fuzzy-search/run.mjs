#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { statfsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { cpus, platform, release, tmpdir, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { rgPath } from "@vscode/ripgrep";
import Database from "better-sqlite3";

import {
  assertFuzzyBenchmarkAcceptance,
  FULL_CORPUS_SIZES,
  FULL_QUERY_SAMPLE_COUNT,
  FUZZY_BENCHMARK_MODES,
  FUZZY_BENCHMARK_SCHEMA_VERSION,
  FUZZY_BENCHMARK_SUITE_ID,
  QUICK_CORPUS_SIZES,
  QUICK_QUERY_SAMPLE_COUNT,
  validateFuzzyBenchmarkReport,
} from "./contract.mjs";
import { generateFuzzyCorpus } from "./corpus.mjs";

const MAX_WORKER_OUTPUT_BYTES = 1_048_576;
const QUICK_WORKER_TIMEOUT_MS = 120_000;
const FULL_WORKER_TIMEOUT_MS = 2_700_000;
const benchmarkRoot = dirname(fileURLToPath(import.meta.url));
const runtimeRoot = resolve(benchmarkRoot, "../..");
const repositoryRoot = resolve(runtimeRoot, "..");
const workerPath = join(benchmarkRoot, "worker.mjs");
if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const npmVersion = assertPinnedToolchain();
  assertBenchmarkInputsAreClean();
  const sourceRevision = commandText(
    "git",
    ["rev-parse", "HEAD"],
    repositoryRoot,
  );
  const productionTree = commandText(
    "git",
    ["rev-parse", "HEAD:runtime/src"],
    repositoryRoot,
  );
  const sizes = options.quick ? QUICK_CORPUS_SIZES : FULL_CORPUS_SIZES;
  const samples = options.quick
    ? QUICK_QUERY_SAMPLE_COUNT
    : FULL_QUERY_SAMPLE_COUNT;
  const points = [];

  for (const mode of FUZZY_BENCHMARK_MODES) {
    for (const size of sizes) {
      process.stderr.write(`D2 fuzzy benchmark ${mode} ${size}\n`);
      points.push(
        await runWorker({
          invalidationTimeoutMs: options.quick ? 30_000 : 900_000,
          mode,
          samples,
          size,
          timeoutMs: options.quick
            ? QUICK_WORKER_TIMEOUT_MS
            : FULL_WORKER_TIMEOUT_MS,
        }),
      );
    }
  }

  assertBenchmarkInputsAreClean();
  const finalSourceRevision = commandText(
    "git",
    ["rev-parse", "HEAD"],
    repositoryRoot,
  );
  const finalProductionTree = commandText(
    "git",
    ["rev-parse", "HEAD:runtime/src"],
    repositoryRoot,
  );
  if (
    finalSourceRevision !== sourceRevision ||
    finalProductionTree !== productionTree
  ) {
    throw new Error(
      "fuzzy benchmark refuses a source revision or production tree that changed during the run",
    );
  }

  const report = {
    environment: collectEnvironment(npmVersion),
    points,
    productionTree,
    schemaVersion: FUZZY_BENCHMARK_SCHEMA_VERSION,
    sourceRevision,
    suiteId: FUZZY_BENCHMARK_SUITE_ID,
  };

  validateFuzzyBenchmarkReport(report, { quick: options.quick });
  let acceptanceFailure = null;
  try {
    if (!options.quick) assertFuzzyBenchmarkAcceptance(report);
    if (options.check && points.some((point) => point.status !== "completed")) {
      throw new Error(
        "quick fuzzy benchmark check requires every point to complete",
      );
    }
  } catch (error) {
    acceptanceFailure =
      error instanceof Error ? error : new Error(String(error));
  }
  process.stderr.write(renderTable(points));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (acceptanceFailure !== null) {
    process.stderr.write(
      `D2 fuzzy benchmark acceptance failed: ${acceptanceFailure.message}\n`,
    );
    process.exitCode = 1;
  }
}

async function runWorker(options) {
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), "agenc-d2-fuzzy-benchmark-"),
  );
  const args = [
    "--import",
    "tsx",
    "--expose-gc",
    workerPath,
    "--mode",
    options.mode,
    "--size",
    String(options.size),
    "--samples",
    String(options.samples),
    "--invalidation-timeout-ms",
    String(options.invalidationTimeoutMs),
    "--temporary-root",
    temporaryRoot,
  ];
  try {
    return await new Promise((resolveWorker) => {
      const child = spawn(process.execPath, args, {
        cwd: runtimeRoot,
        env: benchmarkEnvironment(),
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout = [];
      const stderr = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let forcedFailure = null;
      let settled = false;
      const settle = (point) => {
        if (settled) return;
        settled = true;
        resolveWorker(point);
      };
      const timer = setTimeout(() => {
        if (forcedFailure !== null) return;
        forcedFailure = {
          code: "WORKER_TIMEOUT",
          message: `worker exceeded ${options.timeoutMs}ms`,
          status: "timed_out",
        };
        child.kill("SIGKILL");
      }, options.timeoutMs);
      timer.unref?.();

      child.stdout.on("data", (chunk) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > MAX_WORKER_OUTPUT_BYTES) {
          forcedFailure = {
            code: "WORKER_STDOUT_LIMIT",
            message: `worker stdout exceeded ${MAX_WORKER_OUTPUT_BYTES} bytes`,
            status: "failed",
          };
          child.kill("SIGKILL");
          return;
        }
        stdout.push(chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderrBytes += chunk.length;
        if (stderrBytes > MAX_WORKER_OUTPUT_BYTES) {
          forcedFailure = {
            code: "WORKER_STDERR_LIMIT",
            message: `worker stderr exceeded ${MAX_WORKER_OUTPUT_BYTES} bytes`,
            status: "failed",
          };
          child.kill("SIGKILL");
          return;
        }
        stderr.push(chunk);
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        settle(
          failedWorkerPoint(options, {
            code: "WORKER_SPAWN_FAILED",
            message: error.message,
            status: "failed",
          }),
        );
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        if (forcedFailure !== null) {
          settle(failedWorkerPoint(options, forcedFailure));
          return;
        }
        const stderrText = Buffer.concat(stderr).toString("utf8");
        if (code !== 0) {
          const resourceLimited =
            signal === "SIGKILL" ||
            /heap out of memory|allocation failed|out of memory/iu.test(
              stderrText,
            );
          settle(
            failedWorkerPoint(options, {
              code: resourceLimited ? "WORKER_RESOURCE_LIMIT" : "WORKER_FAILED",
              message: boundedErrorMessage(
                `worker exited ${String(code)}/${String(signal)}: ${stderrText}`,
              ),
              status: resourceLimited ? "resource_limited" : "failed",
            }),
          );
          return;
        }
        try {
          settle(JSON.parse(Buffer.concat(stdout).toString("utf8")));
        } catch (error) {
          settle(
            failedWorkerPoint(options, {
              code: "WORKER_INVALID_JSON",
              message: error instanceof Error ? error.message : String(error),
              status: "failed",
            }),
          );
        }
      });
    });
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
}

function benchmarkEnvironment() {
  const environment = {};
  for (const name of [
    "COMSPEC",
    "PATH",
    "PATHEXT",
    "SystemRoot",
    "TEMP",
    "TMP",
    "TMPDIR",
    "WINDIR",
  ]) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  environment.LANG = "C.UTF-8";
  environment.LC_ALL = "C.UTF-8";
  environment.NODE_ENV = "test";
  environment.NO_COLOR = "1";
  environment.TZ = "UTC";
  return environment;
}

function collectEnvironment(npmVersion) {
  const processors = cpus();
  const sourceFilesystem = statfsSync(repositoryRoot);
  const temporaryFilesystem = statfsSync(resolve(tmpdir()));
  const sqlite = new Database(":memory:");
  let sqliteCompileOptions;
  let sqliteVersion;
  try {
    sqliteVersion = String(
      sqlite.prepare("SELECT sqlite_version() AS version").get().version,
    );
    sqliteCompileOptions = sqlite
      .pragma("compile_options")
      .map((row) => String(row.compile_options))
      .sort();
  } finally {
    sqlite.close();
  }
  const ripgrepVersion = commandText(
    rgPath,
    ["--no-config", "--version"],
    repositoryRoot,
  )
    .split(/\r?\n/u)[0]
    .trim();
  return {
    cpu: {
      logicalCount: processors.length,
      model: processors[0]?.model ?? "unknown",
    },
    filesystems: {
      sourceCheckout: filesystemDescriptor(sourceFilesystem),
      temporaryFixtures: filesystemDescriptor(temporaryFilesystem),
    },
    memory: { totalBytes: totalmem() },
    os: {
      arch: process.arch,
      platform: platform(),
      release: release(),
    },
    ripgrep: {
      distribution: "pinned_package",
      version: ripgrepVersion,
    },
    runtime: {
      node: process.version,
      npm: npmVersion,
      v8: process.versions.v8,
    },
    sqlite: {
      compileOptions: sqliteCompileOptions,
      version: sqliteVersion,
    },
  };
}

function filesystemDescriptor(filesystem) {
  return {
    blockSizeBytes: filesystem.bsize,
    type: String(filesystem.type),
  };
}

function failedWorkerPoint(options, failure) {
  const corpus = generateFuzzyCorpus(options.size, {
    includeEntries: false,
    includePaths: false,
  });
  return {
    build: {
      elapsedMs: null,
      kind:
        options.mode === "matcher_only"
          ? "prepared_candidates"
          : "persistent_generation",
    },
    corpus: {
      digest: corpus.digest,
      generatorVersion: corpus.generatorVersion,
      pathBytes: corpus.pathBytes,
      size: corpus.size,
    },
    error: {
      code: failure.code,
      message: boundedErrorMessage(failure.message),
    },
    indexBytes: {
      closedDatabaseBytes: null,
      finalDatabaseBytes: null,
      finalLogicalPathBytes: corpus.pathBytes,
      finalOpenTotalBytes: null,
      finalShmBytes: null,
      finalWalBytes: null,
      initialDatabaseBytes: null,
      initialOpenTotalBytes: null,
      initialShmBytes: null,
      initialWalBytes: null,
      logicalPathBytes: corpus.pathBytes,
    },
    invalidation: null,
    memory: {
      afterBuildRssBytes: null,
      afterCorpusRssBytes: null,
      afterQueryRssBytes: null,
      baselineRssBytes: null,
      peakRssBytes: null,
    },
    mode: options.mode,
    query: null,
    status: failure.status,
    telemetry: { workerBoundary: true },
  };
}

function boundedErrorMessage(message) {
  return String(message).slice(0, 4_096);
}

function assertPinnedToolchain() {
  if (process.version !== "v26.5.0") {
    throw new Error(
      `fuzzy benchmark requires Node v26.5.0, received ${process.version}`,
    );
  }
  const observedNpm = commandText("npm", ["--version"]);
  if (observedNpm !== "11.17.0") {
    throw new Error(
      `fuzzy benchmark requires npm 11.17.0, received ${observedNpm}`,
    );
  }
  return observedNpm;
}

function assertBenchmarkInputsAreClean() {
  assertGitPathIsClean("runtime/src", "production tree");
  assertGitPathIsClean(
    "runtime/benchmarks/fuzzy-search",
    "benchmark evidence tree",
  );
}

export function assertGitPathIsClean(
  path,
  label,
  gitRepositoryRoot = repositoryRoot,
) {
  for (const args of [
    ["diff", "--quiet", "--", path],
    ["diff", "--cached", "--quiet", "--", path],
  ]) {
    const result = spawnSync("git", args, {
      cwd: gitRepositoryRoot,
      encoding: "utf8",
      env: benchmarkEnvironment(),
      maxBuffer: 65_536,
    });
    if (result.error !== undefined) throw result.error;
    if (result.status === 1) {
      throw new Error(
        `fuzzy benchmark refuses dirty tracked files in ${label}`,
      );
    }
    if (result.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
    }
  }
  const untracked = commandText(
    "git",
    ["ls-files", "--others", "--exclude-standard", "--", path],
    gitRepositoryRoot,
  );
  if (untracked.length > 0) {
    throw new Error(`fuzzy benchmark refuses untracked files in ${label}`);
  }
  const ignored = commandText(
    "git",
    ["ls-files", "--others", "--ignored", "--exclude-standard", "--", path],
    gitRepositoryRoot,
  );
  if (ignored.length > 0) {
    throw new Error(`fuzzy benchmark refuses ignored files in ${label}`);
  }
}

function renderTable(points) {
  const lines = [
    "mode\tsize\tstatus\tbuild_ms\tcold_p50_ms\tcold_p95_ms\twarm_p50_ms\twarm_p95_ms\tpeak_rss\tindex_bytes\tinvalidation_ms",
  ];
  for (const point of points) {
    lines.push(
      [
        point.mode,
        point.corpus.size,
        point.status,
        fixed(point.build.elapsedMs),
        fixed(point.query?.cold.p50Ms),
        fixed(point.query?.cold.p95Ms),
        fixed(point.query?.warm.p50Ms),
        fixed(point.query?.warm.p95Ms),
        point.memory.peakRssBytes ?? "n/a",
        point.indexBytes.closedDatabaseBytes ?? "n/a",
        fixed(point.invalidation?.elapsedMs),
      ].join("\t"),
    );
  }
  return `${lines.join("\n")}\n`;
}

function fixed(value) {
  return typeof value === "number" ? value.toFixed(3) : "n/a";
}

function commandText(program, args, cwd = runtimeRoot) {
  const result = spawnSync(program, args, {
    cwd,
    encoding: "utf8",
    env: benchmarkEnvironment(),
    maxBuffer: 65_536,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${program} ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function parseArguments(args) {
  let check = false;
  let quick = false;
  for (const argument of args) {
    if (argument === "--check") check = true;
    else if (argument === "--quick") quick = true;
    else throw new Error(`unknown fuzzy benchmark option ${argument}`);
  }
  if (check && !quick) {
    throw new Error("--check is available only with --quick");
  }
  return Object.freeze({ check, quick });
}
