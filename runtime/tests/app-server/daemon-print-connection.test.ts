import { AGENC_DAEMON_PROTOCOL_VERSION } from "../../src/app-server/protocol/index.js";
import { mkdtemp, rm, writeFile, rename, symlink } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDaemonPrintConnectionScope } from "../../src/app-server/daemon-print-connection.js";
import type { AgenCJsonLineDaemonTuiClient } from "../../src/app-server/agent-cli.js";
import { ensureAgenCDaemonAutostart, type AgenCDaemonAutostartOptions } from "../../src/app-server/daemon-autostart.js";
import { resolveAgenCDaemonSocketPath, resolveAgenCDaemonCookiePath, resolveAgenCDaemonPidPath, type AgenCDaemonCliHost } from "../../src/app-server/daemon-control.js";
import { writeDaemonRuntimeInfo, resolveAgenCDaemonRuntimeInfoPath } from "../../src/app-server/daemon-runtime-info.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function nextDisconnect(client: AgenCJsonLineDaemonTuiClient): Promise<void> {
  return new Promise(resolve => {
    const unsubscribe = client.subscribeToConnectionState(state => {
      if (state.status !== "disconnected") return;
      unsubscribe();
      resolve();
    });
  });
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "print-connection-"));
  cleanups.push(() => rm(home, { force: true, recursive: true }));
  const env = { AGENC_HOME: home, AGENC_DAEMON_AUTOSTART: "1", AGENC_DAEMON_REQUEST_TIMEOUT_MS: "150" };
  const socketPath = resolveAgenCDaemonSocketPath(env), cookiePath = resolveAgenCDaemonCookiePath(env);
  const pidPath = resolveAgenCDaemonPidPath(env), infoPath = resolveAgenCDaemonRuntimeInfoPath(home);
  const identity = { pid: 5200, processStart: "test:5200", instanceId: "instance", runtimeVersion: "test", commit: "commit", buildTime: "now" };
  await writeFile(cookiePath, "cookie\n"); await writeFile(pidPath, "5200\n");
  const record = (fields = {}) => writeDaemonRuntimeInfo(infoPath, { ...identity, startedAt: "now", ...fields });
  record();
  const messages: Array<{ method: string; connection: number; protocolVersion?: string }> = [];
  const sockets = new Set<Socket>();
  let connection = 0;
  const behavior: {
    identity: unknown; cookie: string; ping: unknown; maxMinor?: number;
    beforeReply?: (method: string, socket: Socket) => void | Promise<void>;
  } = { identity, cookie: "cookie", ping: { ok: true, now: "now" } };
  const server = createServer(socket => {
    const id = ++connection; sockets.add(socket); socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {}); socket.setEncoding("utf8"); let buffer = "";
    socket.on("data", chunk => {
      buffer += chunk;
      while (buffer.includes("\n")) {
        const newline = buffer.indexOf("\n"); const request = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
        messages.push({ method: request.method, connection: id, protocolVersion: request.params.protocolVersion });
        void (async () => {
          await behavior.beforeReply?.(request.method, socket);
          if (socket.destroyed) return;
          if (request.method === "initialize" && request.params.authCookie !== behavior.cookie) {
            socket.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "unauthorized" } }) + "\n"); return;
          }
          if (request.method === "initialize" && Number(request.params.protocolVersion.split(".")[1]) > (behavior.maxMinor ?? Number(AGENC_DAEMON_PROTOCOL_VERSION.split(".")[1]))) {
            socket.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32602, message: "Unsupported protocol version" } }) + "\n"); return;
          }
          const result = request.method === "initialize"
            ? { type: "initialized", protocolVersion: "1.1.0", capabilities: {}, daemonIdentity: behavior.identity }
            : request.method === "health.ping" ? behavior.ping
              : request.method === "agent.create" ? { agentId: "agent", sessionId: "session" } : {};
          socket.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
        })();
      }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  cleanups.push(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const host: AgenCDaemonCliHost = {
    env, userHome: home, entrypointPath: "/test/agenc.js", execPath: process.execPath, pid: 5100,
    isPidRunning: pid => pid === identity.pid,
    readProcessIdentity: vi.fn(() => identity.processStart),
    readCurrentRuntimeBuild: () => identity,
    spawnDetachedDaemon: () => { throw new Error("unexpected spawn"); },
    terminatePid: () => { throw new Error("unexpected signal"); }, sleep: async () => {},
  };
  const barrier = vi.fn(async () => {});
  const canonical = (options: AgenCDaemonAutostartOptions = {}) => ensureAgenCDaemonAutostart({
    ...options, host, isReady: () => server.listening, identityPublicationBarrier: barrier,
    findOrphanDaemonPids: () => [], findSupersededDaemonPids: () => [],
  });
  const scope = createDaemonPrintConnectionScope(env, canonical);
  cleanups.push(() => scope.close());
  const outer = (options: AgenCDaemonAutostartOptions = {}) => canonical({ ...options, requestDaemonInstanceIdentity: scope.requestDaemonInstanceIdentity });
  const prepare = async () => { await outer(); await scope.ensureDaemonReady(env)(); return scope.createConnectedTuiClient({ env }); };
  return { env, host, server, identity, infoPath, socketPath, cookiePath, pidPath, behavior, messages, sockets, record, barrier, scope, outer, prepare };
}

