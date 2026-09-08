import { describe, expect, it } from "vitest";

import {
  promptEventFromNotification,
  terminalStatusFromNotification,
} from "../../../packages/agenc-sdk/src/events";

describe("agenc-sdk prompt event mapping", () => {
  it("correlates consistent stale failures against the caller's active turn", () => {
    const notification = {
      method: "event.session_event",
      params: {
        turnId: "stale-turn",
        event: { type: "turn_failed", payload: { turnId: "stale-turn", code: "provider_error", message: "stale" } },
      },
    };
    expect(terminalStatusFromNotification(notification, "current-turn")).toBeNull();
    expect(terminalStatusFromNotification(notification, "stale-turn")).toEqual({ code: 1, message: "stale" });
  });

  it("rejects conflicting outer and failed-turn identities", () => {
    expect(terminalStatusFromNotification({
      method: "event.session_event",
      params: {
        turnId: "current-turn",
        event: { type: "turn_failed", payload: { turnId: "stale-turn", code: "provider_error", message: "stale" } },
      },
    })).toBeNull();
  });

  it("keeps diagnostics non-terminal and recognizes explicit failed turns", () => {
    const notification = {
      method: "event.session_event",
      params: { event: {
        type: "error",
        payload: { turnId: "turn-1", cause: "stop_hook_threw", message: "diagnostic" },
      } },
    };
    expect(terminalStatusFromNotification(notification)).toBeNull();
    expect(terminalStatusFromNotification({
      ...notification,
      params: { event: {
        type: "turn_failed",
        payload: { turnId: "turn-1", code: "provider_error", message: "failed" },
      } },
    })).toEqual({ code: 1, message: "failed" });
    expect(terminalStatusFromNotification({
      ...notification,
      params: { event: {
        type: "turn_complete",
        payload: { turnId: "turn-1", lastAgentMessage: "full answer" },
      } },
    })).toEqual({ code: 0, message: "full answer" });
  });

  it("preserves a replay-required gap when the retired count is no longer known", () => {
    const notification = {
      method: "event.event_gap",
      params: {
        kind: "event_gap",
        reason: "retention",
        sessionId: "session_1",
        runId: "run_1",
        retiredCount: 0,
        retiredCountKnown: false,
      },
    };
    expect(promptEventFromNotification(notification)).toMatchObject({
      type: "gap",
      runId: "run_1",
      retiredCount: 0,
      retiredCountKnown: false,
    });
    expect(
      promptEventFromNotification({
        ...notification,
        params: { ...notification.params, retiredCountKnown: true },
      }),
    ).toBeNull();
    expect(
      promptEventFromNotification({
        ...notification,
        params: { ...notification.params, retiredCount: -1 },
      }),
    ).toBeNull();
  });

  it("preserves a typed mobile client action on user-input requests", () => {
    const clientAction = {
      type: "ledger_solana_transfer_v1",
      source: "agenc-core",
      targetCapability: "portal.ledger.solana.sign.v1",
      network: "mainnet-beta",
      intentId: "ledger_contract_test",
      responseNonce: "contract-test-response-nonce-1234567890",
      to: "11111111111111111111111111111111",
      lamports: "1",
      expiresAt: "2026-07-10T12:10:00.000Z",
    };

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
          questions: [],
          clientAction,
        },
      }),
    ).toMatchObject({
      type: "elicitation_request",
      kind: "request_user_input",
      requestId: "request_1",
      eventId: "event_1",
      sequence: 1,
      clientAction,
    });
  });

  it("does not promote a scalar clientAction into the typed event", () => {
    expect(
      promptEventFromNotification({
        jsonrpc: "2.0",
        method: "event.user_input_request",
        params: {
          sessionId: "session_1",
          requestId: "request_2",
          eventId: "event_2",
          sequence: 2,
          timestamp: "2026-07-10T12:00:01.000Z",
          callId: "call_2",
          turnId: "turn_1",
          questions: [],
          clientAction: "untrusted-scalar" as never,
        },
      }),
    ).not.toHaveProperty("clientAction");
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
