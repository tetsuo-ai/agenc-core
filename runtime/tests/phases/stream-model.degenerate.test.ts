import { readFileSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";
import { streamModel, StreamModelError } from "../../src/phases/stream-model.js";
import { buildInitialTurnState } from "../../src/session/turn-state.js";
import { mkCtx, mkSession } from "../fixtures.js";
import { answer, scriptedProvider } from "../helpers/stream-progress-fixture.js";

const salad = readFileSync(new URL("../fixtures/degenerate-stream.txt", import.meta.url), "utf8");

async function sample(text: string, channel: "visible" | "thinking" | "summary", size = 19, disabled = false) {
  let emitted = 0;
  let aborted = false;
  const { provider } = scriptedProvider([async (emit, options) => {
    for (let offset = 0; offset < text.length; offset += size) {
      const delta = text.slice(offset, offset + size);
      emitted += delta.length;
      emit({ content: channel === "visible" ? delta : "", done: false,
        ...(channel === "thinking" ? { thinkingDelta: { delta, index: 0 } } : {}),
        ...(channel === "summary" ? { reasoningSummaryDelta: { delta, summaryIndex: 0 } } : {}),
      });
      if (options.signal?.aborted) { aborted = true; throw options.signal.reason; }
    }
    return { ...answer, content: channel === "visible" ? text : answer.content };
  }]);
  const { session, events } = mkSession({ provider });
  if (disabled) {
    const current = session.services.configStore!.current.bind(session.services.configStore);
    vi.spyOn(session.services.configStore!, "current").mockImplementation(() => ({
      ...current(), stream_degenerate_guard: false,
    }));
  }
  const ctx = mkCtx();
  const state = buildInitialTurnState(ctx, { role: "user", content: "Create a file" });
  const sink = { reset: vi.fn(), writeCanonicalDelta: vi.fn() };
  const error = await streamModel(state, ctx, session, {
    input: state.messages, tools: [], parallelToolCalls: false, baseInstructions: "", maxOutputTokens: 16384,
  }, undefined, sink).then(() => undefined, error => error);
  return { error, emitted, aborted, state, events, sink };
}

function compactNumericLog(domain: number): string {
  let seed = 1234567;
  const rand = (n: number) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return (seed >>> 8) % n;
  };
  const labels = ["a", "b", "c", "d"];
  return Array.from({ length: 2000 }, () => labels.map(() =>
    `${labels[rand(4)]}=${rand(domain)}`,
  ).join(" ") + "\n").join("");
}

describe("degenerate model stream guard", () => {
  test.each(["visible", "thinking", "summary"] as const)("stops V2 salad on %s and marks partial output unreliable", async channel => {
    const run = await sample(salad, channel);
    expect(run.error).toBeInstanceOf(StreamModelError);
    expect(run.error.cause).toMatchObject({ reason: "stream_degenerate" });
    expect(run.aborted).toBe(true);
    expect(run.emitted).toBeLessThan(4300);
    expect(run.state.assistantMessages).toHaveLength(0);
    const stops = run.events.filter(e => e.msg.type === "stream_error");
    expect(stops).toHaveLength(1);
    expect(stops[0]?.msg.payload.message).toMatch(/partial output is unreliable.*retry/i);
    expect(run.sink.reset).toHaveBeenCalledTimes(2);
  });

  test.each([
    ["compact numeric log", compactNumericLog(1000)],
    ["compact low-cardinality numeric log", compactNumericLog(2)],
    ["long log", Array.from({ length: 3000 }, (_, i) => `INFO worker ${i} completed request successfully after ${i % 17} attempts\n`).join("")],
    ["identical log lines", "INFO retry waiting for worker to become available\n".repeat(3000)],
    ["long code", Array.from({ length: 2000 }, (_, i) => `function compute${i}(value) { return value * ${i + 1}; }\n`).join("")],
    ["minified code", "const f=x=>{return x.map(y=>y+1);};".repeat(3000)],
    ["JSON", JSON.stringify(Array.from({ length: 3000 }, (_, i) => ({ id: i, state: "ready" })))],
    ["table", "| a | b | c |\n".repeat(4000)],
    ["base64", Buffer.from("a binary payload repeated for transfer ".repeat(3000)).toString("base64")],
  ])("allows %s", async (_label, text) => {
    const run = await sample(text, "visible", 137);
    expect(run.error).toBeUndefined();
    expect(run.aborted).toBe(false);
    expect(run.state.assistantMessages.at(-1)?.text).toBe(text);
  });

  test("the config off switch permits the same salad", async () => {
    const run = await sample(salad, "visible", 19, true);
    expect(run.error).toBeUndefined();
    expect(run.aborted).toBe(false);
  });
});
