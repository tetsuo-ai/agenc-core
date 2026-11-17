import { describe, expect, it } from "vitest";
import { failureAdvice } from "../../src/app-server/timeline-capabilities.js";
import { AgenCDaemonJsonRpcDispatcher } from "../../src/app-server/daemon-dispatcher.js";
import { AGENC_DAEMON_PROTOCOL_VERSION } from "../../src/app-server/protocol/index.js";

describe("C5 turn failure advice", () => {
  it("distinguishes transient, bounded and terminal failures", () => {
    expect(failureAdvice({ code: "transport_error" })).toEqual({ retryable: true, sessionUsable: true });
    expect(failureAdvice({ code: "max_budget_usd" })).toEqual({ retryable: false, sessionUsable: true });
    expect(failureAdvice({ code: "background_agent_error" })).toEqual({ retryable: false, sessionUsable: false });
    expect(failureAdvice({ code: "custom", retryable: false, sessionUsable: false })).toEqual({ retryable: false, sessionUsable: false });
  });
  it.each([false, true])("negotiates and delivers to opted-in=%s clients", async (enabled) => {
    const sent: unknown[] = [];
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({ agentManager: {} as never });
    const connection = dispatcher.createConnection({ sendNotification: message => { sent.push(message); } });
    const result = await connection.dispatch({ jsonrpc: "2.0", id: "init", method: "initialize", params: {
      protocol: { version: AGENC_DAEMON_PROTOCOL_VERSION }, capabilities: enabled ? { "turn.failure.v1": true } : {},
    } });
    expect(result).toMatchObject({ result: { capabilities: { "turn.failure.v1": true } } });
    const payload = { turnId: "t", code: "transport_error", message: "lost" };
    const notification = { jsonrpc: "2.0", method: "event.session_event", params: { sessionId: "s", event: { type: "turn_failed", payload } } };
    await connection.sendNotification!(notification);
    expect(sent).toEqual([{ ...notification, params: { ...notification.params, event: { type: "turn_failed", payload: enabled ? { ...payload, retryable: true, sessionUsable: true } : payload } } }]);
    expect(payload).toEqual({ turnId: "t", code: "transport_error", message: "lost" });
    await connection.close();
  });
});
