import { runTurn } from "../../src/session/run-turn.js";
import { drain, mkCtx, mkProvider, mkSession } from "../fixtures.js";
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

it.each([[false, false], [true, false], [false, true], [true, true]])("carries live opt-in=%s through a real turn and command, one-shot=%s", async (enabled, fast) => {
  const manager = new UnifiedExecProcessManager({ cwd: process.cwd() });
  let commandEndedAt = 0;
  let usedMinimalDispatch = false;
  const tool = { name: "exec_command", description: "Run fixture command", requiresApproval: false, isReadOnly: true,
    inputSchema: { type: "object", properties: {} }, execute: async (args: any) => {
      const result = await manager.execCommand({ cmd: "printf 'first\\n'; sleep 0.4; printf 'second\\n'; sleep 0.4", yield_time_ms: 5000, __onProgress: args.__onProgress });
      commandEndedAt = Date.now();
      return { content: result.stdout };
    } };
  const registry: any = { tools: [tool], toLLMTools: () => [{ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } }],
    dispatch: (call: any, options: any) => {
      usedMinimalDispatch = options?.prepareArguments !== undefined;
      return tool.execute(options?.prepareArguments ? options.prepareArguments(JSON.parse(call.arguments), tool) : JSON.parse(call.arguments));
    } };
  let modelCalls = 0;
  const provider = mkProvider();
  provider.chatStream = async () => ({ content: modelCalls ? "Done" : "", toolCalls: modelCalls++ ? [] : [{ id: "command", name: "exec_command", arguments: "{}" }], finishReason: modelCalls === 1 ? "tool_calls" : "stop", model: "test-model", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } });
  const { session } = mkSession({ provider, registry, cwd: process.cwd(), ...(fast ? { services: { runtimeOptions: { dangerouslyBypassApprovalsAndSandbox: true, nonInteractive: true, relaxedOneShot: true } as any } } : {}) });
  const progress: { at: number; text: string }[] = [];
  session.eventLog.subscribe(event => { if (event.msg.type === "tool_progress") progress.push({ at: Date.now(), text: event.msg.payload.chunk }); });
  try {
    await drain(runTurn(session, mkCtx({ cwd: process.cwd(), permissionMode: "bypassPermissions", sandboxPolicy: { value: "danger_full_access" } }), "Run the command", enabled ? { includeToolProgress: true } : {}));
    expect(progress.map(event => event.text).join("")).toBe("first\nsecond\n");
    expect(commandEndedAt).toBeGreaterThan(0);
    expect(usedMinimalDispatch).toBe(fast);
    if (enabled) expect(progress[0]!.at).toBeLessThan(commandEndedAt - 500);
    else expect(progress[0]!.at).toBeGreaterThanOrEqual(commandEndedAt - 100);
  } finally { await manager.closeAll("test_cleanup"); }
});
