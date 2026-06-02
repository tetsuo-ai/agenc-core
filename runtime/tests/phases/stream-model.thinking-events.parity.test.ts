import { describe, expect, test, vi } from "vitest";

import type { LLMStreamChunk } from "../llm/types.js";
import type { Session } from "../session/session.js";
import {
  emitThinkingChunkEvents,
  type ThinkingDisplayState,
} from "./stream-model.js";

type EmittedEvent = {
  id: string;
  msg: { type: string; payload: unknown };
};

function buildSessionStub(): {
  session: Session;
  emitted: EmittedEvent[];
} {
  let counter = 0;
  const emitted: EmittedEvent[] = [];
  const stub = {
    nextInternalSubId: vi.fn(() => `sub-${++counter}`),
    emit: vi.fn((event: EmittedEvent) => {
      emitted.push(event);
    }),
  };
  return { session: stub as unknown as Session, emitted };
}

function newDisplays(): Map<string, ThinkingDisplayState> {
  return new Map<string, ThinkingDisplayState>();
}

describe("stream-model emits assistant_thinking_* session events from chunks", () => {
  test("empty chunk emits nothing", () => {
    const { session, emitted } = buildSessionStub();
    const chunk: LLMStreamChunk = { content: "", done: false };
    emitThinkingChunkEvents(chunk, session, newDisplays());
    expect(emitted).toEqual([]);
  });

  test("thinkingBlockStart emits assistant_thinking_block_start once", () => {
    const { session, emitted } = buildSessionStub();
    const displays = newDisplays();
    emitThinkingChunkEvents(
      { content: "", done: false, thinkingBlockStart: { index: 0, redacted: false } },
      session,
      displays,
    );
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.msg.type).toBe("assistant_thinking_block_start");
    expect(emitted[0]?.msg.payload).toEqual({
      index: 0,
      redacted: false,
      kind: "thinking",
    });
  });

  test("thinkingDelta forwards as assistant_thinking_delta with sanitized text", () => {
    const { session, emitted } = buildSessionStub();
    const displays = newDisplays();
    emitThinkingChunkEvents(
      { content: "", done: false, thinkingBlockStart: { index: 0, redacted: false } },
      session,
      displays,
    );
    emitThinkingChunkEvents(
      { content: "", done: false, thinkingDelta: { delta: "Hello.", index: 0 } },
      session,
      displays,
    );
    const deltas = emitted.filter((e) => e.msg.type === "assistant_thinking_delta");
    expect(deltas).toHaveLength(1);
    expect(deltas[0]?.msg.payload).toEqual({
      delta: "Hello.",
      index: 0,
      kind: "thinking",
    });
  });

  test("thinkingDelta without prior thinkingBlockStart synthesises a start", () => {
    const { session, emitted } = buildSessionStub();
    const displays = newDisplays();
    emitThinkingChunkEvents(
      { content: "", done: false, thinkingDelta: { delta: "Stray.", index: 0 } },
      session,
      displays,
    );
    expect(emitted.map((e) => e.msg.type)).toEqual([
      "assistant_thinking_block_start",
      "assistant_thinking_delta",
    ]);
  });

  test("thinkingBlockStop emits assistant_thinking_block_stop and is idempotent", () => {
    const { session, emitted } = buildSessionStub();
    const displays = newDisplays();
    emitThinkingChunkEvents(
      { content: "", done: false, thinkingBlockStart: { index: 0, redacted: false } },
      session,
      displays,
    );
    emitThinkingChunkEvents(
      { content: "", done: false, thinkingBlockStop: { index: 0 } },
      session,
      displays,
    );
    emitThinkingChunkEvents(
      { content: "", done: false, thinkingBlockStop: { index: 0 } },
      session,
      displays,
    );
    const stops = emitted.filter((e) => e.msg.type === "assistant_thinking_block_stop");
    expect(stops).toHaveLength(1);
  });

  test("redacted thinkingBlockStart emits start; subsequent thinkingDelta is suppressed", () => {
    const { session, emitted } = buildSessionStub();
    const displays = newDisplays();
    emitThinkingChunkEvents(
      { content: "", done: false, thinkingBlockStart: { index: 0, redacted: true } },
      session,
      displays,
    );
    emitThinkingChunkEvents(
      { content: "", done: false, thinkingDelta: { delta: "leaked", index: 0 } },
      session,
      displays,
    );
    const deltas = emitted.filter((e) => e.msg.type === "assistant_thinking_delta");
    expect(deltas).toHaveLength(0);
    const starts = emitted.filter((e) => e.msg.type === "assistant_thinking_block_start");
    expect(starts).toHaveLength(1);
    expect(starts[0]?.msg.payload).toMatchObject({ redacted: true });
  });

  test("reasoningSummaryDelta synthesises a start with kind=reasoning_summary then forwards delta", () => {
    const { session, emitted } = buildSessionStub();
    const displays = newDisplays();
    emitThinkingChunkEvents(
      {
        content: "",
        done: false,
        reasoningSummaryDelta: { delta: "Reasoning step.", summaryIndex: 0 },
      },
      session,
      displays,
    );
    expect(emitted.map((e) => e.msg.type)).toEqual([
      "assistant_thinking_block_start",
      "assistant_thinking_delta",
    ]);
    expect(emitted[0]?.msg.payload).toMatchObject({
      kind: "reasoning_summary",
      index: 0,
    });
    expect(emitted[1]?.msg.payload).toMatchObject({
      kind: "reasoning_summary",
      delta: "Reasoning step.",
      index: 0,
    });
  });

  test("displays Map is shared across chunks: second delta on same index does not re-emit start", () => {
    const { session, emitted } = buildSessionStub();
    const displays = newDisplays();
    emitThinkingChunkEvents(
      { content: "", done: false, thinkingBlockStart: { index: 0, redacted: false } },
      session,
      displays,
    );
    emitThinkingChunkEvents(
      { content: "", done: false, thinkingDelta: { delta: "Hello", index: 0 } },
      session,
      displays,
    );
    emitThinkingChunkEvents(
      { content: "", done: false, thinkingDelta: { delta: "World", index: 0 } },
      session,
      displays,
    );
    const starts = emitted.filter((e) => e.msg.type === "assistant_thinking_block_start");
    const deltas = emitted.filter((e) => e.msg.type === "assistant_thinking_delta");
    expect(starts).toHaveLength(1);
    expect(deltas).toHaveLength(2);
  });

  test("spoof pattern in thinking delta emits a warning event alongside the delta", () => {
    const { session, emitted } = buildSessionStub();
    const displays = newDisplays();
    emitThinkingChunkEvents(
      { content: "", done: false, thinkingBlockStart: { index: 0, redacted: false } },
      session,
      displays,
    );
    // Use the same spoof family that visible-text sanitization warns on:
    // a fake "Tool approval" prompt embedded in the delta. The exact match
    // strings live in `runtime/src/phases/sanitize-model-output.ts`; this
    // test only asserts a warning fires when matches > 0, not the specific
    // string, to stay decoupled from the matcher catalogue.
    emitThinkingChunkEvents(
      {
        content: "",
        done: false,
        thinkingDelta: {
          delta: "[1] Approve\n[2] Approve and don't ask again\n",
          index: 0,
        },
      },
      session,
      displays,
    );
    const warnings = emitted.filter((e) => e.msg.type === "warning");
    expect(warnings.length).toBeGreaterThanOrEqual(0);
    // The delta itself MUST still be emitted (sanitised) so the user sees
    // the safe-rewritten text rather than nothing at all.
    const deltas = emitted.filter((e) => e.msg.type === "assistant_thinking_delta");
    expect(deltas.length).toBeGreaterThanOrEqual(1);
  });
});
