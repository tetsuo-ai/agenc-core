/**
 * Phase D acceptance test: the streaming bridge can drain a
 * synthetic `executeChat()`-shape async generator back into a
 * legacy `ChatExecutorResult` via
 * `buildChatExecutorResultFromEvents`, and fires the legacy
 * stream callback for every `stream_chunk` event along the way.
 *
 * No production code consumes the bridge yet — Phase E migrates
 * the 10 production callers to `for await`, and during that
 * migration each caller will go through this bridge. The bridge
 * itself must therefore be trusted enough to drive side-by-side
 * with the existing `ChatExecutor.execute()` path without drifting.
 */

import { describe, it, expect, vi } from "vitest";
import {
  drainToLegacyCallbacks,
  buildChatExecutorResultFromEvents,
  createAccumulator,
  applyEvent,
  type ChatExecutorResultSeed,
} from "./streaming-bridge.js";
import type {
  ExecuteChatYield,
  Terminal,
} from "./streaming-events.js";

function makeSeed(
  overrides: Partial<ChatExecutorResultSeed> = {},
): ChatExecutorResultSeed {
  return {
    provider: "mock",
    model: "mock-model",
    usedFallback: false,
    callUsage: [],
    turnExecutionContract: {
      version: 1 as const,
      turnClass: "dialogue" as const,
      ownerMode: "none" as const,
      sourceArtifacts: [],
      targetArtifacts: [],
      delegationPolicy: "planner_allowed" as const,
      contractFingerprint: "test-fingerprint",
      taskLineageId: "test-lineage",
    },
    completionState: "completed",
    stopReason: "completed",
    ...overrides,
  };
}

function makeTerminal(
  overrides: Partial<Terminal> = {},
): Terminal {
  return {
    reason: "stop_reason_end_turn",
    finalContent: "final answer",
    toolCalls: [],
    tokenUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    durationMs: 42,
    ...overrides,
  };
}

async function* synthStream(
  events: readonly ExecuteChatYield[],
  terminal: Terminal,
): AsyncGenerator<ExecuteChatYield, Terminal, void> {
  for (const event of events) {
    yield event;
  }
  return terminal;
}

