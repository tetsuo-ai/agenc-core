import { expect, test, vi } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { tmpdir, loadavg } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { OpenAIProvider } from "../../src/llm/providers/openai/adapter.js";
import { runWithStartupProviderSelection } from "../../src/utils/model/providers.js";
import { RolloutStore } from "../../src/session/rollout-store.js";
import { mkCtx, mkSession } from "../fixtures.js";
import { buildInitialTurnState } from "../../src/session/turn-state.js";
import { isDurableEvent } from "../../src/session/event-log.js";
import { parseSSEFrames } from "../../src/llm/_deps/sse.js";
import * as sseModule from "../../src/llm/_deps/sse.js";
import { legacyParseSSEFrames } from "../fixtures/recorded-responses-rt/legacy-sse.js";

// Replay assembly and dispatch validation, but never execute recorded tools.
const queued = new Set<string>();
vi.mock("../../src/phases/execute-tools.js", async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(),
  ensureStreamingToolExecutor: () => ({
    getToolStates: () => [...queued].map(id => ({ id })),
    addTool: (_block: unknown, call: { id: string }) => { queued.add(call.id); },
    dispatchPending: () => {},
  }),
}));
import { streamModel } from "../../src/phases/stream-model.js";

const MODEL = "gpt-6-luna";
const fixtureRoot = join(process.cwd(), "tests/fixtures/recorded-responses-rt");
type Fixture = {
  label: string; parts: string[]; sha256: string; bytes: number;
  text_chars: number; tool_calls: number; events: number;
};
const fixtures: Fixture[] = JSON.parse(readFileSync(join(fixtureRoot, "manifest.json"), "utf8"));

function split(raw: Uint8Array, size: number): Uint8Array[] {
  if (size !== 0) {
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < raw.length; i += size) chunks.push(raw.subarray(i, i + size));
    return chunks;
  }
  // A complete frame is a useful lower bound on fragmentation overhead.
  const chunks: Uint8Array[] = [];
  let start = 0;
  for (let i = 1; i < raw.length; i++) {
    if (raw[i - 1] === 10 && raw[i] === 10) {
      chunks.push(raw.subarray(start, i + 1));
      start = i + 1;
    }
  }
  if (start < raw.length) chunks.push(raw.subarray(start));
  return chunks;
}

function quantiles(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
  return { count: values.length, sum_ms: values.reduce((a, b) => a + b, 0), p50_ms: at(.5), p95_ms: at(.95), max_ms: at(1) };
}

