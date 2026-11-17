import { UnifiedExecProcessManager, ProcessOutputBuffer } from "../../src/unified-exec/process-manager.js";
import { withLiveShellProgress } from "../../src/session/live-shell-progress.js";
import { describe, expect, it } from "vitest";
import { PromptProgressGate } from "../../src/app-server/timeline-capabilities.js";
import { AgenCDaemonJsonRpcDispatcher } from "../../src/app-server/daemon-dispatcher.js";
import { AGENC_DAEMON_PROTOCOL_VERSION } from "../../src/app-server/protocol/index.js";
const progress = (toolName = "Bash", chunk = "hello") => ({ method: "event.session_event", params: { sessionId: "s", clientMessageId: "m", event: { type: "tool_progress", payload: { callId: "c", toolName, chunk } } } });
describe("C6 prompt shell progress", () => {
  it("bounds output and excludes non-shell and wrong-prompt events", async () => {
    const gate = new PromptProgressGate();
    await gate.run("s", "m", true, async () => {
      expect(gate.project(progress("FileRead"))).toBeNull();
      expect(gate.project({ ...progress(), params: { ...progress().params, clientMessageId: "other" } })).toBeNull();
      expect(gate.project(progress("Bash", "a".repeat(5000)))).toMatchObject({ params: { event: { payload: { chunk: "a".repeat(4096), outputDropped: true } } } });
      expect(gate.project(progress())).toBeNull();
    });
    expect(gate.project(progress())).toBeNull();
  });
  it("keeps a capable connection quiet without a prompt flag", async () => {
    const sent: unknown[] = [];
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({ agentManager: {} as never });
    const connection = dispatcher.createConnection({ sendNotification: message => { sent.push(message); } });
    await connection.dispatch({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocol: { version: AGENC_DAEMON_PROTOCOL_VERSION }, capabilities: { "tool.progress.shell.v1": true } } });
    await connection.sendNotification!(progress());
    expect(sent).toEqual([]);
    await connection.close();
  });
  it.each([false, true])("forwards during opted-in=%s prompt only", async enabled => {
    const sent: any[] = [];
    let connection: any;
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({ agentManager: { streamAgentMessage: async (params: any) => {
      expect(params.includeToolProgress).toBe(enabled ? true : undefined);
      await connection.sendNotification(progress());
      await connection.sendNotification(progress("FileRead"));
      return { disposition: "started", acceptedAt: "now" };
    } } as never });
    connection = dispatcher.createConnection({ sendNotification: message => { sent.push(message); } });
    expect(await connection.dispatch({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocol: { version: AGENC_DAEMON_PROTOCOL_VERSION }, capabilities: enabled ? { "tool.progress.shell.v1": true } : {} } })).toMatchObject({ result: { capabilities: { "tool.progress.shell.v1": true } } });
    expect(await connection.dispatch({ jsonrpc: "2.0", id: 2, method: "message.stream", params: { sessionId: "s", clientMessageId: "m", content: "test", ...(enabled ? { includeToolProgress: true } : {}) } })).toHaveProperty("result");
    expect(sent).toEqual(enabled ? [progress()] : [progress(), progress("FileRead")]);
    await connection.sendNotification(progress());
    expect(sent).toHaveLength(enabled ? 1 : 3);
    await connection.close();
  });
});

// A real process writes while collection is still waiting for its exit.
it.each([false, true])("streams timed command output before completion only with opt-in=%s", async enabled => {
  const manager = new UnifiedExecProcessManager({ cwd: process.cwd() });
  const received: { at: number; chunk: string }[] = [];
  const started = Date.now();
  try {
    const result = await withLiveShellProgress(enabled, () => manager.execCommand({
      cmd: "printf 'first\\n'; sleep 0.4; printf 'second\\n'; sleep 0.4; printf 'third\\n'",
      yield_time_ms: 5000,
      __onProgress: event => received.push({ at: Date.now() - started, chunk: event.chunk }),
    }));
    const ended = Date.now() - started;
    expect(result.stdout).toBe("first\nsecond\nthird\n");
    expect(received.map(event => event.chunk).join("")).toBe(result.stdout);
    expect(received.length).toBeGreaterThanOrEqual(3);
    if (enabled) expect(received[0]!.at).toBeLessThan(ended - 500);
    else expect(received[0]!.at).toBeGreaterThanOrEqual(ended - 100);
  } finally { await manager.closeAll("test_cleanup"); }
});
it("live buffer subscription does not consume output and cleans up", () => {
  const buffer = new ProcessOutputBuffer();
  buffer.append("stdout", "before");
  const chunks: string[] = [];
  const off = buffer.subscribe(event => chunks.push(event.chunk));
  buffer.append("stderr", "during");
  off();
  buffer.append("stdout", "after");
  expect(chunks).toEqual(["before", "during"]);
  expect(buffer.drain().map(event => event.chunk)).toEqual(["before", "during", "after"]);
});
