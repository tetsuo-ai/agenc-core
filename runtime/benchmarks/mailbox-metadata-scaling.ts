#!/usr/bin/env -S npx tsx

import { performance } from "node:perf_hooks";

import {
  MAX_MAILBOX_METADATA_NODES,
  MailboxMetadataBuilder,
  decodeMailboxMetadata,
  getMailboxMetadataMetrics,
  isValidatedMailboxMetadata,
  type ValidatedMailboxMetadata,
} from "../src/agents/mailbox-metadata.js";

const SAMPLE_COUNT = 7;
const WARMUP_COUNT = 2;
const BRAND_CHECK_ITERATIONS = 200_000;
const BRAND_SAMPLE_COUNT = 7;
const BRAND_WARMUP_COUNT = 2;
const MAX_BRAND_COST_GROWTH_MULTIPLIER = 4;
const MAX_NORMALIZED_GROWTH_MULTIPLIER = 8;
const NODE_COUNTS = Object.freeze([1_000, 5_000, 10_000] as const);

interface ScalingPoint {
  readonly bytes: number;
  readonly madMilliseconds: number;
  readonly medianMilliseconds: number;
  readonly nanosecondsPerNode: number;
  readonly nodes: number;
}

interface BrandPoint {
  readonly checks: number;
  readonly madNanosecondsPerCheck: number;
  readonly nanosecondsPerCheck: number;
  readonly nodes: number;
}

function buildMetadata(nodes: number): ValidatedMailboxMetadata {
  const builder = new MailboxMetadataBuilder();
  requireAccepted(builder.beginObject());
  for (let index = 0; index < nodes - 1; index += 1) {
    requireAccepted(builder.key(`key_${index}`));
    requireAccepted(builder.scalar(index));
  }
  requireAccepted(builder.endObject());
  const result = builder.finish();
  if (!result.ok) {
    throw new Error(`builder rejected ${nodes} nodes: ${result.reason}`);
  }
  assertNodeCount(result.metadata, nodes);
  return result.metadata;
}

function buildReverseIndexedMetadata(nodes: number): ValidatedMailboxMetadata {
  const builder = new MailboxMetadataBuilder();
  requireAccepted(builder.beginObject());
  for (let index = nodes - 2; index >= 0; index -= 1) {
    requireAccepted(builder.key(String(index)));
    requireAccepted(builder.scalar(index));
  }
  requireAccepted(builder.endObject());
  const result = builder.finish();
  if (!result.ok) {
    throw new Error(
      `indexed builder rejected ${nodes} nodes: ${result.reason}`,
    );
  }
  assertNodeCount(result.metadata, nodes);
  return result.metadata;
}

function decodeMetadata(
  bytes: Uint8Array,
  nodes: number,
): ValidatedMailboxMetadata {
  const result = decodeMailboxMetadata(bytes);
  if (!result.ok) {
    throw new Error(`decoder rejected ${nodes} nodes: ${result.reason}`);
  }
  assertNodeCount(result.metadata, nodes);
  return result.metadata;
}

function metadataJson(nodes: number): Uint8Array {
  const parts = ["{"];
  for (let index = 0; index < nodes - 1; index += 1) {
    if (index > 0) parts.push(",");
    parts.push(`"key_${index}":${index}`);
  }
  parts.push("}");
  return new TextEncoder().encode(parts.join(""));
}

function measureScaling(
  nodes: number,
  operation: () => ValidatedMailboxMetadata,
): ScalingPoint {
  for (let index = 0; index < WARMUP_COUNT; index += 1) operation();
  const samples: number[] = [];
  let metadata: ValidatedMailboxMetadata | undefined;
  for (let index = 0; index < SAMPLE_COUNT; index += 1) {
    const startedAt = performance.now();
    metadata = operation();
    samples.push(performance.now() - startedAt);
  }
  if (metadata === undefined) throw new Error("benchmark produced no metadata");
  const medianMilliseconds = median(samples);
  return {
    bytes: getMailboxMetadataMetrics(metadata).utf8Bytes,
    madMilliseconds: median(
      samples.map((sample) => Math.abs(sample - medianMilliseconds)),
    ),
    medianMilliseconds,
    nanosecondsPerNode: (medianMilliseconds * 1_000_000) / nodes,
    nodes,
  };
}

function measureBrand(
  metadata: ValidatedMailboxMetadata,
  nodes: number,
): BrandPoint {
  for (let sample = 0; sample < BRAND_WARMUP_COUNT; sample += 1) {
    runBrandChecks(metadata);
  }
  const samples: number[] = [];
  for (let sample = 0; sample < BRAND_SAMPLE_COUNT; sample += 1) {
    samples.push(runBrandChecks(metadata));
  }
  const nanosecondsPerCheck = median(samples);
  return {
    checks: BRAND_CHECK_ITERATIONS,
    madNanosecondsPerCheck: median(
      samples.map((sample) => Math.abs(sample - nanosecondsPerCheck)),
    ),
    nanosecondsPerCheck,
    nodes,
  };
}

