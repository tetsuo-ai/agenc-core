/**
 * DeepSeek long-stream replay benchmark.
 *
 * Replays committed SSE fixtures through the real entry point
 * DeepSeekProvider.chatStream with a fake fetchImpl, using fixed,
 * deterministic chunk boundaries (see lib.mts CHUNK_PATTERN). Setup
 * (provider construction, fixture load/encode/slicing) happens before
 * the timed region; the timed region is performance.now() around the
 * chatStream call only.
 *
 * Run (from the repository root's runtime/ directory):
 *   cd runtime && ~/workspace/.toolchain/node-v26.12.1-linux-x64/bin/node \
 *     --import tsx benchmarks/deepseek-stream/run.mts [--out <path>]
 *
 * Defaults: 5 warmup iterations, 30 measured samples per fixture.
 * Override with BENCH_WARMUP / BENCH_SAMPLES (results record the counts
 * actually used). Default output: results/<timestamp>.json is NOT used —
 * pass --out explicitly so result files have deliberate names.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  canonicalSerialization, here, loadFixture, makeProvider, runOnce,
  sha256Hex, summarize, CHUNK_PATTERN, type FixtureData,
} from "./lib.mts";

const WARMUP = Number(process.env.BENCH_WARMUP ?? 5);
const SAMPLES = Number(process.env.BENCH_SAMPLES ?? 30);

async function benchFixture(fixture: FixtureData): Promise<Record<string, unknown>> {
  // Warmup (untimed, discarded) — also proves the golden hash is stable
  // before any measured sample is taken.
  let goldenHash: string | undefined;
  let goldenChunks = 0;
  for (let i = 0; i < WARMUP; i++) {
    const run = await runOnce(makeProvider(fixture.chunks));
    const hash = sha256Hex(canonicalSerialization(run));
    if (goldenHash === undefined) { goldenHash = hash; goldenChunks = run.chunks.length; }
    else if (hash !== goldenHash) throw new Error(`${fixture.name}: warmup ${i} output hash diverged`);
  }
  const completion: number[] = [];
  const ttfvt: number[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    const run = await runOnce(makeProvider(fixture.chunks));
    const hash = sha256Hex(canonicalSerialization(run));
    if (hash !== goldenHash) {
      throw new Error(`${fixture.name}: sample ${i} output hash ${hash} != golden ${goldenHash}`);
    }
    completion.push(run.completionMs);
    ttfvt.push(run.ttfvtMs);
  }
  const completionStats = summarize(completion);
  const declaredCompletionTokens = Number(fixture.manifest.completionTokens);
  return {
    fixture: fixture.name,
    manifest: fixture.manifest,
    chunking: {
      pattern: CHUNK_PATTERN,
      chunkCount: fixture.chunks.length,
      chunkSizes: fixture.chunks.map((c) => c.length),
    },
    warmupIterations: WARMUP,
    sampleCount: SAMPLES,
    completionMs: { samples: completion, ...completionStats },
    ttfvtMs: { samples: ttfvt, ...summarize(ttfvt) },
    completionTokensPerSec: declaredCompletionTokens / (completionStats.median / 1000),
    declaredCompletionTokens,
    golden: { sha256: goldenHash, onChunkCount: goldenChunks },
  };
}

const results: Record<string, unknown> = {
  benchmark: "deepseek-stream-replay",
  generatedAt: new Date().toISOString(),
  node: process.version,
  platform: `${process.platform}/${process.arch}`,
  entryPoint: "DeepSeekProvider.chatStream (deepseek -> openai adapter streamChatCompletions -> readSseEvents -> parseSSEFrames)",
  fixtures: {},
};
for (const name of ["short", "long"] as const) {
  const fixture = loadFixture(name);
  const result = await benchFixture(fixture);
  (results.fixtures as Record<string, unknown>)[name] = result;
  const c = result.completionMs as { p50: number; p95: number; median: number };
  const t = result.ttfvtMs as { p50: number; p95: number };
  console.log(
    `${name}: completion p50=${c.p50.toFixed(2)}ms p95=${c.p95.toFixed(2)}ms ` +
    `ttfvt p50=${t.p50.toFixed(2)}ms p95=${t.p95.toFixed(2)}ms ` +
    `tok/s=${(result.completionTokensPerSec as number).toFixed(1)} ` +
    `golden=${(result.golden as { sha256: string }).sha256}`,
  );
}

const outIdx = process.argv.indexOf("--out");
if (outIdx >= 0) {
  const outPath = process.argv[outIdx + 1]!;
  const dest = outPath.startsWith("/") ? outPath : join(here, outPath);
  writeFileSync(dest, `${JSON.stringify(results, null, 2)}\n`, "utf8");
  console.log(`results written to ${dest}`);
} else {
  console.log(JSON.stringify(results, null, 2));
}
