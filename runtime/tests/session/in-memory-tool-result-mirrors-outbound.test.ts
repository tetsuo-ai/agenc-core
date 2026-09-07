/**
 * Regression: the live in-memory history must never diverge from the request
 * that just went out (soak F74, agenc-core #2244).
 *
 * `boundInMemoryToolResultContent` shrinks `state.messages` after each phase
 * iteration so the session's heap does not grow with turn count. It used to
 * decide WHICH results to clear on its own, with constants hand-synced to
 * microcompact and no pressure gate, so a result the wire was still sending in
 * full got replaced by a marker in memory. The next request then rendered a
 * marker where the previous one had rendered the body, which rewrites an
 * already-cached prefix: the provider re-reads every token after that offset.
 * A traced six-goal desktop soak run re-billed 438,986 input tokens this way,
 * up to 51,725 in a single event.
 *
 * The bound is now a CONSUMER of the outbound projection. It may adopt exactly
 * the bytes the last request carried, or clear results before a compaction
 * boundary that no future request carries at all. Nothing else.
 */

import { describe, expect, test } from "vitest";

import { boundInMemoryToolResultContent } from "../../src/session/run-turn-query-messages.js";
import { CLEARED_MARKER as BARE_MARKER } from "./helpers/cleared-tool-result-marker.js";
import type { LLMMessage } from "../../src/llm/types.js";

const BIG = "x".repeat(20_000);
const MICROCOMPACT_MARKER =
  "[microcompact:1] Older tool output compressed; original length 20,000 characters.";

// `exec_command` is compactable but not path-bearing, so these fixtures
// exercise the keep-recent window without the latest-read-per-path retention
// that would protect every distinct file in a FileRead fixture.
function shellCall(id: string): LLMMessage {
  return {
    role: "assistant",
    content: "",
    toolCalls: [
      { id, name: "exec_command", arguments: JSON.stringify({ cmd: "npm test" }) },
    ],
  } as LLMMessage;
}

function shellResult(id: string, content: string): LLMMessage {
  return {
    role: "tool",
    content,
    toolCallId: id,
    toolName: "exec_command",
  } as LLMMessage;
}

/** The tool results of a history, as the outbound projection would carry them. */
function outboundOf(
  messages: readonly LLMMessage[],
  rewrite: (message: LLMMessage) => LLMMessage = (message) => ({ ...message }),
): LLMMessage[] {
  return messages
    .filter((message) => message.toolCallId !== undefined)
    .map(rewrite);
}

/** Bound the whole history as `syncSessionState` does once everything is persisted. */
function boundAll(
  messages: LLMMessage[],
  outbound: readonly LLMMessage[] | undefined,
): number {
  return boundInMemoryToolResultContent(messages, messages.length, outbound);
}

/** Enough results that the oldest fall outside the keep-recent window. */
function historyOfReads(count: number): LLMMessage[] {
  const messages: LLMMessage[] = [];
  for (let i = 1; i <= count; i += 1) {
    messages.push(shellCall(`call_${i}`));
    messages.push(shellResult(`call_${i}`, `${BIG}_${i}`));
  }
  return messages;
}

describe("boundInMemoryToolResultContent mirrors the outbound view", () => {
  test("a result the request still carries in full is left full in memory", () => {
    const messages = historyOfReads(12);
    // The wire carried every result whole: nothing may be cleared, however old.
    const cleared = boundAll(messages, outboundOf(messages));

    expect(cleared).toBe(0);
    const bodies = messages.filter(
      (message) =>
        message.toolCallId !== undefined &&
        typeof message.content === "string" &&
        message.content.startsWith("x".repeat(100)),
    );
    expect(bodies).toHaveLength(12);
  });

  test("a result the request carried shrunken is adopted byte for byte", () => {
    const messages = historyOfReads(12);
    const cleared = boundAll(
      messages,
      outboundOf(messages, (message) =>
        message.toolCallId === "call_1"
          ? { ...message, content: MICROCOMPACT_MARKER }
          : { ...message },
      ),
    );

    expect(cleared).toBe(1);
    const first = messages.find((message) => message.toolCallId === "call_1");
    // The exact outbound bytes, NOT this module's own marker: anything else
    // would change the next request's prefix.
    expect(first?.content).toBe(MICROCOMPACT_MARKER);
    expect(first?.content).not.toBe(BARE_MARKER);
  });

  test("results before a compaction boundary are cleared, later ones are not", () => {
    const before = historyOfReads(3);
    const boundary = {
      role: "developer",
      content: "compacted",
      runtimeOnly: {
        compactionHistory: {
          version: 1,
          kind: "boundary",
          attempt_id: "attempt-1",
          summary_sha256: "a".repeat(64),
        },
      },
    } as unknown as LLMMessage;
    const after = historyOfReads(3).map((message) =>
      message.toolCallId !== undefined
        ? { ...message, toolCallId: `${message.toolCallId}_after` }
        : {
            ...message,
            toolCalls: (message.toolCalls ?? []).map((call) => ({
              ...call,
              id: `${call.id}_after`,
            })),
          },
    );
    const messages = [...before, boundary, ...after];
    // The outbound view starts after the boundary and carried everything whole.
    const cleared = boundAll(messages, outboundOf(after));

    // Exactly the three pre-boundary results: never sent again, so free.
    expect(cleared).toBe(3);
    for (const message of messages.slice(0, before.length)) {
      if (message.toolCallId === undefined) continue;
      expect(message.content).toBe(BARE_MARKER);
    }
    for (const message of messages.slice(before.length + 1)) {
      if (message.toolCallId === undefined) continue;
      expect(message.content).not.toBe(BARE_MARKER);
    }
  });

  test("a result absent from the outbound view after the boundary is left alone", () => {
    const messages = historyOfReads(12);
    // No boundary and an outbound view that simply does not mention call_1:
    // the safe reading is that a future request may still carry it.
    const cleared = boundAll(
      messages,
      outboundOf(messages).filter(
        (message) => message.toolCallId !== "call_1",
      ),
    );

    expect(cleared).toBe(0);
    const first = messages.find((message) => message.toolCallId === "call_1");
    expect(first?.content).toBe(`${BIG}_1`);
  });

  test("not-yet-persisted tail messages are never touched", () => {
    const messages = historyOfReads(12);
    // boundUpToIndex 0: nothing has been persisted yet.
    const cleared = boundInMemoryToolResultContent(
      messages,
      0,
      outboundOf(messages, (message) => ({
        ...message,
        content: MICROCOMPACT_MARKER,
      })),
    );

    expect(cleared).toBe(0);
  });

  test("no outbound view at all clears nothing without a boundary", () => {
    const messages = historyOfReads(12);
    const cleared = boundAll(messages, undefined);
    expect(cleared).toBe(0);
  });
});
