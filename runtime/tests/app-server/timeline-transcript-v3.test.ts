import { describe, expect, it } from "vitest";
import { sessionTranscriptV2FromRollout } from "../../src/app-server/background-agent-runner/journal-reconstruction.js";
import { AgenCDaemonJsonRpcDispatcher } from "../../src/app-server/daemon-dispatcher.js";
import { AGENC_DAEMON_PROTOCOL_VERSION } from "../../src/app-server/protocol/index.js";
import type { EventMsg } from "../../src/session/event-log.js";
import type { RolloutItem } from "../../src/session/rollout-item.js";
const event = (msg: EventMsg, seq: number): RolloutItem => ({ type: "event_msg", payload: { id: `e${seq}`, seq, msg } });
const items: RolloutItem[] = [
  event({ type: "turn_started", payload: { turnId: "t" } }, 1),
  event({ type: "tool_call_started", payload: { callId: "c", toolName: "FileWrite", args: JSON.stringify({ file_path: "a.ts", content: "secret input" }) } }, 2),
  event({ type: "tool_call_completed", payload: { callId: "c", result: "secret output", isError: false, durationMs: 12 } }, 3),
  event({ type: "turn_complete", payload: { turnId: "t" } }, 4),
];
describe("C2 transcript v3", () => {
  it("keeps ordered call identity and timing, without content or output", () => {
    const snapshot = sessionTranscriptV2FromRollout(items, "s", "r", undefined, undefined, { schemaVersion: 3 });
    expect(snapshot.turns).toEqual([{ turnId: "t", toolCalls: [{ callId: "c", toolName: "FileWrite", inputDigest: { file_path: "a.ts" }, isError: false, durationMs: 12 }] }]);
    expect(JSON.stringify(snapshot.turns)).not.toContain("secret");
    const legacy = sessionTranscriptV2FromRollout(items, "s", "r");
    expect(legacy.schemaVersion).toBe(2);
    expect(legacy).not.toHaveProperty("turns");
  });
  it("caps calls and input previews", () => {
    const many = [items[0]!, ...Array.from({ length: 300 }, (_, i) => event({ type: "tool_call_started", payload: { callId: String(i), toolName: "Bash", args: JSON.stringify({ command: "x".repeat(5000) }) } }, i + 2))];
    const snapshot = sessionTranscriptV2FromRollout(many, "s", "r", undefined, undefined, { schemaVersion: 3 });
    expect(snapshot.turnsTruncated).toBe(true);
    expect(snapshot.turns![0]!.toolCalls).toHaveLength(128);
    expect(snapshot.turns![0]!.toolCalls[0]!.inputDigest.command).toHaveLength(512);
  });
  it.each([undefined, 3])("serves requested schema %s through the protocol", async schemaVersion => {
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({ agentManager: { getSessionTranscriptV2: async (_params: unknown, options: any) => sessionTranscriptV2FromRollout(items, "s", "r", undefined, undefined, options) } as never });
    const connection = dispatcher.createConnection();
    expect(await connection.dispatch({ jsonrpc: "2.0", id: "init", method: "initialize", params: { protocol: { version: AGENC_DAEMON_PROTOCOL_VERSION } } })).toMatchObject({ result: { capabilities: { "transcript.tools.v3": true } } });
    const result: any = await connection.dispatch({ jsonrpc: "2.0", id: "snapshot", method: "session.transcript.v2", params: { sessionId: "s", ...(schemaVersion ? { schemaVersion } : {}) } });
    expect(result.result.schemaVersion).toBe(schemaVersion ?? 2);
    expect(result.result.turns !== undefined).toBe(schemaVersion === 3);
    await connection.close();
  });
});
