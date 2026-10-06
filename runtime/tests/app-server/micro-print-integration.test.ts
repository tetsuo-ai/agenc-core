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

it.each([
  { format: "text", large: false },
  ...["text", "json", "stream-json"].map(format => ({ format, large: true })),
])("delivers $format (large=$large) through the real dispatcher and acknowledged slow sink", async ({ format, large }) => {
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
  let releaseFirst!: () => void;
  let firstWritten!: () => void;
  const firstWrite = new Promise<void>(resolve => { firstWritten = resolve; });
  let writes = 0;
  const answer = large ? "x".repeat(5 * 1024 * 1024) + "π🌍" : "hello π🌍";
  const io = {
    stdout: new Writable({ highWaterMark: 1, write(chunk, _encoding, done) {
      stdout += String(chunk); writes++;
      if (large && writes === 1) { releaseFirst = done; firstWritten(); }
      else if (large) setImmediate(done);
      else done();
    } }),
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
    const run = tryMicroPrint({ argv: ["-p", "--output-format", format, "hello"], cwd: home, env,
      caller: { pid: 5100, stdinIsTTY: false, stdoutIsTTY: false, stderrIsTTY: false } }, home, io, open);
    await vi.waitFor(() => expect(manager.attachAgent).toHaveBeenCalledOnce());
    let finished = false;
    const delivered = (async () => {
      await connection!.printEventSink!({ method: "event.message_chunk", params: { sessionId: "session", delta: answer } });
      await connection!.printEventSink!({ method: "event.agent_status", params: { sessionId: "session", status: "idle", runStatus: "completed" } });
      return await run;
    })().finally(() => { finished = true; });
    if (large) {
      await firstWrite;
      await new Promise(resolve => setImmediate(resolve));
      expect(finished).toBe(false); expect(writes).toBe(1);
      expect(methods).not.toContain("print.ack");
      releaseFirst();
    }
    expect(await delivered).toBe(0);
    if (format === "text") expect(stdout).toBe(`${answer}\n`);
    else {
      const lines = stdout.trimEnd().split("\n").map(line => JSON.parse(line));
      expect(lines.at(-1)).toMatchObject({ type: "result", exitCode: 0, finalMessage: answer });
      if (format === "json") expect(lines[0].events).toHaveLength(2);
      else expect(lines).toHaveLength(3);
    }
    expect(stderr).toBe("");
    if (large) expect(Buffer.byteLength(stdout)).toBeGreaterThan(5 * 1024 * 1024);
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
}, 30_000);
