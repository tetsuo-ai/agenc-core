import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createConnection } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgenCDaemonJsonRpcDispatcher, type AgenCDaemonDispatcherOptions } from "../../src/app-server/daemon-dispatcher.js";
import { AgenCUnixSocketServer } from "../../src/app-server/transport/unix-socket.js";
import { AgenCStdioTransport } from "../../src/app-server/transport/stdio.js";
import { trustProject } from "../../src/permissions/trust/project-trust.js";
import type { JsonObject } from "../../src/app-server/protocol/index.js";

let home: string, cwd: string;
const dispatchers: AgenCDaemonJsonRpcDispatcher[] = [];
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "print-dispatch-")); cwd = join(home, "repo"); mkdirSync(cwd);
  await trustProject({ agencHome: home, env: { AGENC_HOME: home, HOME: home }, projectRoot: cwd });
});
afterEach(async () => { await Promise.all(dispatchers.splice(0).map(d => d.close())); rmSync(home, { recursive: true, force: true }); });
const rpc = (id: string, method: string, params: JsonObject = {}): JsonObject => ({ jsonrpc: "2.0", id, method, params });
const invoke = (): JsonObject => ({ invocationId: "run", argv: ["-p", "hello"], cwd, env: { HOME: home, AGENC_HOME: home, AGENC_WORKSPACE: cwd }, caller: { pid: 100, stdinIsTTY: false, stdoutIsTTY: false, stderrIsTTY: false } });
function fixture() {
  const manager = {
    createAgent: vi.fn(async () => ({ agentId: "agent", sessionId: "session" })),
    attachAgent: vi.fn(async () => ({ agentId: "agent", sessionIds: ["session"] })),
    stopAgent: vi.fn(async () => ({ agentId: "agent", status: "stopped" })),
    getSessionSnapshot: vi.fn(async () => ({})),
  };
  const dispatcher = new AgenCDaemonJsonRpcDispatcher({ printHome: home, agentManager: manager as unknown as AgenCDaemonDispatcherOptions["agentManager"] });
  dispatchers.push(dispatcher); return { manager, dispatcher };
}
const init = (version = "1.30.0", capable = true) => rpc("init", "initialize", { protocolVersion: version, capabilities: capable ? { "print.invoke.v1": true } : {} });

