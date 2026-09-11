import { EventEmitter, once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import {
  AgenCDaemonRpcShutdownCoordinator,
  runAgenCDaemonCli,
  readAgenCDaemonPid,
  resolveAgenCDaemonPidPath,
  resolveAgenCDaemonSocketPath,
  resolveAgenCDaemonCookiePath,
  type AgenCDaemonCliHost,
  type AgenCDaemonCliIo,
} from "../../src/app-server/daemon-cli.js";
import type { AgenCBackgroundAgentRunner } from "../../src/app-server/background-agent-runner.js";
import { readDaemonRuntimeInfo, resolveAgenCDaemonRuntimeInfoPath } from "../../src/app-server/daemon-runtime-info.js";
import { AGENC_DAEMON_PROTOCOL_VERSION, type JsonObject } from "../../src/app-server/protocol/index.js";
import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";
import { AsyncQueue } from "../../src/utils/async-queue.js";

describe("daemon shutdown progress", () => {
  it.each([1, 2])("completes shutdown when %i acknowledgement writes never settle", async (count) => {
    const completed = vi.fn();
    const coordinator = new AgenCDaemonRpcShutdownCoordinator(completed, 20);
    const sends = Array.from({ length: count }, (_, id) => {
      const result = coordinator.accept("stalled-instance");
      return coordinator.send(
        { jsonrpc: "2.0", id, method: "daemon.shutdown" },
        { jsonrpc: "2.0", id, result },
        () => new Promise<void>(() => {}),
      );
    });
    expect(coordinator.blocksRequests).toBe(true);
    const results = await Promise.allSettled(sends);
    expect(results).toEqual(Array.from({ length: count }, () => ({
      status: "rejected", reason: new Error("daemon shutdown acknowledgement exceeded 20 ms"),
    })));
    expect(completed).toHaveBeenCalledTimes(1);
    expect(coordinator.blocksRequests).toBe(true);
  });

  it.each(["unix", "websocket"])("stops runner work before draining a held %s snapshot RPC", async (kind) => {
    const home = await mkdtemp(join(tmpdir(), "agenc-shutdown-progress-"));
    const env = { AGENC_HOME: home, AGENC_DAEMON_WEBSOCKET_PORT: "0" };
    const host: AgenCDaemonCliHost = {
      env, userHome: home, pid: 4100,
      entrypointPath: "/opt/agenc/bin/agenc.js", execPath: process.execPath,
      readCurrentRuntimeBuild: () => ({ runtimeVersion: "test", commit: "test", buildTime: "test" }),
      readProcessIdentity: (pid) => `test:${pid}`,
      isPidRunning: () => false,
      spawnDetachedDaemon: () => { throw new Error("unexpected detached spawn"); },
      terminatePid: () => {}, sleep: async () => {},
    };
    let logs = "";
    const sink = { write: (chunk: string | Uint8Array) => { logs += String(chunk); return true; } } as Pick<NodeJS.WriteStream, "write">;
    const io: AgenCDaemonCliIo = { stdout: sink, stderr: sink };
    const signal = new EventEmitter();
    const snapshotStarted = Promise.withResolvers<void>();
    const releaseSnapshot = Promise.withResolvers<void>();
    let snapshotHeld = false;
    const stopped = vi.fn(async () => { releaseSnapshot.resolve(); });
    const runner: AgenCBackgroundAgentRunner = {
      startAgent: async () => ({ agentId: "agent-held-snapshot", startedAt: "2026-05-01T12:00:00.000Z", status: "running" }),
      getAgentSnapshot: async () => {
        // Diagnostic reads share the blocked runtime in this fixture. A
        // shutdown refresh must not precede the stop that releases it.
        if (snapshotHeld) await releaseSnapshot.promise;
        return { status: "running", lastActiveAt: "2026-05-01T12:00:00.000Z" };
      },
      stopAgent: stopped,
      snapshotAgentSession: async (_agentId, { sessionId }) => {
        snapshotHeld = true;
        snapshotStarted.resolve();
        await releaseSnapshot.promise;
        return {
          sessionId, turnCount: 0,
          tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
          cacheStats: { requestCount: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, cacheTotalInputTokens: 0, hitRate: null },
        };
      },
    };
    const running = runAgenCDaemonCli({ kind: "command", action: "run" }, { host, io, signalProcess: signal, runner });
    let socket: Socket | WebSocket | undefined;
    try {
      const pidPath = resolveAgenCDaemonPidPath(env, home);
      await expect.poll(() => readAgenCDaemonPid(pidPath), { timeout: 5_000, message: logs }).toBe(4100);
      const authCookie = (await readFile(resolveAgenCDaemonCookiePath(env, home), "utf8")).trim();
      const info = readDaemonRuntimeInfo(resolveAgenCDaemonRuntimeInfoPath(home));
      socket = kind === "unix"
        ? createConnection(resolveAgenCDaemonSocketPath(env, home))
        : new WebSocket(info!.webSocketUrl!);
      const peer = socket;
      const messages = new AsyncQueue<JsonObject>();
      if (peer instanceof WebSocket) {
        peer.on("message", (data) => { messages.send(JSON.parse(data.toString())); });
      } else {
        let buffer = "";
        peer.on("data", (data: Buffer) => {
          buffer += data.toString();
          let newline: number;
          while ((newline = buffer.indexOf("\n")) !== -1) {
            messages.send(JSON.parse(buffer.slice(0, newline)));
            buffer = buffer.slice(newline + 1);
          }
        });
      }
      peer.on("close", () => messages.close());
      await once(peer, peer instanceof WebSocket ? "open" : "connect");
      const request = async (method: string, params: JsonObject) => {
        const payload = JSON.stringify({ jsonrpc: "2.0", id: method, method, params });
        if (peer instanceof WebSocket) peer.send(payload);
        else peer.write(`${payload}\n`);
        for (;;) {
          const response = await messages.recv();
          if (response === null) throw new Error("daemon connection closed");
          if (response.id !== method) continue;
          if (response.error !== undefined) throw new Error(JSON.stringify(response.error));
          return response.result as JsonObject;
        }
      };
      await request("initialize", { protocolVersion: AGENC_DAEMON_PROTOCOL_VERSION, authCookie, capabilities: {} });
      const agent = await request("agent.create", { cwd: process.cwd(), objective: "hold snapshot until shutdown", runtimeOptions: resolveAgentRuntimeOptions({}) });
      const snapshot = request("session.snapshot", { sessionId: agent.sessionId! }).catch(() => undefined);
      await snapshotStarted.promise;
      signal.emit("SIGTERM");
      // The old ordering never invokes stopAgent because socket draining is
      // awaiting this very snapshot. No timing-based release hides that cycle.
      await expect.poll(() => stopped.mock.calls.length, { timeout: 1_000 }).toBe(1);
      await expect(running).resolves.toBe(0);
      await snapshot;
      await expect(readAgenCDaemonPid(pidPath)).resolves.toBeNull();
      expect(logs).not.toContain("request drain exceeded");
    } finally {
      releaseSnapshot.resolve();
      if (socket instanceof WebSocket) socket.terminate();
      else socket?.destroy();
      signal.emit("SIGTERM");
      await running;
      await rm(home, { recursive: true, force: true });
    }
  });
});
