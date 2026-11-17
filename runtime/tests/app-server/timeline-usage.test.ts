import { describe, expect, it } from "vitest";
import { TurnUsageCollector } from "../../src/session/turn-usage.js";
import { AgenCDaemonJsonRpcDispatcher } from "../../src/app-server/daemon-dispatcher.js";
import { AGENC_DAEMON_PROTOCOL_VERSION } from "../../src/app-server/protocol/index.js";
import type { AdmissionUsageSummary } from "../../src/budget/admission-types.js";

describe("C1 turn usage", () => {
  it("reports only this turn and preserves plan billing and missing counters", () => {
    let summary = { costUsd: 7, billedEstimateUsd: 6, planCalls: 2, hasUnknownCost: false } as AdmissionUsageSummary;
    const collector = new TurnUsageCollector(() => summary);
    collector.observe({ id: "a", msg: { type: "token_count", payload: { promptTokens: 10, completionTokens: 4, totalTokens: 14, cachedInputTokens: 3, reasoningOutputTokens: 2 } } });
    summary = { ...summary, planCalls: 3 };
    expect(collector.snapshot()).toEqual({ input: 10, output: 4, cached: 3, reasoning: 2, costUsd: 0, billedEstimateUsd: 0, planCalls: 1 });
    expect(summary.costUsd).toBe(7);
    expect(new TurnUsageCollector().snapshot()).toEqual({});
    summary = { ...summary, hasUnknownCost: true, costUsd: 8, billedEstimateUsd: undefined };
    expect(collector.snapshot()).not.toHaveProperty("costUsd");
    expect(collector.snapshot()).not.toHaveProperty("billedEstimateUsd");
  });
  it.each([false, true])("delivers usage only to opted-in=%s clients", async enabled => {
    const sent: any[] = [];
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({ agentManager: {} as never });
    const connection = dispatcher.createConnection({ sendNotification: message => { sent.push(message); } });
    expect(await connection.dispatch({ jsonrpc: "2.0", id: "init", method: "initialize", params: { protocol: { version: AGENC_DAEMON_PROTOCOL_VERSION }, capabilities: { "turn.usage.v1": enabled } } })).toMatchObject({ result: { capabilities: { "turn.usage.v1": true } } });
    const usage = { input: 10, output: 3, costUsd: 0, planCalls: 1 };
    await connection.sendNotification!({ method: "event.agent_status", params: { turnEvent: { type: "turn_complete", payload: { turnId: "t", usage } } } });
    expect(sent[0].params.turnEvent.payload).toEqual(enabled ? { turnId: "t", usage } : { turnId: "t" });
    const sessionUsage = { method: "event.session_event", params: { event: { type: "session_usage", payload: usage } } };
    await connection.sendNotification!(sessionUsage);
    expect(sent[1]).toBe(sessionUsage);
    await connection.close();
  });
});