it("keeps a control-compatible outer proof and retains the current-session second proof", async () => {
  const f = await fixture(); const client = await f.prepare();
  expect(f.barrier).toHaveBeenCalledTimes(2);
  expect(f.host.readProcessIdentity).toHaveBeenCalledTimes(4);
  await expect(client.request("agent.create", { objective: "test" })).resolves.toMatchObject({ agentId: "agent" });
  await client.request("agent.stop", { agentId: "agent" }); await client.close();
  expect(f.messages.map(x => x.method)).toEqual(["initialize", "initialize", "agent.create", "agent.stop"]);
  expect(new Set(f.messages.map(x => x.connection)).size).toBe(2);
  expect(f.messages[1]!.connection).toBe(f.messages[2]!.connection);
});

it.each(["pid", "processStart", "instanceId", "runtimeVersion", "commit", "buildTime"] as const)("refuses a mismatched authenticated %s before any agent RPC", async field => {
  const f = await fixture(); f.behavior.identity = { ...f.identity, [field]: field === "pid" ? 5201 : "other" };
  await expect(f.outer()).rejects.toThrow(); await f.scope.close();
  expect(f.messages.map(x => x.method)).toEqual(["initialize"]);
});

it.each([undefined, {}, { pid: 5200 }])("rejects malformed or missing initialize identity %j", async identity => {
  const f = await fixture(); f.behavior.identity = identity;
  await expect(f.outer()).rejects.toThrow("valid instance identity");
  await tick(); expect(f.messages).toHaveLength(1);
});

it("refuses an auth error without retrying initialization", async () => {
  const f = await fixture(); f.behavior.cookie = "other";
  await expect(f.outer()).rejects.toThrow("unauthorized"); expect(f.messages).toHaveLength(1);
});

it("repeats sidecar/process proof after a successful fresh ping", async () => {
  const f = await fixture(); await f.outer(); await f.scope.ensureDaemonReady(f.env)();
  f.behavior.beforeReply = method => { if (method === "health.ping") f.record({ instanceId: "replaced" }); };
  await expect(f.scope.ensureDaemonReady(f.env)()).rejects.toThrow("sidecar changed");
  await expect(f.scope.createConnectedTuiClient({ env: f.env })).rejects.toThrow();
  expect(f.messages.map(x => x.method)).toEqual(["initialize", "initialize", "health.ping"]);
});

it.each([null, {}, { ok: false, now: "now" }, { ok: true, now: "" }])("refuses malformed ping %j", async ping => {
  const f = await fixture(); await f.outer(); await f.scope.ensureDaemonReady(f.env)(); f.behavior.ping = ping;
  await expect(f.scope.ensureDaemonReady(f.env)()).rejects.toThrow("valid health ping");
  await expect(f.scope.createConnectedTuiClient()).rejects.toThrow();
});

it("freshly authenticates when cookie bytes change before the second proof", async () => {
  const f = await fixture(); await f.outer();
  await writeFile(f.cookiePath, "new-cookie\n"); f.behavior.cookie = "new-cookie";
  await f.scope.ensureDaemonReady(f.env)(); const client = await f.scope.createConnectedTuiClient({ env: f.env });
  await client.request("agent.create", {});
  expect(f.messages.map(x => x.method)).toEqual(["initialize", "initialize", "agent.create"]);
  expect(f.messages[0]!.connection).not.toBe(f.messages[1]!.connection);
});

it.each(["initialize", "health.ping"])("rejects cookie mutation during %s even with the old peer alive", async method => {
  const f = await fixture(); if (method === "health.ping") { await f.outer(); await f.scope.ensureDaemonReady(f.env)(); }
  f.behavior.beforeReply = async observed => { if (observed === method) await writeFile(f.cookiePath, "cookie\n\n"); };
  await expect(method === "initialize" ? f.outer() : f.scope.ensureDaemonReady(f.env)()).rejects.toThrow("connection changed");
  expect(f.messages.some(x => x.method === "agent.create")).toBe(false);
});