describe("resident print dispatcher boundary", () => {
  it.each([[false, "1.30.0", true], [true, "1.29.0", true], [true, "1.30.0", false]] as const)("rejects unnegotiated or non-Unix callers (%s,%s,%s)", async (localUnix, version, capable) => {
    const { dispatcher, manager } = fixture(); const send = vi.fn();
    const connection = dispatcher.createConnection({ localUnix, sendNotification: send });
    await connection.dispatch(init(version, capable));
    expect(await connection.dispatch(rpc("run", "print.invoke", invoke()))).toHaveProperty("error");
    expect(manager.createAgent).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled(); await connection.close();
  });
  it("requires initialize before reading the invocation", async () => {
    const { dispatcher, manager } = fixture(); const connection = dispatcher.createConnection({ localUnix: true, sendNotification: () => {} });
    expect(await connection.dispatch(rpc("run", "print.invoke", invoke()))).toMatchObject({ error: { data: { code: "CONNECTION_NOT_INITIALIZED" } } });
    expect(manager.createAgent).not.toHaveBeenCalled(); await connection.close();
  });
  it("does not let another initialized connection acknowledge admission", async () => {
    const { dispatcher, manager } = fixture(); let challenge: string | undefined;
    const owner = dispatcher.createConnection({ localUnix: true, sendNotification: message => { if (message.method === "print.admission") challenge = String((message.params as JsonObject).challenge); } });
    const other = dispatcher.createConnection({ localUnix: true, sendNotification: () => {} });
    await owner.dispatch(init()); await other.dispatch(init());
    const run = owner.dispatch(rpc("run", "print.invoke", invoke()));
    await vi.waitFor(() => expect(challenge).toBeDefined());
    expect(await other.dispatch(rpc("admit", "print.admit", { invocationId: "run", challenge: challenge! }))).toHaveProperty("error");
    expect(manager.createAgent).not.toHaveBeenCalled();
    await owner.close(); expect(await run).toMatchObject({ result: { kind: "exit", exitCode: 130 } }); await other.close();
  });
  it("joins a late create on disconnect and stops its owned agent", async () => {
    const { dispatcher, manager } = fixture(); let release!: () => void;
    manager.createAgent.mockImplementation(() => new Promise(resolve => { release = () => resolve({ agentId: "agent", sessionId: "session" }); }));
    let challenge!: string;
    const connection = dispatcher.createConnection({ localUnix: true, sendNotification: message => { if (message.method === "print.admission") challenge = String((message.params as JsonObject).challenge); } });
    await connection.dispatch(init()); const run = connection.dispatch(rpc("run", "print.invoke", invoke()));
    await vi.waitFor(() => expect(challenge).toBeDefined());
    expect(await connection.dispatch(rpc("admit", "print.admit", { invocationId: "run", challenge }))).toHaveProperty("result.ok", true);
    await vi.waitFor(() => expect(manager.createAgent).toHaveBeenCalledOnce());
    let closed = false; const close = connection.close().then(() => { closed = true; });
    await new Promise(resolve => setImmediate(resolve)); expect(closed).toBe(false);
    release(); await close; expect(await run).toMatchObject({ result: { exitCode: 130 } });
    expect(manager.attachAgent).not.toHaveBeenCalled();
    expect(manager.stopAgent).toHaveBeenCalledWith({ agentId: "agent", reason: "one_shot_cancelled" });
  });
  it("runs proof ping and cancellation through the transport while invoke is pending", async () => {
    const { dispatcher, manager } = fixture(); const input = new PassThrough(); const output = new PassThrough();
    const messages: JsonObject[] = []; let buffer = "";
    output.on("data", chunk => { buffer += String(chunk); let end: number; while ((end = buffer.indexOf("\n")) >= 0) { messages.push(JSON.parse(buffer.slice(0, end))); buffer = buffer.slice(end + 1); } });
    const connection = dispatcher.createConnection({ localUnix: true, sendNotification: message => { output.write(JSON.stringify(message) + "\n"); } });
    const transport = new AgenCStdioTransport({ input, output, onMessage: async message => { output.write(JSON.stringify(await connection.dispatch(message)) + "\n"); } });
    transport.start(); input.write(JSON.stringify(init()) + "\n");
    await vi.waitFor(() => expect(messages.some(m => m.id === "init")).toBe(true));
    input.write(JSON.stringify(rpc("run", "print.invoke", invoke())) + "\n");
    await vi.waitFor(() => expect(messages.some(m => m.method === "print.admission")).toBe(true));
    input.write(JSON.stringify(rpc("ping", "health.ping")) + "\n");
    await vi.waitFor(() => expect(messages.some(m => m.id === "ping")).toBe(true));
    input.write(JSON.stringify(rpc("cancel", "print.cancel", { invocationId: "run", reason: "signal", signal: "SIGTERM" })) + "\n");
    await vi.waitFor(() => expect(messages.find(m => m.id === "run")).toMatchObject({ result: { kind: "exit", exitCode: 0 } }));
    expect(manager.createAgent).not.toHaveBeenCalled();
    await connection.close(); input.destroy(); output.destroy();
  });
  it("delivers exact Unicode output and its final exit through an authenticated Unix socket", async () => {
    const { dispatcher, manager } = fixture();
    let connection: ReturnType<typeof dispatcher.createConnection> | undefined;
    const server = new AgenCUnixSocketServer({ socketPath: join(home, "print.sock"), allowRuntimeNativePeerCredentialBuild: false,
      acceptAuthenticator: message => message.method === "initialize" && (message.params as JsonObject)?.authCookie === "test-cookie",
      onMessage: async (message, context) => {
        connection ??= dispatcher.createConnection({ localUnix: true, sendNotification: notification => context.send(notification) });
        await context.send(await connection.dispatch(message));
      }, onConnectionClosed: () => { void connection?.close(); },
    });
    const socketPath = await server.listen(); const socket = createConnection(socketPath); socket.setEncoding("utf8");
    const messages: JsonObject[] = []; let buffer = "", stdout = "";
    const send = (message: JsonObject) => socket.write(JSON.stringify(message) + "\n");
    socket.on("data", chunk => {
      buffer += chunk; let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const message = JSON.parse(buffer.slice(0, end)) as JsonObject; buffer = buffer.slice(end + 1); messages.push(message);
        if (message.method === "print.output") {
          const p = message.params as JsonObject; if (p.stream === "stdout") stdout += String(p.data);
          send(rpc(`ack-${p.sequence}`, "print.ack", { invocationId: p.invocationId!, sequence: p.sequence! }));
        }
      }
    });
    try {
      const initialize = init(); initialize.params = { ...(initialize.params as JsonObject), authCookie: "test-cookie" }; send(initialize);
      await vi.waitFor(() => expect(messages.some(m => m.id === "init")).toBe(true));
      send(rpc("run", "print.invoke", invoke()));
      await vi.waitFor(() => expect(messages.some(m => m.method === "print.admission")).toBe(true));
      expect(manager.createAgent).not.toHaveBeenCalled();
      send(rpc("ping", "health.ping")); await vi.waitFor(() => expect(messages.some(m => m.id === "ping")).toBe(true));
      const challenge = (messages.find(m => m.method === "print.admission")!.params as JsonObject).challenge!;
      send(rpc("admit", "print.admit", { invocationId: "run", challenge }));
      await vi.waitFor(() => expect(manager.attachAgent).toHaveBeenCalledOnce());
      await connection!.printEventSink!({ method: "event.message_chunk", params: { sessionId: "session", delta: "π🌍" } });
      await connection!.printEventSink!({ method: "event.agent_status", params: { sessionId: "session", status: "idle", runStatus: "completed" } });
      await vi.waitFor(() => expect(messages.find(m => m.id === "run")).toMatchObject({ result: { kind: "exit", exitCode: 0 } }));
      expect(stdout).toBe("π🌍\n"); expect(manager.stopAgent).toHaveBeenCalledOnce();
    } finally { await connection?.close(); socket.destroy(); await server.close(); }
  });

});
