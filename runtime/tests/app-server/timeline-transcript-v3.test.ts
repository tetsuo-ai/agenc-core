import { serializeRolloutItem, parseRolloutLine } from "../../src/session/rollout-item.js";
import { transcriptV3Turns } from "../../src/app-server/transcript-v3.js";
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

const recorded: RolloutItem[] = [
  event({ type: "turn_started", payload: { turnId: "recorded" } }, 1),
  event({ type: "turn_changes", payload: { turnId: "recorded", from: "checkpoint", files: [{ path: "a.ts", op: "modified", added: 2, removed: 1 }], diff: "private patch text", note: "Concurrent edits may be included." } }, 2),
  event({ type: "turn_complete", payload: { turnId: "recorded", usage: { input: 17, output: 3, cached: 4, reasoning: 1, costUsd: 0, planCalls: 1, billedEstimateUsd: 0 } } }, 3),
  event({ type: "turn_started", payload: { turnId: "resumed" } }, 4),
  event({ type: "turn_changes", payload: { turnId: "resumed", from: "checkpoint", files: [], skipped: true, note: "snapshot unavailable" } }, 5),
  event({ type: "turn_complete", payload: { turnId: "resumed", usage: {} } }, 6),
  event({ type: "turn_started", payload: { turnId: "old" } }, 7),
  event({ type: "turn_complete", payload: { turnId: "old" } }, 8),
];
const reopened = (): RolloutItem[] => recorded.map(item => parseRolloutLine(serializeRolloutItem(item))!);
it("reopens exact recorded usage and summary, with no diff or invented usage", () => {
  const snapshot = sessionTranscriptV2FromRollout(reopened(), "s", "r", undefined, undefined, { schemaVersion: 3 });
  expect(snapshot.turns![0]).toMatchObject({
    turnId: "recorded", usage: { mark: "reported", input: 17, output: 3, cached: 4, reasoning: 1, costUsd: 0, planCalls: 1, billedEstimateUsd: 0 },
    changes: { turnId: "recorded", from: "checkpoint", files: [{ path: "a.ts", op: "modified", added: 2, removed: 1 }] },
  });
  expect(snapshot.turns![1]).toMatchObject({ usage: { mark: "missing" }, changes: { skipped: true, files: [], note: "snapshot unavailable" } });
  expect(snapshot.turns![2]).not.toHaveProperty("usage");
  expect(snapshot.turns![2]).not.toHaveProperty("changes");
  expect(JSON.stringify(snapshot)).not.toContain("private patch text");
});
it("respects the visible boundary and bounds reopened change summaries", () => {
  expect(transcriptV3Turns(reopened(), 2).turns.map(turn => turn.turnId)).toEqual(["resumed", "old"]);
  const changes = event({ type: "turn_changes", payload: { turnId: "recorded", from: "checkpoint", files: Array.from({ length: 300 }, (_, i) => ({ path: String(i), op: "created", added: 1, removed: 0 })), note: "x".repeat(5000) } }, 2);
  const turn = transcriptV3Turns([recorded[0]!, changes, recorded[2]!], -1).turns[0]!;
  expect(turn.changes!.files).toHaveLength(256);
  expect(turn.changes!.filesTruncated).toBe(true);
  expect(turn.changes!.note).toHaveLength(2048);
});
it.each([2, 3])("serves recorded usage and changes only to schema %s clients", async schemaVersion => {
  const dispatcher = new AgenCDaemonJsonRpcDispatcher({ agentManager: { getSessionTranscriptV2: async (_: unknown, options: any) => sessionTranscriptV2FromRollout(reopened(), "s", "r", undefined, undefined, options) } as never });
  const connection = dispatcher.createConnection();
  await connection.dispatch({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocol: { version: AGENC_DAEMON_PROTOCOL_VERSION } } });
  const result: any = await connection.dispatch({ jsonrpc: "2.0", id: 2, method: "session.transcript.v2", params: { sessionId: "s", schemaVersion } });
  if (schemaVersion === 3) {
    expect(result.result.turns[0].usage).toMatchObject({ mark: "reported", input: 17, costUsd: 0 });
    expect(result.result.turns[0].changes.files[0].path).toBe("a.ts");
    expect(result.result.turns[0].changes).not.toHaveProperty("diff");
  } else {
    expect(result.result).toEqual(sessionTranscriptV2FromRollout(reopened(), "s", "r"));
    expect(result.result).not.toHaveProperty("turns");
  }
  await connection.close();
});
