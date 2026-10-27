import { readFileSync } from "node:fs";
import { afterEach, describe, expect, test, vi } from "vitest";
import { StreamProgressError } from "../../src/llm/stream-progress.js";
import { StreamModelError } from "../../src/phases/stream-model.js";
import { interruptedStreamRetryBlockReason } from "../../src/session/run-turn-stream-retry.js";
import { buildInitialTurnState } from "../../src/session/turn-state.js";
import { runTurn } from "../../src/session/run-turn.js";
import type { ToolRegistry } from "../../src/tool-registry.js";
import { drain, mkCtx, mkSession } from "../fixtures.js";
import { answer, goodSample, scriptedProvider, type Sample } from "../helpers/stream-progress-fixture.js";

const salad = readFileSync(new URL("../fixtures/degenerate-stream.txt", import.meta.url), "utf8");
const saladSample: Sample = async (emit, options) => {
  for (let i = 0; i < salad.length; i += 17) {
    emit({ content: salad.slice(i, i + 17), done: false });
    if (options.signal?.aborted) throw options.signal.reason;
  }
  return { ...answer, content: salad };
};
afterEach(() => vi.useRealTimers());

describe("degenerate output recovery", () => {
  test.each(["queued", "executing", "completed"])("the retry policy blocks registered read-only work (%s)", status => {
    const ctx = mkCtx();
    const state = buildInitialTurnState(ctx, { role: "user", content: "Create file" });
    state.toolUseBlocks = [{ type: "tool_use", id: "read-1", name: "read", input: {} }];
    state.streamingToolExecutor = { getToolStates: () => [{ id: "read-1", toolName: "read", status, hasDispatched: status !== "queued" }] } as unknown as typeof state.streamingToolExecutor;
    // Ordinary cut streams may retry only undispatched work. Degeneration cannot.
    const ordinary = interruptedStreamRetryBlockReason(state);
    if (status === "queued") expect(ordinary).toBeNull();
    else expect(ordinary).toMatch(/may have executed/);
    expect(interruptedStreamRetryBlockReason(state,
      new StreamModelError(new StreamProgressError("test", "stream_degenerate")),
    )).toMatch(/not retrying degenerate output/);
  });

  test("discards the failed sample and retries exactly once with clean history", async () => {
    vi.useFakeTimers();
    const scripted = scriptedProvider([saladSample, async (emit, options) => goodSample(emit, options)]);
    const { session, events } = mkSession({ provider: scripted.provider });
    const pending = drain(runTurn(session, mkCtx(), "Create the requested file"));
    await vi.waitFor(() => expect(scripted.calls()).toBeGreaterThan(0));
    await vi.advanceTimersByTimeAsync(10_000);
    await pending;
    expect(scripted.calls()).toBe(2);
    expect(JSON.stringify(session.snapshotHistoryMessages())).not.toContain("fu fu :");
    expect(events.some(e => e.msg.type === "stream_error" && e.msg.payload.message.includes("retrying"))).toBe(true);
    expect(events.some(e => e.msg.type === "turn_failed")).toBe(false);
  });

  test("a second salad stops without entering the provider outage ladder", async () => {
    vi.useFakeTimers();
    const scripted = scriptedProvider([saladSample]);
    const { session, events } = mkSession({ provider: scripted.provider });
    const pending = drain(runTurn(session, mkCtx(), "Create the requested file"));
    await vi.waitFor(() => expect(scripted.calls()).toBeGreaterThan(0));
    await vi.advanceTimersByTimeAsync(10_000);
    await pending;
    expect(scripted.calls()).toBe(2);
    expect(events.filter(e => e.msg.type === "turn_failed")).toHaveLength(1);
  });

  test("never retries after a real read-only streaming tool starts", async () => {
    const started = Promise.withResolvers<void>();
    const completed = Promise.withResolvers<{ content: string; isError: boolean }>();
    const execute = vi.fn(async (args: Record<string, unknown>) => {
      const signal = args.__abortSignal as AbortSignal;
      signal.addEventListener("abort", () => completed.resolve({ content: "read aborted", isError: true }), { once: true });
      started.resolve();
      return completed.promise;
    });
    const registry = {
      tools: [{ name: "stream_read", description: "Read file", inputSchema: { type: "object" },
        requiresApproval: false, concurrencyClass: { kind: "shared_read" },
        recoveryCategory: "read-only", isReadOnly: true, execute }],
      toLLMTools: () => [], dispatch: execute,
    } as unknown as ToolRegistry;
    const scripted = scriptedProvider([async (emit, options) => {
      emit({ content: "Reading.\n", done: false, toolCalls: [{ id: "read-1", name: "stream_read", arguments: "{}" }] });
      await started.promise;
      return saladSample(emit, options);
    }, goodSample]);
    const { session, events } = mkSession({ provider: scripted.provider, registry });
    try {
      await drain(runTurn(session, mkCtx(), "Create the requested file"));
      expect(execute).toHaveBeenCalledOnce();
      expect(scripted.calls()).toBe(1);
      expect(events.some(e => e.msg.type === "stream_error" && e.msg.payload.cause === "stream_degenerate")).toBe(true);
      expect(events.some(e => e.msg.type === "stream_error" && e.msg.payload.message.includes("retrying"))).toBe(false);
    } finally {
      completed.resolve({ content: "test cleanup", isError: true });
    }
  });
});
