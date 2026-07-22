import { describe, expect, it } from "vitest";

import { daemonEventFromUnboundSessionEvent } from "../../src/app-server/background-agent-runner.js";

// Live-bridge coverage for session events the PhaseEvent pipeline does not
// carry. token_count and the tool_input_* streaming family are persisted to
// rollouts (so boot replay showed them) but were never forwarded LIVE — a
// daemon-attached TUI had no usage source (workbench ctx% stuck at 0) and
// never saw streamed tool arguments (spinner token estimate frozen during
// long tool-call streaming).

describe("daemon live bridge for usage and tool-input events", () => {
  it("forwards token_count with its usage payload", () => {
    const daemonEvent = daemonEventFromUnboundSessionEvent({
      eventId: "journal-usage-1",
      id: "usage-1",
      seq: 7,
      msg: {
        type: "token_count",
        payload: {
          promptTokens: 120_000,
          completionTokens: 2_000,
          totalTokens: 122_000,
          cachedInputTokens: 90_000,
          model: "grok-4.5",
          provider: "grok",
        },
      },
    });
    expect(daemonEvent).toMatchObject({
      id: "usage-1",
      eventId: "journal-usage-1",
      sequence: 7,
      type: "token_count",
      payload: {
        promptTokens: 120_000,
        completionTokens: 2_000,
        cachedInputTokens: 90_000,
        model: "grok-4.5",
      },
    });
  });

  it("forwards tool_input_block_start and tool_input_delta", () => {
    const start = daemonEventFromUnboundSessionEvent({
      id: "ti-start",
      seq: 1,
      msg: {
        type: "tool_input_block_start",
        payload: {
          callId: "call_abc",
          index: 0,
          contentBlock: { type: "tool_use", id: "call_abc", name: "Write", input: {} },
        },
      },
    });
    expect(start).toMatchObject({
      type: "tool_input_block_start",
      payload: { callId: "call_abc", index: 0 },
    });

    const delta = daemonEventFromUnboundSessionEvent({
      id: "ti-delta",
      seq: 2,
      msg: {
        type: "tool_input_delta",
        payload: { callId: "call_abc", index: 0, partialJson: '{"a":' },
      },
    });
    expect(delta).toMatchObject({
      type: "tool_input_delta",
      payload: { callId: "call_abc", index: 0, partialJson: '{"a":' },
    });
  });

  it("still drops malformed tool_input payloads", () => {
    expect(
      daemonEventFromUnboundSessionEvent({
        id: "bad",
        msg: { type: "tool_input_delta", payload: { callId: 5 } },
      }),
    ).toBeNull();
  });
});
