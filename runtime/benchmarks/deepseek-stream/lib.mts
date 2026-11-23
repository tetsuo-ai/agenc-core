/**
 * Shared helpers for the DeepSeek stream replay benchmark: deterministic
 * chunk slicing, the fake-fetch replay transport, canonical output
 * serialization, and summary statistics. Used by run.mts and
 * profile-loop.mts so both replay bytes identically.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DeepSeekProvider } from "../../src/llm/providers/deepseek/index.js";
import type { LLMMessage, LLMResponse, LLMStreamChunk, LLMTool } from "../../src/llm/types.js";

export const here = dirname(fileURLToPath(import.meta.url));

/**
 * Fixed chunk-size pattern (bytes), cycled over the whole fixture byte
 * stream. It deliberately mixes multi-frame chunks (8192, 4096) with
 * tiny chunks (3, 5, 7, 13, 17) so many chunk boundaries land mid-frame,
 * mid-line, and mid-JSON-token. Identical for every run and revision.
 */
export const CHUNK_PATTERN: readonly number[] = [
  7, 1024, 13, 4096, 3, 251, 8192, 61, 997, 17, 2048, 5,
];

export function sliceChunks(bytes: Uint8Array): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  let i = 0;
  while (offset < bytes.length) {
    const size = CHUNK_PATTERN[i % CHUNK_PATTERN.length]!;
    chunks.push(bytes.subarray(offset, Math.min(bytes.length, offset + size)));
    offset += size;
    i += 1;
  }
  return chunks;
}

export interface FixtureData {
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly chunks: readonly Uint8Array[];
  readonly manifest: Record<string, unknown>;
}

export function loadFixture(name: "short" | "long"): FixtureData {
  const manifest = JSON.parse(
    readFileSync(join(here, "fixtures", "manifest.json"), "utf8"),
  ) as Record<string, Record<string, unknown>>;
  const raw = readFileSync(join(here, "fixtures", `${name}.sse`));
  const bytes = new Uint8Array(raw);
  return { name, bytes, chunks: sliceChunks(bytes), manifest: manifest[name]! };
}

/** A fetchImpl whose Response body replays the pre-sliced chunks verbatim. */
export function replayFetch(chunks: readonly Uint8Array[]): typeof fetch {
  return async () => {
    let next = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[next++];
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
}

export const BENCH_MESSAGES: LLMMessage[] = [
  { role: "user", content: "Replay the fixture stream." },
];

export const ECHO_TOOL: LLMTool = {
  type: "function",
  function: {
    name: "system.echo",
    description: "Echo text.",
    parameters: {
      type: "object",
      properties: { text: { type: "string" }, count: { type: "number" } },
      required: ["text"],
    },
  },
};

export function makeProvider(chunks: readonly Uint8Array[]): DeepSeekProvider {
  return new DeepSeekProvider({
    apiKey: "test",
    model: "deepseek-flash",
    fetchImpl: replayFetch(chunks),
  });
}

export interface RecordedRun {
  readonly chunks: LLMStreamChunk[];
  readonly response: LLMResponse;
  readonly completionMs: number;
  /** ms from start to first onChunk with content.length > 0; -1 if none. */
  readonly ttfvtMs: number;
}

/** One timed replay. Provider construction happens before this is called. */
export async function runOnce(provider: DeepSeekProvider): Promise<RecordedRun> {
  const recorded: LLMStreamChunk[] = [];
  let start = 0;
  let ttfvtMs = -1;
  const onChunk = (chunk: LLMStreamChunk): void => {
    if (ttfvtMs < 0 && chunk.content.length > 0) {
      ttfvtMs = performance.now() - start;
    }
    // Copy: never retain a reference the provider might mutate later.
    recorded.push({
      content: chunk.content,
      done: chunk.done,
      ...(chunk.bufferedContentProgress !== undefined
        ? { bufferedContentProgress: chunk.bufferedContentProgress }
        : {}),
      ...(chunk.reasoningSummaryDelta !== undefined
        ? { reasoningSummaryDelta: { ...chunk.reasoningSummaryDelta } }
        : {}),
      ...(chunk.toolCalls !== undefined
        ? { toolCalls: chunk.toolCalls.map((t) => ({ ...t })) }
        : {}),
    });
  };
  start = performance.now();
  const response = await provider.chatStream(BENCH_MESSAGES, onChunk, {
    tools: [ECHO_TOOL],
    maxOutputTokens: 8192,
  });
  const completionMs = performance.now() - start;
  return { chunks: recorded, response, completionMs, ttfvtMs };
}

/** Canonical serialization of everything the consumer saw. */
export function canonicalSerialization(run: RecordedRun): string {
  const r = run.response;
  return JSON.stringify({
    chunks: run.chunks,
    response: {
      content: r.content,
      toolCalls: r.toolCalls,
      usage: r.usage,
      model: r.model,
      finishReason: r.finishReason,
      providerReasoningContent: r.providerReasoningContent ?? null,
      thinking: r.thinking ?? null,
    },
  });
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.min(lo + 1, sorted.length - 1);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

export function summarize(samples: readonly number[]): {
  readonly p50: number; readonly p95: number; readonly median: number;
  readonly min: number; readonly max: number; readonly mean: number;
} {
  const sorted = [...samples].sort((a, b) => a - b);
  const median = percentile(sorted, 0.5);
  return {
    p50: median,
    p95: percentile(sorted, 0.95),
    median,
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
    mean: samples.reduce((a, b) => a + b, 0) / samples.length,
  };
}
