import { describe, expect, it } from "vitest";
import {
  isSessionUserMessageNotification,
  trimBufferedSessionEvents,
} from "../../src/app-server/agent-cli.js";
import type { JsonObject } from "../../src/app-server/protocol/index.js";

function userMessage(id: string): JsonObject {
  return {
    jsonrpc: "2.0",
    method: "event.session_event",
    params: {
      sessionId: "s1",
      event: {
        id,
        type: "user_message",
        payload: { message: "hello", displayText: "hello" },
      },
    },
  };
}

function delta(i: number): JsonObject {
  return {
    jsonrpc: "2.0",
    method: "event.message_chunk",
    params: { sessionId: "s1", delta: `x${i}` },
  };
}

describe("session event pre-subscribe buffer", () => {
  it("recognizes user_message session events", () => {
    expect(isSessionUserMessageNotification(userMessage("u1"))).toBe(true);
    expect(isSessionUserMessageNotification(delta(0))).toBe(false);
  });

  it("never drops the first user_message when trimming under a flood of deltas", () => {
    const buffered: JsonObject[] = [userMessage("u1")];
    for (let i = 0; i < 50; i++) buffered.push(delta(i));
    trimBufferedSessionEvents(buffered, 10);
    expect(buffered.length).toBe(10);
    expect(
      buffered.some((event) => isSessionUserMessageNotification(event)),
    ).toBe(true);
    expect(buffered[0]).toMatchObject({
      method: "event.session_event",
      params: { event: { type: "user_message" } },
    });
  });
});