it.each(["handoff", "dispatch"])("rejects socket path replacement at %s while the authenticated peer is still alive", async phase => {
  const f = await fixture(); await f.outer(); await f.scope.ensureDaemonReady(f.env)();
  const client = phase === "dispatch" ? await f.scope.createConnectedTuiClient({ env: f.env }) : undefined;
  await rename(f.socketPath, f.socketPath + ".original");
  const replacement = createServer(socket => socket.destroy());
  await new Promise<void>(resolve => replacement.listen(f.socketPath, resolve));
  cleanups.push(() => new Promise<void>(resolve => replacement.close(() => resolve())));
  expect(f.sockets.size).toBe(1);
  await expect(client === undefined ? f.scope.createConnectedTuiClient({ env: f.env }) : client.request("agent.create", {})).rejects.toThrow("connection changed");
  expect(f.messages.map(x => x.method)).toEqual(["initialize", "initialize"]);
});

it("refuses a changed process start token on the second canonical proof", async () => {
  const f = await fixture(); await f.outer();
  vi.mocked(f.host.readProcessIdentity!).mockReturnValue("replacement-process");
  await expect(f.scope.ensureDaemonReady(f.env)()).rejects.toThrow("process start identity changed");
  expect(f.messages.map(x => x.method)).toEqual(["initialize"]);
});

it("refuses a changed cookie at handoff while the original peer remains alive", async () => {
  const f = await fixture(); await f.outer(); await f.scope.ensureDaemonReady(f.env)();
  await writeFile(f.cookiePath, "different-cookie");
  await expect(f.scope.createConnectedTuiClient({ env: f.env })).rejects.toThrow("connection changed");
  expect(f.messages.map(x => x.method)).toEqual(["initialize", "initialize"]);
});

it("settles an unresponsive identity request at the configured deadline", async () => {
  const f = await fixture(); const release = deferred();
  f.behavior.beforeReply = async () => release.promise;
  try { await expect(f.outer()).rejects.toThrow("Timed out"); }
  finally { release.resolve(); }
  expect(f.messages.filter(x => x.method === "initialize")).toHaveLength(1);
});

it("preserves the default control deadline without shortening session requests", async () => {
  const f = await fixture(); f.env.AGENC_DAEMON_REQUEST_TIMEOUT_MS = "";
  const timers = vi.spyOn(globalThis, "setTimeout");
  try {
    await f.outer();
    expect(timers.mock.calls.some(([, delay]) => delay === 2_000)).toBe(true);
    expect(timers.mock.calls.some(([, delay]) => delay === 30_000)).toBe(false);
    timers.mockClear();
    await f.scope.ensureDaemonReady(f.env)();
    expect(timers.mock.calls.some(([, delay]) => delay === 2_000)).toBe(true);
    expect(timers.mock.calls.some(([, delay]) => delay === 30_000)).toBe(false);
    const client = await f.scope.createConnectedTuiClient({ env: f.env });
    timers.mockClear();
    await client.request("agent.create", {});
    expect(timers.mock.calls.some(([, delay]) => delay === 30_000)).toBe(true);
    timers.mockClear();
    await client.request("health.ping");
    expect(timers.mock.calls.some(([, delay]) => delay === 30_000)).toBe(true);
  } finally { timers.mockRestore(); }
});

it("refuses a symlink in place of the socket", async () => {
  const f = await fixture(); await rename(f.socketPath, f.socketPath + ".original"); await symlink(f.socketPath + ".original", f.socketPath);
  await expect(f.outer()).rejects.toThrow("connection changed"); expect(f.messages).toHaveLength(0);
});

it("cannot lend proof to a reconnect after handoff, before first agent.create", async () => {
  const f = await fixture(); const client = await f.prepare();
  const disconnected = nextDisconnect(client);
  for (const socket of f.sockets) socket.destroy();
  await disconnected;
  await expect(client.request("agent.create", {})).rejects.toThrow();
  expect(f.messages.map(x => x.method)).toEqual(["initialize", "initialize"]);
});

it("refuses disconnect during ping without initializing a replacement", async () => {
  const f = await fixture(); await f.outer(); await f.scope.ensureDaemonReady(f.env)(); f.behavior.beforeReply = (method, socket) => { if (method === "health.ping") socket.destroy(); };
  await expect(f.scope.ensureDaemonReady(f.env)()).rejects.toThrow();
  await expect(f.scope.createConnectedTuiClient()).rejects.toThrow();
  expect(f.messages.map(x => x.method)).toEqual(["initialize", "initialize", "health.ping"]);
});

it("marks close synchronously and joins a late initialize before returning", async () => {
  const f = await fixture(); const entered = deferred(), release = deferred();
  f.behavior.beforeReply = async method => { if (method === "initialize") { entered.resolve(); await release.promise; } };
  const failure = expect(f.outer()).rejects.toThrow("connection changed"); await entered.promise;
  // Client close destroys its socket synchronously; the peer observes that
  // close in a later I/O turn, not a fixed number of setImmediate callbacks.
  const peerClosed = Promise.all([...f.sockets].map(socket =>
    new Promise<void>(resolve => socket.once("close", () => resolve()))));
  let closed = false; const closing = f.scope.close().then(() => { closed = true; });
  await tick(); expect(closed).toBe(false); release.resolve(); await closing; await failure;
  await expect(f.scope.createConnectedTuiClient()).rejects.toThrow();
  await peerClosed; expect(f.sockets.size).toBe(0);
});