async function replay(raw: Uint8Array, size: number, full: boolean, listeners = 0) {
  queued.clear();
  const chunks = split(raw, size);
  const chunkDwell: number[] = [];
  const chunkCpu: number[] = [];
  const callbackDwell: number[] = [];
  let delivered = 0, mark: number | undefined;
  let cpuMark: ReturnType<typeof process.cpuUsage> | undefined;
  const finishChunk = () => {
    if (mark !== undefined) {
      chunkDwell.push(performance.now() - mark);
      const cpu = process.cpuUsage(cpuMark);
      chunkCpu.push((cpu.user + cpu.system) / 1000);
      mark = undefined;
    }
  };
  let fetches = 0;
  const fetchImpl: typeof fetch = async () => {
    fetches++;
    return new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        finishChunk();
        if (delivered === chunks.length) { controller.close(); return; }
        mark = performance.now();
        cpuMark = process.cpuUsage();
        controller.enqueue(chunks[delivered++]!);
      },
      cancel() { finishChunk(); },
    }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } });
  };
  const provider = new OpenAIProvider({ apiKey: "offline-placeholder", model: MODEL, useResponsesApi: true, fetchImpl });
  const original = provider.chatStream.bind(provider);
  let callbackCount = 0;
  provider.chatStream = (messages, onChunk, options) => original(messages, chunk => {
    const started = performance.now();
    callbackCount++;
    onChunk(chunk);
    callbackDwell.push(performance.now() - started);
  }, options).then(response => { finishChunk(); return response; });
  const root = mkdtempSync(join(tmpdir(), "rt-replay-"));
  const ctx = mkCtx({ cwd: root, modelInfo: { slug: MODEL, contextWindow: 131072, supportedReasoningLevels: [], effectiveContextWindowPercent: 100, defaultReasoningSummary: "none", truncationPolicy: "off", usedFallbackModelMetadata: false } });
  const { session, events } = mkSession({ cwd: root, provider, model: MODEL });
  const store = new RolloutStore({ cwd: root, sessionId: session.conversationId, agencHome: join(root, "home"), sessionTempRoot: join(root, "scratch"), agencVersion: "0.19.0", autoStartScheduler: false });
  store.open({ sessionId: session.conversationId, cwd: root, timestamp: new Date().toISOString(), originator: "offline-replay", agencVersion: "0.19.0", model: MODEL, modelProvider: "openai" });
  if (full) session.mountRolloutStore(store);
  let flushes = 0, flushMs = 0, emittedBytes = 0;
  const realFlush = store.store.flushBatch.bind(store.store);
  store.store.flushBatch = (...args) => {
    const started = performance.now();
    flushes++;
    try { return realFlush(...args); } finally { flushMs += performance.now() - started; }
  };
  // Model synchronous JSON event consumers without a pipe or stdout stall.
  const unsubscribers = Array.from({ length: listeners }, () => session.eventLog.subscribe(event => { emittedBytes += JSON.stringify(event).length; }));
  const state = buildInitialTurnState(ctx, { role: "user", content: "offline replay" });
  const loadBefore = loadavg();
  const cpuBefore = process.cpuUsage();
  const started = performance.now();
  let content = "", tools = 0;
  try {
    await runWithStartupProviderSelection({ provider: "openai", model: MODEL, environment: {} }, async () => {
      if (full) {
        await streamModel(state, ctx, session, { input: state.messages, tools: [], parallelToolCalls: true, baseInstructions: "" });
        content = String(state.messages.at(-1)?.content ?? "");
        tools = state.messages.at(-1)?.toolCalls?.length ?? 0;
        store.flushDurable();
      } else {
        const response = await provider.chatStream(state.messages, () => {});
        content = response.content;
        tools = response.toolCalls.length;
      }
    });
    finishChunk();
    const wallMs = performance.now() - started;
    const cpu = process.cpuUsage(cpuBefore);
    expect(fetches).toBe(1);
    return { wall_ms: wallMs, cpu_ms: (cpu.user + cpu.system) / 1000, cpu_user_ms: cpu.user / 1000, cpu_system_ms: cpu.system / 1000,
      load_before: loadBefore, load_after: loadavg(), chunks: quantiles(chunkDwell), chunk_cpu: quantiles(chunkCpu), callbacks: quantiles(callbackDwell), callback_count: callbackCount,
      flushes, flush_ms: flushMs, event_count: events.length, durable_events: events.filter(isDurableEvent).length, emitted_bytes: emittedBytes,
      text_chars: content.length, tool_calls: tools, queued_calls: queued.size };
  } finally {
    for (const unsubscribe of unsubscribers) unsubscribe();
    session.mountRolloutStore(null);
    store.close();
    await session.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
}

test("recorded Light Responses replay through the production stream phase", async () => {
  // Warm imports, provider wire construction, native SQLite and the JIT first.
  const load = (f: Fixture) => {
    const raw = gunzipSync(Buffer.concat(f.parts.map(part => readFileSync(join(fixtureRoot, part)))));
    expect(createHash("sha256").update(raw).digest("hex")).toBe(f.sha256);
    expect(raw.length).toBe(f.bytes);
    return raw;
  };
  const warm = load(fixtures[0]!);
  await replay(warm, 16384, true);
  for (const fixture of fixtures) {
    const raw = load(fixture);
    for (const size of [0, 1024, 16384, 65536]) {
      for (const full of [false, true]) {
        for (let repeat = 0; repeat < 3; repeat++) {
          const result = await replay(raw, size, full);
          expect(result.text_chars).toBe(fixture.text_chars);
          expect(result.tool_calls).toBe(fixture.tool_calls);
          console.log("RT_REPLAY " + JSON.stringify({ label: fixture.label, size, full, repeat, bytes: raw.length, sse_events: fixture.events, ...result }));
        }
      }
    }
  }
}, 600000);

