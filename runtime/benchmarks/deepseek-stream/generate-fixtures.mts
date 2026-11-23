/**
 * Deterministic fixture generator for the DeepSeek stream replay benchmark.
 *
 * Seeded PRNG only; no randomness at bench time and no randomness across
 * runs of this script — regenerating must produce byte-identical fixtures.
 *
 * Run:
 *   cd runtime && ~/workspace/.toolchain/node-v26.12.1-linux-x64/bin/node \
 *     --import tsx benchmarks/deepseek-stream/generate-fixtures.mts
 * (tsx is hoisted to the repository-root node_modules; `--import tsx`
 * resolves it from there when run inside the workspace.)
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "fixtures");

const MODEL = "deepseek-flash";
const CREATED = 1_700_000_000;

/** mulberry32 — tiny deterministic PRNG. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = [
  "alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel",
  "india", "juliet", "kilo", "lima", "stream", "token", "vector", "window",
] as const;

function wordRun(rng: () => number, count: number, tag: string): string {
  const parts: string[] = [];
  for (let i = 0; i < count; i++) {
    parts.push(`${tag}${i % 97}-${WORDS[Math.floor(rng() * WORDS.length)]}`);
  }
  return parts.join(" ");
}

interface FrameSpec {
  readonly kind: "reasoning" | "content" | "tool_init" | "tool_args" | "finish" | "usage";
  readonly text: string;
}

function frameJson(delta: Record<string, unknown>, finishReason: string | null): string {
  return JSON.stringify({
    id: "chatcmpl-bench-deepseek-stream",
    object: "chat.completion.chunk",
    created: CREATED,
    model: MODEL,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });
}

function usageFrameJson(usage: Record<string, unknown>): string {
  return JSON.stringify({
    id: "chatcmpl-bench-deepseek-stream",
    object: "chat.completion.chunk",
    created: CREATED,
    model: MODEL,
    choices: [],
    usage,
  });
}

function buildFixture(args: {
  readonly seed: number;
  readonly reasoningDeltas: number;
  readonly contentDeltas: number;
  readonly toolArgFragments: number;
  readonly toolArgTextWords: number;
  readonly usage: Record<string, unknown>;
}): { readonly bytes: string; readonly stats: Record<string, number> } {
  const rng = mulberry32(args.seed);
  const frames: FrameSpec[] = [];

  for (let i = 0; i < args.reasoningDeltas; i++) {
    const text = `${wordRun(rng, 3, "r")} `;
    frames.push({ kind: "reasoning", text: frameJson({ role: "assistant", reasoning_content: text }, null) });
  }
  for (let i = 0; i < args.contentDeltas; i++) {
    const text = `${wordRun(rng, 3, "c")} `;
    frames.push({ kind: "content", text: frameJson({ content: text }, null) });
  }
  // One tool call: init delta carries id + name, then the arguments JSON
  // is fragmented across exactly `toolArgFragments` small deltas.
  frames.push({
    kind: "tool_init",
    text: frameJson({
      tool_calls: [{ index: 0, id: "call_bench_echo", type: "function", function: { name: "system.echo", arguments: "" } }],
    }, null),
  });
  const fullArgs = JSON.stringify({ text: wordRun(rng, args.toolArgTextWords, "a"), count: 42 });
  const fragSize = Math.max(1, Math.floor(fullArgs.length / args.toolArgFragments));
  for (let f = 0; f < args.toolArgFragments; f++) {
    const start = f * fragSize;
    const piece = f === args.toolArgFragments - 1 ? fullArgs.slice(start) : fullArgs.slice(start, start + fragSize);
    frames.push({
      kind: "tool_args",
      text: frameJson({
        tool_calls: [{ index: 0, function: { arguments: piece } }],
      }, null),
    });
  }
  frames.push({ kind: "finish", text: frameJson({}, "tool_calls") });
  frames.push({ kind: "usage", text: usageFrameJson(args.usage) });

  const sse = frames.map((f) => `data: ${f.text}\n\n`).join("") + "data: [DONE]\n\n";
  const count = (kind: FrameSpec["kind"]) => frames.filter((f) => f.kind === kind).length;
  const deltaFrames = count("reasoning") + count("content") + count("tool_init") + count("tool_args");
  return {
    bytes: sse,
    stats: {
      reasoningDeltas: count("reasoning"),
      contentDeltas: count("content"),
      toolInitDeltas: count("tool_init"),
      toolArgFragments: count("tool_args"),
      deltaFrames,
      finishFrames: count("finish"),
      usageFrames: count("usage"),
      doneFrames: 1,
      totalFrames: frames.length + 1,
      toolArgumentsBytes: fullArgs.length,
      completionTokens: Number(args.usage.completion_tokens),
    },
  };
}

mkdirSync(fixturesDir, { recursive: true });

const shortUsage = {
  prompt_tokens: 32,
  completion_tokens: 48,
  total_tokens: 80,
  prompt_cache_hit_tokens: 16,
  prompt_cache_miss_tokens: 16,
  completion_tokens_details: { reasoning_tokens: 16 },
};
const longUsage = {
  prompt_tokens: 128,
  completion_tokens: 4096,
  total_tokens: 4224,
  prompt_cache_hit_tokens: 64,
  prompt_cache_miss_tokens: 64,
  completion_tokens_details: { reasoning_tokens: 2000 },
};

const short = buildFixture({
  seed: 0x5eed0001, reasoningDeltas: 16, contentDeltas: 26,
  toolArgFragments: 5, toolArgTextWords: 4, usage: shortUsage,
});
const long = buildFixture({
  seed: 0x5eed0002, reasoningDeltas: 2000, contentDeltas: 1400,
  toolArgFragments: 700, toolArgTextWords: 620, usage: longUsage,
});

const manifest: Record<string, unknown> = {};
for (const [name, fixture] of [["short", short], ["long", long]] as const) {
  const bytes = Buffer.byteLength(fixture.bytes, "utf8");
  const sha256 = createHash("sha256").update(fixture.bytes, "utf8").digest("hex");
  writeFileSync(join(fixturesDir, `${name}.sse`), fixture.bytes, "utf8");
  manifest[name] = { file: `${name}.sse`, bytes, sha256, usage: name === "short" ? shortUsage : longUsage, ...fixture.stats };
  console.log(`${name}: ${bytes} bytes, deltaFrames=${fixture.stats.deltaFrames}, toolArgFragments=${fixture.stats.toolArgFragments}, sha256=${sha256}`);
}
writeFileSync(join(fixturesDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(`manifest written to ${join(fixturesDir, "manifest.json")}`);