it("rejects overlapping proof calls without allocating a second transport", async () => {
  const f = await fixture(); const entered = deferred(), release = deferred();
  f.behavior.beforeReply = async method => { if (method === "initialize") { entered.resolve(); await release.promise; } };
  const first = f.outer(); await entered.promise;
  await expect(f.scope.requestDaemonInstanceIdentity({ pid: f.identity.pid, pidPath: f.pidPath })).rejects.toThrow("connection changed");
  release.resolve(); await first;
  expect(f.messages.map(x => x.method)).toEqual(["initialize"]);
});

it("retains the ordinary fresh client if autostart is disabled between proofs", async () => {
  const f = await fixture(); await f.outer(); f.env.AGENC_DAEMON_AUTOSTART = "0";
  await f.scope.ensureDaemonReady(f.env)(); const client = await f.scope.createConnectedTuiClient({ env: f.env });
  await client.request("agent.create", {});
  expect(f.messages.map(x => x.method)).toEqual(["initialize", "initialize", "agent.create"]);
  expect(f.barrier).toHaveBeenCalledOnce();
});

it("keeps ordinary streaming reconnect after successful agent admission", async () => {
  const f = await fixture(); const client = await f.prepare(); await client.request("agent.create", {});
  const disconnected = nextDisconnect(client);
  for (const socket of f.sockets) socket.destroy();
  await disconnected;
  await expect(client.request("health.ping")).resolves.toMatchObject({ ok: true });
  expect(f.messages.map(x => x.method)).toEqual(["initialize", "initialize", "agent.create", "initialize", "health.ping"]);
});

it("forwards cancellation before dispatch without creating an agent", async () => {
  const f = await fixture(); const client = await f.prepare();
  await expect(client.request("agent.create", {}, { signal: AbortSignal.abort("cancelled") })).rejects.toThrow("cancelled");
  expect(f.messages.map(x => x.method)).toEqual(["initialize", "initialize"]);
});


it("authenticates an older daemon with control1.0 before session negotiation", async () => {
  const f = await fixture(); f.behavior.maxMinor = 28;
  await expect(f.outer()).resolves.toMatchObject({ pid: f.identity.pid });
  expect(f.messages.map(x => x.protocolVersion)).toEqual(["1.0.0"]);
  await expect(f.scope.ensureDaemonReady(f.env)()).rejects.toThrow("Unsupported protocol version");
  expect(f.messages.map(x => x.protocolVersion)).toEqual(["1.0.0", AGENC_DAEMON_PROTOCOL_VERSION]);
  expect(f.messages.some(x => x.method === "agent.create")).toBe(false);
});


it("takes an older real Unix peer through canonical build-skew shutdown and replacement", async () => {
  const f = await fixture(); f.behavior.maxMinor = 28;
  const currentBuild = { runtimeVersion: "new", commit: "new-commit", buildTime: "later" };
  let running = true;
  const shutdowns: unknown[] = [];
  Object.assign(f.host, {
    readCurrentRuntimeBuild: () => currentBuild,
    isPidRunning: (pid: number) => running && pid === f.identity.pid,
    spawnDetachedDaemon: (): number => {
      Object.assign(f.identity, currentBuild, { pid: 5201, processStart: "test:5201", instanceId: "new-instance" });
      f.behavior.maxMinor = Number(AGENC_DAEMON_PROTOCOL_VERSION.split(".")[1]); running = true; f.record();
      f.server.listen(f.socketPath);
      return f.identity.pid;
    },
  });
  await expect(f.outer({ requestDaemonShutdown: async expected => {
    shutdowns.push({ ...expected }); running = false;
    await new Promise<void>(resolve => f.server.close(() => resolve()));
  } })).resolves.toMatchObject({ status: "started", pid: 5201 });
  expect(shutdowns).toEqual([expect.objectContaining({ pid: 5200, instanceId: "instance", commit: "commit" })]);
  expect(f.messages.every(message => message.protocolVersion === "1.0.0")).toBe(true);
  await f.scope.ensureDaemonReady(f.env)();
  const client = await f.scope.createConnectedTuiClient({ env: f.env });
  await client.request("agent.create", { objective: "test" });
  expect(f.messages.at(-2)?.protocolVersion).toBe(AGENC_DAEMON_PROTOCOL_VERSION);
  expect(f.messages.at(-1)?.method).toBe("agent.create");
});