function syntheticScale(deltas: number, argumentChars: number) {
  const argument = JSON.stringify({ payload: "x".repeat(argumentChars) });
  const item = { type: "function_call", id: "fc_offline", call_id: "call_offline", name: "offline_tool", arguments: argument };
  const frames: string[] = [];
  const frame = (event: Record<string, unknown>) => frames.push(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  frame({ type: "response.output_item.added", item: { ...item, arguments: "" } });
  for (let i = 0; i < deltas; i++) frame({ type: "response.function_call_arguments.delta", item_id: item.id, delta: argument.slice(Math.floor(i * argument.length / deltas), Math.floor((i + 1) * argument.length / deltas)), output_index: 0, sequence_number: i });
  frame({ type: "response.output_item.done", item });
  frame({ type: "response.completed", response: { status: "completed", model: MODEL, output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
  return new TextEncoder().encode(frames.join(""));
}

test("Pi-sized synthetic argument streams use only Light code", async () => {
  for (const multiplier of [.25, .5, 1, 2]) {
    const raw = syntheticScale(Math.round(10574 * multiplier), Math.round(32376 * multiplier));
    for (const size of [1024, 16384, 65536, raw.length]) {
      for (let repeat = 0; repeat < 3; repeat++) {
        const result = await replay(raw, size, true);
        expect(result.tool_calls).toBe(1);
        console.log("RT_SCALE " + JSON.stringify({ multiplier, size, repeat, bytes: raw.length, ...result }));
      }
    }
  }
  const fixture = fixtures.find(f => f.label === "most-text")!;
  const raw = gunzipSync(Buffer.concat(fixture.parts.map(part => readFileSync(join(fixtureRoot, part)))));
  for (const listeners of [1, 8, 32]) {
    for (let repeat = 0; repeat < 3; repeat++) console.log("RT_FANOUT " + JSON.stringify({ listeners, repeat, ...await replay(raw, 1024, true, listeners) }));
  }
}, 120000);

test("main parser in the full production stream and persistence path", async () => {
  const spy = vi.spyOn(sseModule, "parseSSEFrames").mockImplementation(legacyParseSSEFrames);
  try {
    for (const fixture of fixtures) {
      const raw = gunzipSync(Buffer.concat(fixture.parts.map(part => readFileSync(join(fixtureRoot, part)))));
      for (let repeat = 0; repeat < 3; repeat++) {
        const result = await replay(raw, 16384, true);
        expect(result.text_chars).toBe(fixture.text_chars);
        expect(result.tool_calls).toBe(fixture.tool_calls);
        expect(result.event_count).toBeGreaterThan(0);
        console.log("RT_MAIN " + JSON.stringify({ label: fixture.label, size: 16384, repeat, bytes: raw.length, ...result }));
      }
    }
    expect(spy).toHaveBeenCalled();
  } finally { spy.mockRestore(); }
}, 120000);

test("paired parser benchmark with an A/A noise floor", () => {
  const fixture = fixtures.find(f => f.label === "largest-wire")!;
  const raw = gunzipSync(Buffer.concat(fixture.parts.map(part => readFileSync(join(fixtureRoot, part))))).toString("utf8");
  expect(parseSSEFrames(raw)).toEqual(legacyParseSSEFrames(raw));
  const parsers = [legacyParseSSEFrames, parseSSEFrames];
  for (const parser of parsers) parser(raw);
  for (const kind of ["AA", "ABBA"]) {
    for (let block = 0; block < 8; block++) {
      for (const implementation of kind === "AA" ? [0, 0, 1, 1] : [0, 1, 1, 0]) {
        const cpuBefore = process.cpuUsage();
        const loadBefore = loadavg();
        const started = performance.now();
        const result = parsers[implementation]!(raw);
        const wallMs = performance.now() - started;
        const cpu = process.cpuUsage(cpuBefore);
        expect(result.frames.length).toBe(fixture.events);
        console.log("RT_PARSER " + JSON.stringify({ kind, block, implementation, wall_ms: wallMs, cpu_ms: (cpu.user + cpu.system) / 1000, bytes: fixture.bytes, frames: result.frames.length, load_before: loadBefore, load_after: loadavg() }));
      }
    }
  }
}, 120000);