function runBrandChecks(metadata: ValidatedMailboxMetadata): number {
  let authenticated = 0;
  const startedAt = performance.now();
  for (let index = 0; index < BRAND_CHECK_ITERATIONS; index += 1) {
    if (isValidatedMailboxMetadata(metadata)) authenticated += 1;
  }
  const elapsedMilliseconds = performance.now() - startedAt;
  if (authenticated !== BRAND_CHECK_ITERATIONS) {
    throw new Error("brand benchmark failed authentication");
  }
  return (elapsedMilliseconds * 1_000_000) / BRAND_CHECK_ITERATIONS;
}

function requireAccepted(result: {
  readonly ok: boolean;
  readonly reason?: string;
}): void {
  if (!result.ok)
    throw new Error(`benchmark operation rejected: ${result.reason}`);
}

function assertNodeCount(
  metadata: ValidatedMailboxMetadata,
  expectedNodes: number,
): void {
  const actualNodes = getMailboxMetadataMetrics(metadata).nodes;
  if (actualNodes !== expectedNodes) {
    throw new Error(`expected ${expectedNodes} nodes, received ${actualNodes}`);
  }
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function assertLinearEnvelope(
  label: string,
  points: readonly ScalingPoint[],
): void {
  const first = points[0];
  const last = points[points.length - 1];
  if (first === undefined || last === undefined) {
    throw new Error(`${label} benchmark has no points`);
  }
  const inputGrowth = last.nodes / first.nodes;
  const elapsedGrowth = last.medianMilliseconds / first.medianMilliseconds;
  if (
    !Number.isFinite(elapsedGrowth) ||
    elapsedGrowth > inputGrowth * MAX_NORMALIZED_GROWTH_MULTIPLIER
  ) {
    throw new Error(
      `${label} scaling exceeded the bounded linear envelope: ${elapsedGrowth.toFixed(2)}x`,
    );
  }
}

function assertConstantBrandEnvelope(points: readonly BrandPoint[]): void {
  const small = points[0];
  const boundary = points[1];
  if (small === undefined || boundary === undefined || points.length !== 2) {
    throw new Error("brand benchmark requires exactly two points");
  }
  if (
    small.checks !== BRAND_CHECK_ITERATIONS ||
    boundary.checks !== BRAND_CHECK_ITERATIONS
  ) {
    throw new Error("brand benchmark operation count drifted");
  }
  const costGrowth = boundary.nanosecondsPerCheck / small.nanosecondsPerCheck;
  if (
    !Number.isFinite(costGrowth) ||
    costGrowth > MAX_BRAND_COST_GROWTH_MULTIPLIER
  ) {
    throw new Error(
      `private-brand scaling exceeded the O(1) envelope: ${costGrowth.toFixed(2)}x`,
    );
  }
}

const encodedInputs = new Map(
  NODE_COUNTS.map((nodes) => [nodes, metadataJson(nodes)] as const),
);
const builder = NODE_COUNTS.map((nodes) =>
  measureScaling(nodes, () => buildMetadata(nodes)),
);
const indexedBuilder = NODE_COUNTS.map((nodes) =>
  measureScaling(nodes, () => buildReverseIndexedMetadata(nodes)),
);
const decoder = NODE_COUNTS.map((nodes) =>
  measureScaling(nodes, () => decodeMetadata(encodedInputs.get(nodes)!, nodes)),
);
const smallMetadata = buildMetadata(NODE_COUNTS[0]);
const boundaryMetadata = buildMetadata(MAX_MAILBOX_METADATA_NODES);
const brand = [
  measureBrand(smallMetadata, NODE_COUNTS[0]),
  measureBrand(boundaryMetadata, MAX_MAILBOX_METADATA_NODES),
];

if (process.argv.includes("--check")) {
  assertConstantBrandEnvelope(brand);
  assertLinearEnvelope("builder", builder);
  assertLinearEnvelope("indexed builder", indexedBuilder);
  assertLinearEnvelope("decoder", decoder);
}

process.stdout.write(
  `${JSON.stringify(
    {
      benchmark: "mailbox-metadata-scaling-v1",
      brand,
      builder,
      decoder,
      indexedBuilder,
      nodeRuntime: process.version,
      brandSamples: BRAND_SAMPLE_COUNT,
      brandWarmups: BRAND_WARMUP_COUNT,
      samples: SAMPLE_COUNT,
      warmups: WARMUP_COUNT,
    },
    null,
    2,
  )}\n`,
);
