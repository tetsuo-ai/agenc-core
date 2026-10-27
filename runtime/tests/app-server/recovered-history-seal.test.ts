import { describe, expect, it } from "vitest";

import { hydrateRecoveredSessionHistory } from "../../src/app-server/background-agent-runner/tool-recovery.js";
import { rolloutHasTranscriptReset } from "../../src/app-server/background-agent-runner/journal-reconstruction.js";
import type { LLMMessage } from "../../src/llm/types.js";
import { llmMessageToCheckpointResponseItem } from "../../src/session/message-history-conversion.js";
import type { RolloutItem } from "../../src/session/rollout-item.js";
import { normalizeHistoryMessages } from "../../src/session/session.js";
import {
  createToolResultIntegrity,
  verifyToolResultIntegrity,
} from "../../src/session/tool-result-integrity.js";

// Live on RC4.3 (2026-10-14): after /clear and an idle daemon restart, the
// restore refilled the empty history from a client snapshot with 20 rebuilt
// tool results that had no integrity seal. Every turn treats prior history as
// already persisted, so the next turn that wrote a durable checkpoint failed
// with "checkpoint v2 requires every tool result to be sealed", and the
// unanswered tool call it left behind broke the turn after it as well.

const RUN_ID = "conv-restored";

function fakeSession(history: unknown[], conversationId: unknown = RUN_ID) {
  const state = { history };
  return {
    session: {
      conversationId,
      state: {
        with: async (fn: (value: { history?: unknown }) => void | Promise<void>) => {
          await fn(state);
        },
      },
    } as never,
    state,
  };
}

function toolPair(callId: string, body: string): LLMMessage[] {
  return [
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: callId, name: "FileRead", arguments: "{}" }],
    },
    { role: "tool", content: body, toolCallId: callId, toolName: "FileRead" },
  ];
}

/** What the next turn's first checkpoint does with prior history. */
function checkpointAccepts(history: unknown[]): boolean {
  return normalizeHistoryMessages(history)
    .map((message) => llmMessageToCheckpointResponseItem(message))
    .every((item) => item.role !== "tool" || item.toolResultIntegrity !== undefined);
}

describe("recovered history hydration", () => {
  it("seals snapshot tool results that fill an empty history", async () => {
    const { session, state } = fakeSession([]);
    await hydrateRecoveredSessionHistory(session, {
      initialMessages: toolPair("call-1", "file body"),
      replayedMessages: [],
    });

    const tool = (state.history as LLMMessage[]).find((message) => message.role === "tool");
    const integrity = tool?.runtimeOnly?.toolResultIntegrity;
    expect(integrity).toBeDefined();
    expect(
      verifyToolResultIntegrity({
        integrity,
        expectedRunId: RUN_ID,
        toolCallId: "call-1",
        content: "file body",
      }).status,
    ).toBe("valid");
    expect(checkpointAccepts(state.history)).toBe(true);
  });

  it("seals replayed tool results appended to a live history", async () => {
    const sealed = createToolResultIntegrity({
      runId: RUN_ID,
      toolCallId: "call-live",
      content: "live body",
    });
    const live: unknown[] = [
      { role: "user", content: "earlier" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call-live", name: "FileRead", arguments: "{}" }],
      },
      {
        role: "tool",
        content: "live body",
        toolCallId: "call-live",
        toolName: "FileRead",
        runtimeOnly: { toolResultIntegrity: sealed },
      },
    ];
    const { session, state } = fakeSession(live);
    await hydrateRecoveredSessionHistory(session, {
      initialMessages: [],
      replayedMessages: toolPair("replay-1", "replayed body"),
    });

    const history = state.history as LLMMessage[];
    expect(history).toHaveLength(5);
    // An existing seal is kept exactly as it was.
    expect(history[2]?.runtimeOnly?.toolResultIntegrity).toEqual(sealed);
    expect(history[4]?.runtimeOnly?.toolResultIntegrity?.toolCallId).toBe("replay-1");
    expect(checkpointAccepts(state.history)).toBe(true);
  });

  it("keeps a seal stored in the persisted shape", async () => {
    const persisted = createToolResultIntegrity({
      runId: RUN_ID,
      toolCallId: "call-persisted",
      content: "persisted body",
    });
    const { session, state } = fakeSession([
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call-persisted", name: "FileRead", arguments: "{}" }],
      },
      {
        role: "tool",
        content: "persisted body",
        toolCallId: "call-persisted",
        toolResultIntegrity: persisted,
      },
    ]);
    await hydrateRecoveredSessionHistory(session, {
      initialMessages: [],
      replayedMessages: toolPair("replay-2", "replayed body"),
    });

    const history = state.history as Array<LLMMessage & { toolResultIntegrity?: unknown }>;
    expect(history[1]?.toolResultIntegrity).toEqual(persisted);
    expect(history[1]?.runtimeOnly?.toolResultIntegrity).toBeUndefined();
    expect(checkpointAccepts(state.history)).toBe(true);
  });

  it("leaves history unsealed when the session has no run id to seal under", async () => {
    const { session, state } = fakeSession([], null);
    await hydrateRecoveredSessionHistory(session, {
      initialMessages: toolPair("call-3", "body"),
      replayedMessages: [],
    });
    const tool = (state.history as LLMMessage[]).find((message) => message.role === "tool");
    expect(tool?.runtimeOnly?.toolResultIntegrity).toBeUndefined();
  });
});

describe("rolloutHasTranscriptReset", () => {
  const event = (type: string, seq: number): RolloutItem =>
    ({
      type: "event_msg",
      payload: {
        eventId: `event:${seq}`,
        id: `event:${seq}`,
        seq,
        msg: { type, payload: type === "history_cleared" ? { timestamp: 1 } : {} },
      },
    }) as unknown as RolloutItem;

  it("is false for a conversation that was never reset", () => {
    expect(rolloutHasTranscriptReset([event("turn_started", 1)])).toBe(false);
  });

  it("is true once the user cleared the conversation", () => {
    expect(
      rolloutHasTranscriptReset([event("turn_started", 1), event("history_cleared", 2)]),
    ).toBe(true);
  });

  it("is true after a transcript reset", () => {
    expect(rolloutHasTranscriptReset([event("transcript_epoch", 3)])).toBe(true);
  });
});
