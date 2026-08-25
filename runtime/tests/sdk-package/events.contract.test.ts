import { describe, expect, it } from "vitest";

import { promptEventFromNotification } from "../../../packages/agenc-sdk/src/events";

describe("agenc-sdk prompt event mapping", () => {
  it("maps ordinary user-input requests without private extensions", () => {
    expect(
      promptEventFromNotification({
        jsonrpc: "2.0",
        method: "event.user_input_request",
        params: {
          sessionId: "session_1",
          requestId: "request_1",
          eventId: "event_1",
          sequence: 1,
          timestamp: "2026-07-10T12:00:00.000Z",
          callId: "call_1",
          turnId: "turn_1",
          questions: [{ id: "choice", question: "Continue?" }],
        },
      }),
    ).toMatchObject({
      type: "elicitation_request",
      kind: "request_user_input",
      requestId: "request_1",
      eventId: "event_1",
      sequence: 1,
      questions: [{ id: "choice", question: "Continue?" }],
    });
  });

  it("surfaces a JSON-RPC live retention gap instead of dropping it", () => {
    expect(
      promptEventFromNotification({
        jsonrpc: "2.0",
        method: "event.event_gap",
        params: {
          type: "event_gap",
          kind: "event_gap",
          sessionId: "session_1",
          runId: "run_1",
          reason: "retention",
          retiredCount: 7,
          afterSequence: 3,
          firstAvailableSequence: 11,
          source: "multiplexer_retention",
        },
      }),
    ).toEqual({
      type: "gap",
      kind: "event_gap",
      sessionId: "session_1",
      runId: "run_1",
      reason: "retention",
      retiredCount: 7,
      afterSequence: 3,
      firstAvailableSequence: 11,
    });
  });

  it.each([
    ["history_cleared", {}, "cleared"],
    ["transcript_epoch", { reason: "rewind" }, "rewind"],
  ] as const)(
    "surfaces %s as an identity-bearing transcript reset",
    (type, payload, reason) => {
      expect(
        promptEventFromNotification({
          jsonrpc: "2.0",
          method: "event.session_event",
          params: {
            sessionId: "session_1",
            eventId: "epoch_event",
            sequence: 44,
            runId: "run_1",
            historyEpoch: "history:run_1:epoch_event",
            event: { id: "epoch_event", type, payload },
          },
        }),
      ).toEqual({
        type: "history_reset",
        reason,
        eventId: "epoch_event",
        sequence: 44,
        runId: "run_1",
        historyEpoch: "history:run_1:epoch_event",
      });
    },
  );

  it("maps a legacy params.msg history reset envelope", () => {
    expect(
      promptEventFromNotification({
        jsonrpc: "2.0",
        method: "event.session_event",
        params: {
          sessionId: "session_1",
          eventId: "legacy_epoch",
          historyEpoch: "history:run_1:legacy_epoch",
          msg: {
            type: "transcript_epoch",
            payload: { reason: "compaction_rollback" },
          },
        },
      }),
    ).toEqual({
      type: "history_reset",
      reason: "compaction_rollback",
      eventId: "legacy_epoch",
      historyEpoch: "history:run_1:legacy_epoch",
    });
  });
});
