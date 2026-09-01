import { describe, expect, it } from "vitest";

import { sessionTranscriptV2FromRollout } from "../../src/app-server/background-agent-runner.js";
import type { Event, EventMsg } from "../../src/session/event-log.js";
import type { RolloutItem } from "../../src/session/rollout-item.js";

function event(seq: number, eventId: string, msg: EventMsg): RolloutItem {
  const payload: Event = { id: eventId, eventId, seq, msg };
  return { type: "event_msg", payload };
}

describe("session.transcript.v2 durable projection", () => {
  it("keeps a migrated response_item prefix when canonical events are appended", () => {
    const prefix: RolloutItem[] = [
      {
        type: "response_item",
        payload: { role: "user", content: "legacy question" },
      },
      {
        type: "response_item",
        payload: { role: "assistant", content: "legacy answer" },
      },
      event(10, "user-new", {
        type: "user_message",
        payload: {
          message: "new question",
          messageId: "client-new",
          acceptedAt: "2026-08-17T00:00:00.000Z",
        },
      }),
      event(11, "turn-new", {
        type: "turn_started",
        payload: { turnId: "turn-new" },
      }),
      event(12, "assistant-one", {
        type: "agent_message",
        payload: { message: "ok" },
      }),
      event(13, "assistant-two", {
        type: "agent_message",
        payload: { message: "ok" },
      }),
    ];

    const first = sessionTranscriptV2FromRollout(prefix, "session-1", "run-1");
    expect(first).toMatchObject({
      schemaVersion: 2,
      sessionId: "session-1",
      runId: "run-1",
      historyEpoch: "history:run-1:initial",
      asOfSequence: 13,
    });
    expect(first.messages.map(({ role, text }) => ({ role, text }))).toEqual([
      { role: "user", text: "legacy question" },
      { role: "assistant", text: "legacy answer" },
      { role: "user", text: "new question" },
      { role: "assistant", text: "ok" },
      { role: "assistant", text: "ok" },
    ]);
    expect(first.messages.slice(0, 2)).toEqual([
      expect.objectContaining({
        messageId: "legacy:initial:0",
        committedSequence: 0,
      }),
      expect.objectContaining({
        messageId: "legacy:initial:1",
        committedSequence: 0,
      }),
    ]);
    expect(first.messages.slice(2)).toEqual([
      expect.objectContaining({
        messageId: "client-new",
        clientMessageId: "client-new",
        turnId: "turn-new",
        committedSequence: 10,
      }),
      expect.objectContaining({
        messageId: "assistant:turn-new:0",
        clientMessageId: "client-new",
        committedSequence: 12,
      }),
      expect.objectContaining({
        messageId: "assistant:turn-new:1",
        clientMessageId: "client-new",
        committedSequence: 13,
      }),
    ]);

    const afterAppend = sessionTranscriptV2FromRollout(
      [
        ...prefix,
        event(14, "turn-complete", {
          type: "turn_complete",
          payload: { turnId: "turn-new", lastAgentMessage: "ok" },
        }),
      ],
      "session-1",
      "run-1",
    );
    expect(afterAppend.asOfSequence).toBe(14);
    expect(afterAppend.messages).toEqual(first.messages);
  });

  it("rebuilds from each compact/rewind replacement and advances a stable epoch", () => {
    const compacted: RolloutItem[] = [
      {
        type: "response_item",
        payload: { role: "user", content: "discarded branch" },
      },
      {
        type: "compacted",
        payload: {
          message: "summary",
          replacementHistory: [
            { role: "user", content: "kept question" },
            { role: "assistant", content: "summary answer" },
          ],
        },
      },
      event(20, "epoch-compact", {
        type: "transcript_epoch",
        payload: { reason: "partial_compact" },
      }),
      event(21, "user-after-compact", {
        type: "user_message",
        payload: {
          message: "after compact",
          messageId: "client-after-compact",
        },
      }),
      event(22, "turn-after-compact", {
        type: "turn_started",
        payload: { turnId: "turn-after-compact" },
      }),
      event(23, "answer-after-compact", {
        type: "agent_message",
        payload: { message: "fresh answer" },
      }),
    ];

    const compactSnapshot = sessionTranscriptV2FromRollout(
      compacted,
      "session-1",
      "run-1",
    );
    expect(compactSnapshot.historyEpoch).toBe("history:run-1:epoch-compact");
    expect(compactSnapshot.messages.map((message) => message.text)).toEqual([
      "kept question",
      "summary answer",
      "after compact",
      "fresh answer",
    ]);
    expect(compactSnapshot.messages[0]).toMatchObject({
      messageId: "replacement:epoch-compact:0",
      committedSequence: 20,
    });
    expect(
      compactSnapshot.messages.some(
        (message) => message.text === "discarded branch",
      ),
    ).toBe(false);

    const rewound: RolloutItem[] = [
      ...compacted,
      {
        type: "compacted",
        payload: {
          message: "Conversation rewound",
          replacementHistory: [{ role: "user", content: "kept question" }],
        },
      },
      event(30, "epoch-rewind", {
        type: "transcript_epoch",
        payload: { reason: "rewind" },
      }),
    ];
    const rewindSnapshot = sessionTranscriptV2FromRollout(
      rewound,
      "session-1",
      "run-1",
    );
    expect(rewindSnapshot.historyEpoch).toBe("history:run-1:epoch-rewind");
    expect(rewindSnapshot.asOfSequence).toBe(30);
    expect(rewindSnapshot.messages).toEqual([
      expect.objectContaining({
        messageId: "replacement:epoch-rewind:0",
        text: "kept question",
        committedSequence: 30,
      }),
    ]);

    expect(
      sessionTranscriptV2FromRollout([...rewound], "session-1", "run-1"),
    ).toEqual(rewindSnapshot);
  });

  it("rebuilds per-turn results with timing and summed usage", () => {
    const items: RolloutItem[] = [
      event(10, "user-1", {
        type: "user_message",
        payload: { message: "question", messageId: "client-1" },
      }),
      event(11, "turn-1", {
        type: "turn_started",
        payload: { turnId: "turn-1", startedAt: 1_000 },
      }),
      event(12, "tokens-1a", {
        type: "token_count",
        payload: {
          promptTokens: 100,
          completionTokens: 40,
          totalTokens: 140,
          model: "grok-4.6",
          provider: "grok",
        },
      }),
      event(13, "tokens-1b", {
        type: "token_count",
        payload: { promptTokens: 200, completionTokens: 60, totalTokens: 260 },
      }),
      event(14, "answer-1", {
        type: "agent_message",
        payload: { message: "answer" },
      }),
      event(15, "complete-1", {
        type: "turn_complete",
        payload: { turnId: "turn-1", durationMs: 4_137 },
      }),
      event(16, "user-2", {
        type: "user_message",
        payload: { message: "again", messageId: "client-2" },
      }),
      event(17, "turn-2", {
        type: "turn_started",
        payload: { turnId: "turn-2", startedAt: 10_000 },
      }),
      event(18, "abort-2", {
        type: "turn_aborted",
        payload: { turnId: "turn-2", reason: "daemon shutdown" },
      }),
    ];

    const snapshot = sessionTranscriptV2FromRollout(items, "session-1", "run-1");
    expect(snapshot.turnResults).toEqual([
      {
        turnId: "turn-1",
        committedSequence: 15,
        outcome: "completed",
        durationMs: 4_137,
        inputTokens: 300,
        outputTokens: 100,
        totalTokens: 400,
        model: "grok-4.6",
        provider: "grok",
      },
      {
        turnId: "turn-2",
        committedSequence: 18,
        outcome: "aborted",
      },
    ]);
  });

  it("falls back to the started/completed stamps and skips mismatched terminals", () => {
    const items: RolloutItem[] = [
      event(10, "user-1", {
        type: "user_message",
        payload: { message: "question", messageId: "client-1" },
      }),
      event(11, "turn-1", {
        type: "turn_started",
        payload: { turnId: "turn-1", startedAt: 1_000 },
      }),
      // Stale terminal from an unrelated turn must not close this one.
      event(12, "stale-complete", {
        type: "turn_complete",
        payload: { turnId: "turn-0", durationMs: 99 },
      }),
      event(13, "complete-1", {
        type: "turn_complete",
        payload: { turnId: "turn-1", completedAt: 5_500 },
      }),
    ];

    const snapshot = sessionTranscriptV2FromRollout(items, "session-1", "run-1");
    expect(snapshot.turnResults).toEqual([
      {
        turnId: "turn-1",
        committedSequence: 13,
        outcome: "completed",
        durationMs: 4_500,
      },
    ]);
  });

  it("keeps the turn open across a mid-turn error until the real terminal", () => {
    const items: RolloutItem[] = [
      event(10, "user-1", {
        type: "user_message",
        payload: { message: "question", messageId: "client-1" },
      }),
      event(11, "turn-1", {
        type: "turn_started",
        payload: { turnId: "turn-1", startedAt: 1_000 },
      }),
      event(12, "tokens-before", {
        type: "token_count",
        payload: {
          promptTokens: 100,
          completionTokens: 40,
          totalTokens: 140,
          model: "grok-4.6",
          provider: "grok",
        },
      }),
      event(13, "stop-hook-threw", {
        type: "error",
        payload: {
          cause: "stop_hook_threw",
          message: "lint threw",
          turnId: "turn-1",
        },
      }),
      event(14, "tokens-after", {
        type: "token_count",
        payload: { promptTokens: 200, completionTokens: 60, totalTokens: 260 },
      }),
      event(15, "answer-1", {
        type: "agent_message",
        payload: { message: "answer after hook throw" },
      }),
      event(16, "complete-1", {
        type: "turn_complete",
        payload: { turnId: "turn-1", durationMs: 4_137 },
      }),
    ];

    const snapshot = sessionTranscriptV2FromRollout(items, "session-1", "run-1");
    expect(snapshot.turnResults).toEqual([
      {
        turnId: "turn-1",
        committedSequence: 16,
        outcome: "completed",
        durationMs: 4_137,
        inputTokens: 300,
        outputTokens: 100,
        totalTokens: 400,
        model: "grok-4.6",
        provider: "grok",
      },
    ]);
    expect(snapshot.messages.at(-1)).toMatchObject({
      role: "assistant",
      text: "answer after hook throw",
      turnId: "turn-1",
      committedSequence: 15,
    });
  });

  it("omits turnResults entirely when the rollout closed no turns", () => {
    const snapshot = sessionTranscriptV2FromRollout(
      [
        event(10, "user-1", {
          type: "user_message",
          payload: { message: "question", messageId: "client-1" },
        }),
        event(11, "turn-1", {
          type: "turn_started",
          payload: { turnId: "turn-1", startedAt: 1_000 },
        }),
        event(12, "answer-1", {
          type: "agent_message",
          payload: { message: "answer" },
        }),
      ],
      "session-1",
      "run-1",
    );
    expect(snapshot.turnResults).toBeUndefined();
  });
});