describe("streaming-bridge", () => {
  describe("applyEvent + accumulator", () => {
    it("accumulates assistant text content and usage", () => {
      const acc = createAccumulator();
      applyEvent(acc, {
        type: "assistant",
        uuid: "a1",
        content: "partial",
        usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
      });
      applyEvent(acc, {
        type: "assistant",
        uuid: "a2",
        content: "final content",
        usage: { promptTokens: 2, completionTokens: 4, totalTokens: 6 },
      });

      // Final content is the LAST assistant message's text.
      expect(acc.finalContent).toBe("final content");
      // Token usage is SUMMED across assistant messages.
      expect(acc.tokenUsage).toEqual({
        promptTokens: 7,
        completionTokens: 7,
        totalTokens: 14,
      });
    });

    it("records tool results into the toolCalls ledger", () => {
      const acc = createAccumulator();
      applyEvent(acc, {
        type: "tool_result",
        toolCallId: "t1",
        toolName: "system.readFile",
        content: "file contents",
        isError: false,
        durationMs: 17,
      });
      applyEvent(acc, {
        type: "tool_result",
        toolCallId: "t2",
        toolName: "system.listDir",
        content: "permission denied",
        isError: true,
        durationMs: 4,
      });

      expect(acc.toolCalls).toHaveLength(2);
      expect(acc.toolCalls[0]).toMatchObject({
        name: "system.readFile",
        result: "file contents",
        isError: false,
        durationMs: 17,
      });
      expect(acc.toolCalls[1]).toMatchObject({
        name: "system.listDir",
        isError: true,
      });
    });

    it("flips compacted=true on any tombstone event", () => {
      const acc = createAccumulator();
      expect(acc.compacted).toBe(false);
      applyEvent(acc, {
        type: "tombstone",
        reason: "autocompact",
        tokensFreed: 1024,
        markedAt: Date.now(),
        boundary: "[autocompact] 1k freed",
      });
      expect(acc.compacted).toBe(true);
    });

    it("ignores request_start / tool_use_summary for the base ledger", () => {
      const acc = createAccumulator();
      applyEvent(acc, {
        type: "request_start",
        requestId: "req-1",
        turnIndex: 0,
        timestamp: 123,
      });
      applyEvent(acc, {
        type: "tool_use_summary",
        toolCallIds: ["t1", "t2"],
        summary: "subagent ran 2 tools",
        sessionId: "child-1",
      });
      expect(acc.finalContent).toBe("");
      expect(acc.toolCalls).toHaveLength(0);
      expect(acc.compacted).toBe(false);
      // But both events are retained in `events` for callers that
      // want to replay them downstream.
      expect(acc.events).toHaveLength(2);
    });

    it("extracts text from multimodal content parts", () => {
      const acc = createAccumulator();
      applyEvent(acc, {
        type: "assistant",
        uuid: "a1",
        content: [
          { type: "text", text: "hello " },
          { type: "image", data: "ignored" },
          { type: "text", text: "world" },
        ] as unknown as string,
        // Cast allows the synthetic multimodal content in the test;
        // production events use LLMMessageContentPart.
      });
      expect(acc.finalContent).toBe("hello world");
    });
  });

  describe("drainToLegacyCallbacks", () => {
    it("drains a generator and fires onStreamChunk for each stream_chunk", async () => {
      const events: readonly ExecuteChatYield[] = [
        {
          type: "request_start",
          requestId: "req-1",
          turnIndex: 0,
          timestamp: 1,
        },
        {
          type: "stream_chunk",
          requestId: "req-1",
          content: "partial",
          done: false,
        },
        {
          type: "stream_chunk",
          requestId: "req-1",
          content: "partial two",
          done: true,
        },
        {
          type: "assistant",
          uuid: "a1",
          content: "final",
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        },
      ];
      const onStreamChunk = vi.fn();
      const terminal = makeTerminal();

      const drained = await drainToLegacyCallbacks(
        synthStream(events, terminal),
        { onStreamChunk },
      );

      expect(onStreamChunk).toHaveBeenCalledTimes(2);
      expect(onStreamChunk).toHaveBeenNthCalledWith(1, {
        content: "partial",
        done: false,
        toolCalls: undefined,
      });
      expect(drained.terminal).toEqual(terminal);
      expect(drained.accumulated.finalContent).toBe("final");
    });

    it("works when no onStreamChunk is supplied", async () => {
      const events: readonly ExecuteChatYield[] = [
        {
          type: "assistant",
          uuid: "a1",
          content: "noop",
          usage: {
            promptTokens: 1,
            completionTokens: 1,
            totalTokens: 2,
          },
        },
      ];
      const terminal = makeTerminal({ finalContent: "noop" });
      const drained = await drainToLegacyCallbacks(
        synthStream(events, terminal),
      );
      expect(drained.accumulated.finalContent).toBe("noop");
    });
  });

  describe("buildChatExecutorResultFromEvents", () => {
    it("assembles a ChatExecutorResult from events + terminal + seed", () => {
      const acc = createAccumulator();
      applyEvent(acc, {
        type: "assistant",
        uuid: "a1",
        content: "answer",
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      });
      applyEvent(acc, {
        type: "tool_result",
        toolCallId: "t1",
        toolName: "system.readFile",
        content: "file body",
        isError: false,
        durationMs: 7,
      });
      applyEvent(acc, {
        type: "tombstone",
        reason: "snip",
        tokensFreed: 192,
        markedAt: Date.now(),
      });

      const terminal = makeTerminal({
        finalContent: "", // falls back to accumulator
        toolCalls: [],
        tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      });

      const result = buildChatExecutorResultFromEvents({
        terminal,
        accumulated: acc,
        seed: makeSeed(),
      });

      expect(result.content).toBe("answer");
      expect(result.provider).toBe("mock");
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0]).toMatchObject({
        name: "system.readFile",
        result: "file body",
      });
      expect(result.tokenUsage).toEqual({
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
      });
      expect(result.compacted).toBe(true);
      expect(result.durationMs).toBe(42);
      expect(result.stopReason).toBe("completed");
    });

    it("prefers terminal.finalContent over the last assistant text", () => {
      const acc = createAccumulator();
      applyEvent(acc, {
        type: "assistant",
        uuid: "a1",
        content: "partial draft",
      });
      const terminal = makeTerminal({ finalContent: "final reason override" });
      const result = buildChatExecutorResultFromEvents({
        terminal,
        accumulated: acc,
        seed: makeSeed(),
      });
      expect(result.content).toBe("final reason override");
    });

    it("prefers terminal.tokenUsage when populated", () => {
      const acc = createAccumulator();
      applyEvent(acc, {
        type: "assistant",
        uuid: "a1",
        content: "hi",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      });
      const terminal = makeTerminal({
        tokenUsage: {
          promptTokens: 100,
          completionTokens: 50,
          totalTokens: 150,
        },
      });
      const result = buildChatExecutorResultFromEvents({
        terminal,
        accumulated: acc,
        seed: makeSeed(),
      });
      expect(result.tokenUsage.totalTokens).toBe(150);
    });
  });
});
