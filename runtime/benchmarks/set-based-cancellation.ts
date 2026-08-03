#!/usr/bin/env -S npx tsx

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { upsertAgentRun } from "../src/state/agent-runs.js";
import {
  MAX_CANCELLATION_RUNS,
  cancelAgentRunTree,
} from "../src/state/run-cancellation.js";
import { openStateDatabases } from "../src/state/sqlite-driver.js";

const SAMPLE_COUNT = 5;
const WARMUP_COUNT = 1;
const MAX_NORMALIZED_GROWTH_MULTIPLIER = 4;
const NODE_COUNTS = Object.freeze([1_000, 10_000, MAX_CANCELLATION_RUNS]);
const FIXED_TIME = "2026-08-03T00:00:00.000Z";

interface CancellationBenchmarkPoint {
  readonly edges: number;
  readonly madMilliseconds: number;
  readonly medianMilliseconds: number;
  readonly microsecondsPerNode: number;
  readonly nodes: number;
}

function runSample(nodes: number): number {
  const home = mkdtempSync(
    join(tmpdir(), "agenc-cancellation-benchmark-home-"),
  );
  const cwd = mkdtempSync(join(tmpdir(), "agenc-cancellation-benchmark-cwd-"));
  mkdirSync(join(cwd, ".git"));
  const driver = openStateDatabases({ cwd, agencHome: home });
  try {
    upsertAgentRun(driver, {
      id: "benchmark_root",
      objective: "set cancellation scaling benchmark",
      status: "running",
      startedAt: FIXED_TIME,
      lastActiveAt: FIXED_TIME,
    });
    driver
      .prepareState<[number]>(
        `WITH RECURSIVE sequence(value) AS (
           VALUES (1)
           UNION ALL
           SELECT value + 1 FROM sequence WHERE value < ?
         )
         INSERT INTO thread_spawn_edges (
           child_thread_id, parent_thread_id, parent_path, metadata_json, status
         )
         SELECT printf('benchmark_%06d', value),
                CASE value WHEN 1 THEN 'benchmark_root'
                  ELSE printf('benchmark_%06d', value - 1) END,
                '/root', '{}', 'open'
         FROM sequence`,
      )
      .run(nodes - 1);

    const startedAt = performance.now();
    const report = cancelAgentRunTree(driver, {
      runId: "benchmark_root",
      reason: "benchmark",
      cancelledAt: FIXED_TIME,
    });
    const elapsed = performance.now() - startedAt;
    if (
      report.cancellationNodeCount !== nodes ||
      report.cancellationEdgeCount !== nodes - 1 ||
      report.subtreeRunIds.length !== nodes
    ) {
      throw new Error(
        `cancellation benchmark cardinality mismatch at ${nodes}`,
      );
    }
    return elapsed;
  } finally {
    driver.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
}

function benchmark(nodes: number): CancellationBenchmarkPoint {
  for (let index = 0; index < WARMUP_COUNT; index += 1) runSample(nodes);
  const samples = Array.from({ length: SAMPLE_COUNT }, () => runSample(nodes));
  const medianMilliseconds = median(samples);
  return {
    edges: nodes - 1,
    madMilliseconds: median(
      samples.map((sample) => Math.abs(sample - medianMilliseconds)),
    ),
    medianMilliseconds,
    microsecondsPerNode: (medianMilliseconds * 1_000) / nodes,
    nodes,
  };
}

function median(values: readonly number[]): number {
  if (values.length === 0) throw new Error("median requires a sample");
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0);
}

const points = NODE_COUNTS.map(benchmark);
const baselineCost = points[0]?.microsecondsPerNode;
if (
  baselineCost === undefined ||
  points.some(
    (point) =>
      point.microsecondsPerNode >
      baselineCost * MAX_NORMALIZED_GROWTH_MULTIPLIER,
  )
) {
  throw new Error(
    `set cancellation exceeded ${MAX_NORMALIZED_GROWTH_MULTIPLIER}x ` +
      "normalized-cost growth",
  );
}
process.stdout.write(
  `${JSON.stringify(
    {
      benchmark: "set-based-cancellation",
      node: process.version,
      points,
      samples: SAMPLE_COUNT,
    },
    null,
    2,
  )}\n`,
);
