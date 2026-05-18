import { describe, expect, test, vi } from "vitest";

import type { LLMStreamChunk } from "../llm/types.js";
import type { Session } from "../session/session.js";
import { emitToolInputChunkEvents } from "./stream-model.js";

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
    nextInternalSubId: vi.fn(() => `internal-${++counter}`),
    emit: vi.fn((event: EmittedEvent) => {
      emitted.push(event);
    }),
  };
  return { session: stub as unknown as Session, emitted };
}

describe("R6 stream-model emits tool_input_block_start / tool_input_delta session events for chunks", () => {
  test("E6.7 chunk without toolInputBlockStart and without toolInputDelta emits nothing (only the existing assistant-text and tool-call paths fire elsewhere)", () => {
    const { session, emitted } = buildSessionStub();
    const chunk: LLMStreamChunk = { content: "hi", done: false };
    emitToolInputChunkEvents(chunk, session);
    expect(emitted).toEqual([]);
  });

  test("B6.6 chunk.toolInputBlockStart is forwarded as a tool_input_block_start session event with the payload preserved verbatim", () => {
    const { session, emitted } = buildSessionStub();
    const chunk: LLMStreamChunk = {
      content: "",
      done: false,
      toolInputBlockStart: {
        callId: "toolu_a",
        index: 0,
        contentBlock: {
          type: "tool_use",
          id: "toolu_a",
          name: "Bash",
          input: {},
        },
      },
    };
    emitToolInputChunkEvents(chunk, session);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.msg.type).toBe("tool_input_block_start");
    expect(emitted[0]?.msg.payload).toEqual({
      callId: "toolu_a",
      index: 0,
      contentBlock: {
        type: "tool_use",
        id: "toolu_a",
        name: "Bash",
        input: {},
      },
    });
  });

  test("B6.6 chunk.toolInputDelta is forwarded as a tool_input_delta session event with the payload preserved verbatim", () => {
    const { session, emitted } = buildSessionStub();
    const chunk: LLMStreamChunk = {
      content: "",
      done: false,
      toolInputDelta: {
        callId: "toolu_a",
        index: 0,
        partialJson: '{"k":1}',
      },
    };
    emitToolInputChunkEvents(chunk, session);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.msg.type).toBe("tool_input_delta");
    expect(emitted[0]?.msg.payload).toEqual({
      callId: "toolu_a",
      index: 0,
      partialJson: '{"k":1}',
    });
  });

  test("E6.8 a chunk that sets BOTH new fields emits BOTH events in order (block_start before delta) so the bridge accumulator sees the seed before the partial JSON", () => {
    const { session, emitted } = buildSessionStub();
    const chunk: LLMStreamChunk = {
      content: "",
      done: false,
      toolInputBlockStart: {
        callId: "toolu_a",
        index: 0,
        contentBlock: {
          type: "tool_use",
          id: "toolu_a",
          name: "Bash",
          input: {},
        },
      },
      toolInputDelta: {
        callId: "toolu_a",
        index: 0,
        partialJson: '{"k":1}',
      },
    };
    emitToolInputChunkEvents(chunk, session);
    expect(emitted.map((e) => e.msg.type)).toEqual([
      "tool_input_block_start",
      "tool_input_delta",
    ]);
  });

  test("E6.8 chunks emitted by providers without the new fields never produce streaming-tool-use session events", () => {
    const { session, emitted } = buildSessionStub();
    const chunks: LLMStreamChunk[] = [
      { content: "hello", done: false },
      { content: "", done: false, toolCalls: [{ id: "x", name: "Y", arguments: "{}" }] },
      { content: "", done: false, resetBuffer: true },
      { content: "", done: true },
    ];
    for (const chunk of chunks) emitToolInputChunkEvents(chunk, session);
    expect(emitted).toEqual([]);
  });
});
