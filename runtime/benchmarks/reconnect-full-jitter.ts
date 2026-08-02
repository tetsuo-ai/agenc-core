#!/usr/bin/env -S npx tsx

import { performance } from "node:perf_hooks";

import {
  RECONNECT_INITIAL_MS,
  RECONNECT_MAX_MS,
  calculateReconnectDelay,
  type RetryAfterDirective,
} from "../src/recovery/reconnect-policy.js";

const SAMPLE_COUNT = 7;
const WARMUP_COUNT = 2;
const RETRY_ATTEMPT = 5;
const DISTRIBUTION_BUCKETS = 20;
const MINIMUM_BUCKET_FRACTION = 0.03;
const MINIMUM_INTERVAL_COVERAGE = 0.99;
const MAX_NANOSECONDS_PER_OPERATION_RATIO = 8;
const UINT32_RANGE = 0x1_0000_0000;
const NONZERO_SEED = 0x9e37_79b9;
const SAMPLE_SIZES = Object.freeze([10_000, 100_000, 1_000_000] as const);
const ABSENT_DIRECTIVE = Object.freeze({
  classification: "absent",
} as const satisfies RetryAfterDirective);

interface BenchmarkPoint {
  readonly calls: number;
  readonly checksum: number;
  readonly madMilliseconds: number;
  readonly maximumDelayMs: number;
  readonly medianMilliseconds: number;
  readonly minimumDelayMs: number;
  readonly nanosecondsPerCall: number;
}

function deterministicRng(seed: number): () => number {
  let state = seed === 0 ? NONZERO_SEED : seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / UINT32_RANGE;
  };
}

function runCalls(calls: number): {
  readonly checksum: number;
  readonly maximumDelayMs: number;
  readonly minimumDelayMs: number;
} {
  const rng = deterministicRng(NONZERO_SEED ^ calls);
  let checksum = 0;
  let maximumDelayMs = 0;
  let minimumDelayMs = Number.POSITIVE_INFINITY;
  for (let index = 0; index < calls; index += 1) {
    const decision = calculateReconnectDelay({
      attempt: RETRY_ATTEMPT,
      baseDelayMs: RECONNECT_INITIAL_MS,
      maxDelayMs: RECONNECT_MAX_MS,
      remainingBudgetMs: undefined,
      retryAfter: ABSENT_DIRECTIVE,
      rng,
    });
    if (decision.kind !== "delay") {
      throw new Error(`unexpected benchmark exhaustion: ${decision.reason}`);
    }
    checksum = (checksum + decision.delayMs) % UINT32_RANGE;
    minimumDelayMs = Math.min(minimumDelayMs, decision.delayMs);
    maximumDelayMs = Math.max(maximumDelayMs, decision.delayMs);
  }
  return { checksum, maximumDelayMs, minimumDelayMs };
}

function benchmarkPoint(calls: number): BenchmarkPoint {
  for (let index = 0; index < WARMUP_COUNT; index += 1) runCalls(calls);
  const samples: number[] = [];
  let evidence = runCalls(calls);
  for (let index = 0; index < SAMPLE_COUNT; index += 1) {
    const startedAt = performance.now();
    evidence = runCalls(calls);
    samples.push(performance.now() - startedAt);
  }
  const medianMilliseconds = median(samples);
  return {
    calls,
    checksum: evidence.checksum,
    madMilliseconds: median(
      samples.map((sample) => Math.abs(sample - medianMilliseconds)),
    ),
    maximumDelayMs: evidence.maximumDelayMs,
    medianMilliseconds,
    minimumDelayMs: evidence.minimumDelayMs,
    nanosecondsPerCall: (medianMilliseconds * 1_000_000) / calls,
  };
}

function distributionEvidence(calls: number): {
  readonly buckets: readonly number[];
  readonly calls: number;
  readonly maximumDelayMs: number;
  readonly minimumDelayMs: number;
} {
  const buckets = new Array<number>(DISTRIBUTION_BUCKETS).fill(0);
  const rng = deterministicRng(NONZERO_SEED);
  let maximumDelayMs = 0;
  let minimumDelayMs = Number.POSITIVE_INFINITY;
  for (let index = 0; index < calls; index += 1) {
    const decision = calculateReconnectDelay({
      attempt: 0,
      baseDelayMs: RECONNECT_INITIAL_MS,
      maxDelayMs: RECONNECT_MAX_MS,
      remainingBudgetMs: undefined,
      retryAfter: ABSENT_DIRECTIVE,
      rng,
    });
    if (decision.kind !== "delay") {
      throw new Error(`unexpected distribution exhaustion: ${decision.reason}`);
    }
    const bucket = Math.min(
      buckets.length - 1,
      Math.floor(
        (decision.delayMs / (RECONNECT_INITIAL_MS + 1)) * buckets.length,
      ),
    );
    buckets[bucket] += 1;
    minimumDelayMs = Math.min(minimumDelayMs, decision.delayMs);
    maximumDelayMs = Math.max(maximumDelayMs, decision.delayMs);
  }
  return { buckets, calls, maximumDelayMs, minimumDelayMs };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function assertConstantTime(points: readonly BenchmarkPoint[]): void {
  const costs = points.map((point) => point.nanosecondsPerCall);
  const minimum = Math.min(...costs);
  const maximum = Math.max(...costs);
  if (
    !Number.isFinite(minimum) ||
    !Number.isFinite(maximum) ||
    maximum / minimum > MAX_NANOSECONDS_PER_OPERATION_RATIO
  ) {
    throw new Error(
      `calculator cost exceeded O(1) envelope: ${(maximum / minimum).toFixed(2)}x`,
    );
  }
}

function assertDistribution(
  evidence: ReturnType<typeof distributionEvidence>,
): void {
  const minimumBucket = evidence.calls * MINIMUM_BUCKET_FRACTION;
  if (evidence.buckets.some((count) => count < minimumBucket)) {
    throw new Error("full-jitter distribution left a broad bucket underfilled");
  }
  if (
    evidence.minimumDelayMs >
      RECONNECT_INITIAL_MS * (1 - MINIMUM_INTERVAL_COVERAGE) ||
    evidence.maximumDelayMs < RECONNECT_INITIAL_MS * MINIMUM_INTERVAL_COVERAGE
  ) {
    throw new Error("full-jitter samples did not cover the allowed interval");
  }
}

const points = SAMPLE_SIZES.map(benchmarkPoint);
const distribution = distributionEvidence(SAMPLE_SIZES.at(-1)!);
if (process.argv.includes("--check")) {
  assertConstantTime(points);
  assertDistribution(distribution);
}

process.stdout.write(
  `${JSON.stringify(
    {
      benchmark: "reconnect-full-jitter-v1",
      distribution,
      nodeRuntime: process.version,
      points,
      samples: SAMPLE_COUNT,
      warmups: WARMUP_COUNT,
    },
    null,
    2,
  )}\n`,
);
