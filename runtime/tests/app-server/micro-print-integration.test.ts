import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { expect, it, vi } from "vitest";
import { AgenCDaemonJsonRpcDispatcher, type AgenCDaemonDispatcherOptions } from "../../src/app-server/daemon-dispatcher.js";
import { AgenCUnixSocketServer } from "../../src/app-server/transport/unix-socket.js";
import { resolveAgenCDaemonSocketPath, resolveAgenCDaemonCookiePath, resolveAgenCDaemonPidPath } from "../../src/app-server/daemon-discovery.js";
import { resolveAgenCDaemonRuntimeInfoPath, writeDaemonRuntimeInfo } from "../../src/app-server/daemon-runtime-info.js";
import { openResidentPrintConnection } from "../../src/app-server/micro-print-connection.js";
import { tryMicroPrint } from "../../src/bin/micro-print-client.js";
import { trustProject } from "../../src/permissions/trust/project-trust.js";
import type { JsonObject } from "../../src/app-server/protocol/index.js";

it("negotiates the real dispatcher capability and completes print on one authenticated connection", async () => {
  const home = mkdtempSync(join(tmpdir(), "micro-print-integration-"));
  const env = { HOME: home, AGENC_HOME: home, AGENC_DAEMON_REQUEST_TIMEOUT_MS: "1000" };
  const identity = { pid: 5200, processStart: "test:5200", instanceId: "instance", runtimeVersion: "test", commit: "commit", buildTime: "now" };
  writeFileSync(resolveAgenCDaemonCookiePath(env), "test-cookie\n");
  writeFileSync(resolveAgenCDaemonPidPath(env), "5200\n");
  mkdirSync(join(home, "dist"));
  writeFileSync(join(home, "dist/VERSION"), JSON.stringify(identity));
  writeDaemonRuntimeInfo(resolveAgenCDaemonRuntimeInfoPath(home), { ...identity, startedAt: "now" });
  await trustProject({ agencHome: home, env, projectRoot: home });
  const manager = {
    createAgent: vi.fn(async () => ({ agentId: "agent", sessionId: "session" })),
    attachAgent: vi.fn(async () => ({ agentId: "agent", sessionIds: ["session"] })),
    stopAgent: vi.fn(async () => ({ agentId: "agent", status: "stopped" })),
    getSessionSnapshot: vi.fn(async () => ({})),
  };
  const dispatcher = new AgenCDaemonJsonRpcDispatcher({ printHome: home, daemonIdentity: identity,
    agentManager: manager as unknown as AgenCDaemonDispatcherOptions["agentManager"] });
  let connection: ReturnType<typeof dispatcher.createConnection> | undefined;
  let acceptedConnections = 0;
  const methods: unknown[] = [];
  let capabilities: unknown;
  const server = new AgenCUnixSocketServer({ socketPath: resolveAgenCDaemonSocketPath(env), allowRuntimeNativePeerCredentialBuild: false,
    acceptAuthenticator: message => {
      acceptedConnections++;
      return message.method === "initialize" && (message.params as JsonObject)?.authCookie === "test-cookie";
    },
    onMessage: async (message, context) => {
      methods.push(message.method);
      if (message.method === "initialize") capabilities = (message.params as JsonObject).capabilities;
      // Dispatch the client's actual envelope without injecting capabilities.
      connection ??= dispatcher.createConnection({ localUnix: true, sendNotification: notification => context.send(notification) });
      await context.send(await connection.dispatch(message));
    },
    onConnectionClosed: () => { void connection?.close(); },
  });
  let stdout = "", stderr = "";
  const io = {
    stdout: new Writable({ write(chunk, _encoding, done) { stdout += String(chunk); done(); } }),
    stderr: new Writable({ write(chunk, _encoding, done) { stderr += String(chunk); done(); } }),
    signals: new EventEmitter() as unknown as NodeJS.Process,
  };
  const resident: { current: Awaited<ReturnType<typeof openResidentPrintConnection>> } = { current: null };
  const publicationBarrier = vi.fn(async () => {});
  const readProcessIdentity = vi.fn(() => identity.processStart);
  await server.listen();
  try {
    const open = async () => resident.current = await openResidentPrintConnection(env, home, {
      userHome: home, publicationBarrier, isPidRunning: pid => pid === identity.pid, readProcessIdentity,
    });
    const run = tryMicroPrint({ argv: ["-p", "hello"], cwd: home, env,
      caller: { pid: 5100, stdinIsTTY: false, stdoutIsTTY: false, stderrIsTTY: false } }, home, io, open);
    await vi.waitFor(() => expect(manager.attachAgent).toHaveBeenCalledOnce());
    await connection!.printEventSink!({ method: "event.message_chunk", params: { sessionId: "session", delta: "hello π🌍" } });
    await connection!.printEventSink!({ method: "event.agent_status", params: { sessionId: "session", status: "idle", runStatus: "completed" } });
    expect(await run).toBe(0);
    expect(stdout).toBe("hello π🌍\n"); expect(stderr).toBe("");
    expect(manager.createAgent).toHaveBeenCalledOnce(); expect(manager.stopAgent).toHaveBeenCalledOnce();
    expect(capabilities).toEqual({ "print.invoke.v1": true });
    expect(acceptedConnections).toBe(1);
    expect(methods.slice(0, 4)).toEqual(["initialize", "print.invoke", "health.ping", "print.admit"]);
    expect(methods.slice(4).every(method => method === "print.ack")).toBe(true);
    expect(publicationBarrier).toHaveBeenCalledTimes(2); expect(readProcessIdentity).toHaveBeenCalledTimes(4);
  } finally {
    resident.current?.transport.close(); await connection?.close(); await server.close(); await dispatcher.close();
    rmSync(home, { recursive: true, force: true });
  }
});
