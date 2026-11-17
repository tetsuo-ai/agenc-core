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
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({ agentManager: { streamAgentMessage: async () => {
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
