import { describe, expect, it } from "vitest";
import { sessionTranscriptV2FromRollout } from "../../src/app-server/background-agent-runner/journal-reconstruction.js";
import { AgenCDaemonJsonRpcDispatcher } from "../../src/app-server/daemon-dispatcher.js";
import { AGENC_DAEMON_PROTOCOL_VERSION } from "../../src/app-server/protocol/index.js";
import type { EventMsg } from "../../src/session/event-log.js";
import type { RolloutItem } from "../../src/session/rollout-item.js";
const messages: EventMsg[] = [
  { type: "turn_started", payload: { turnId: "t" } },
  { type: "plan_started", payload: { turnId: "t", planItemId: "p", title: "Plan", timestamp: 1 } },
  { type: "plan_delta", payload: { turnId: "t", planItemId: "p", delta: "Draft", timestamp: 2 } },
  { type: "plan_item_completed", payload: { turnId: "t", planItemId: "p", finalText: "Final plan", timestamp: 3 } },
  { type: "tool_call_started", payload: { callId: "todo", toolName: "TodoWrite", args: JSON.stringify({ todos: [{ content: "Verify", status: "in_progress" }] }) } },
  { type: "tool_call_completed", payload: { callId: "todo", result: "ok", isError: false } },
  { type: "tool_call_started", payload: { callId: "bad", toolName: "TodoWrite", args: JSON.stringify({ todos: [] }) } },
  { type: "tool_call_completed", payload: { callId: "bad", result: "denied", isError: true } },
];
const items: RolloutItem[] = messages.map((msg, i) => ({ type: "event_msg", payload: { id: String(i), seq: i + 1, msg } }));
describe("C4 durable plan state", () => {
  it("retains final plan and last successful todo list", () => {
    const result = sessionTranscriptV2FromRollout(items, "s", "r", undefined, undefined, { schemaVersion: 3 });
    expect(result.turns![0]).toMatchObject({ plan: { planItemId: "p", text: "Final plan", state: "done" }, todos: [{ text: "Verify", state: "running" }] });
  });
  it.each([false, true])("negotiates plan snapshots for new=%s clients", async enabled => {
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({ agentManager: { getSessionTranscriptV2: async (_: unknown, options: any) => sessionTranscriptV2FromRollout(items, "s", "r", undefined, undefined, options) } as never });
    const connection = dispatcher.createConnection();
    expect(await connection.dispatch({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocol: { version: AGENC_DAEMON_PROTOCOL_VERSION } } })).toMatchObject({ result: { capabilities: { "transcript.plans.v3": true } } });
    const result: any = await connection.dispatch({ jsonrpc: "2.0", id: 2, method: "session.transcript.v2", params: { sessionId: "s", ...(enabled ? { schemaVersion: 3 } : {}) } });
    if (enabled) expect(result.result.turns[0].plan.text).toBe("Final plan");
    else expect(result.result).not.toHaveProperty("turns");
    await connection.close();
  });
});
