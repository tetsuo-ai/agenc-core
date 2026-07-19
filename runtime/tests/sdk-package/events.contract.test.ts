import { describe, expect, it } from "vitest";

import { promptEventFromNotification } from "../../../packages/agenc-sdk/src/events";

describe("agenc-sdk prompt event mapping", () => {
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
});
