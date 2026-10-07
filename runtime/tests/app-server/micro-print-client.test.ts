import { mkdtemp, rm, writeFile, rename, symlink, mkdir } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { resolveAgenCDaemonSocketPath, resolveAgenCDaemonCookiePath, resolveAgenCDaemonPidPath } from "../../src/app-server/daemon-discovery.js";
import { resolveAgenCDaemonRuntimeInfoPath, writeDaemonRuntimeInfo } from "../../src/app-server/daemon-runtime-info.js";
import { openResidentPrintConnection } from "../../src/app-server/micro-print-connection.js";
import { MicroPrintTransport, MICRO_PRINT_MAX_FRAME_BYTES, writeMicroOutput } from "../../src/app-server/micro-print-transport.js";
import { tryMicroPrint, type MicroPrintInvocation } from "../../src/bin/micro-print-client.js";
import { AGENC_DAEMON_PROTOCOL_VERSION } from "../../src/app-server/protocol/index.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "micro-print-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const env = { AGENC_HOME: home, AGENC_DAEMON_REQUEST_TIMEOUT_MS: "150" };
  const socketPath = resolveAgenCDaemonSocketPath(env), cookiePath = resolveAgenCDaemonCookiePath(env);
  const infoPath = resolveAgenCDaemonRuntimeInfoPath(home);
  const identity = { pid: 5200, processStart: "test:5200", instanceId: "instance", runtimeVersion: "test", commit: "commit", buildTime: "now" };
  await writeFile(cookiePath, "cookie\n"); await writeFile(resolveAgenCDaemonPidPath(env), "5200\n");
  await mkdir(join(home, "dist")); await writeFile(join(home, "dist/VERSION"), JSON.stringify(identity));
  const record = (fields = {}) => writeDaemonRuntimeInfo(infoPath, { ...identity, startedAt: "now", ...fields }); record();
  const messages: Array<{ method: string; params: Record<string, any>; connection: number }> = [];
  const sockets = new Set<Socket>(); let nextConnection = 0;
  let invokeId: number | undefined, invocationId: string | undefined;
  const behavior: {
    identity: unknown; cookie: string; protocol: string; capability: boolean; ping: unknown; exitCode: number;
    beforeReply?: (method: string, socket: Socket) => void | Promise<void>;
    invoke?: (socket: Socket) => void;
    admit?: (socket: Socket) => void;
  } = { identity, cookie: "cookie", protocol: AGENC_DAEMON_PROTOCOL_VERSION, capability: true, ping: { ok: true, now: "now" }, exitCode: 0 };
  const send = (socket: Socket, message: unknown) => socket.write(JSON.stringify(message) + "\n");
  const notice = (socket: Socket, method: string, params: Record<string, unknown>) => send(socket, { jsonrpc: "2.0", method, params: { invocationId, ...params } });
  const result = (socket: Socket, value: unknown) => send(socket, { jsonrpc: "2.0", id: invokeId, result: value });
  const server = createServer(socket => {
    const connection = ++nextConnection; sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.on("error", () => {});
    let buffer = ""; socket.setEncoding("utf8");
    socket.on("data", chunk => {
      buffer += chunk;
      while (buffer.includes("\n")) {
        const end = buffer.indexOf("\n"); const request = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        messages.push({ method: request.method, params: request.params, connection });
        void (async () => {
          await behavior.beforeReply?.(request.method, socket);
          if (socket.destroyed) return;
          if (request.method === "initialize" && (request.params.authCookie !== behavior.cookie || behavior.protocol !== AGENC_DAEMON_PROTOCOL_VERSION)) {
            send(socket, { jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "unsupported or unauthorized" } }); return;
          }
          if (request.method === "print.invoke") {
            invokeId = request.id; invocationId = request.params.invocationId;
            if (behavior.invoke) behavior.invoke(socket); else notice(socket, "print.admission", { challenge: "challenge" });
            return;
          }
          const response = request.method === "initialize"
            ? { type: "initialized", protocolVersion: behavior.protocol, capabilities: { "print.invoke.v1": behavior.capability }, daemonIdentity: behavior.identity }
            : request.method === "health.ping" ? behavior.ping : {};
          send(socket, { jsonrpc: "2.0", id: request.id, result: response });
          if (request.method === "print.admit") {
            if (behavior.admit) behavior.admit(socket); else notice(socket, "print.output", { sequence: 1, stream: "stdout", data: "hello π\n" });
          }
          if (request.method === "print.ack") result(socket, { kind: "exit", exitCode: behavior.exitCode });
          if (request.method === "print.cancel") result(socket, { kind: "exit", exitCode: 130 });
        })();
      }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  cleanup.push(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const barrier = vi.fn(async () => {}), readProcessIdentity = vi.fn(() => identity.processStart);
  const open = () => openResidentPrintConnection(env, home, { userHome: home, publicationBarrier: barrier, isPidRunning: pid => pid === identity.pid, readProcessIdentity });
  let stdout = "", stderr = "";
  const io = { stdout: new Writable({ write(chunk, _encoding, callback) { stdout += chunk.toString(); callback(); } }),
    stderr: new Writable({ write(chunk, _encoding, callback) { stderr += chunk.toString(); callback(); } }), signals: new EventEmitter() as unknown as NodeJS.Process };
  const invocation: MicroPrintInvocation = { argv: ["-p", "hello"], cwd: home, env, caller: { pid: 5100, stdinIsTTY: false, stdoutIsTTY: false, stderrIsTTY: false } };
  const run = () => tryMicroPrint(invocation, home, io, open);
  return { home, env, identity, behavior, record, cookiePath, socketPath, infoPath, messages, sockets, open, barrier, readProcessIdentity, io, invocation, run, notice, result, stdout: () => stdout, stderr: () => stderr };
}

it("runs both canonical proofs and bounded output on one immutable connection", async () => {
  const f = await fixture();
  expect(await f.run()).toBe(0);
  expect(f.stdout()).toBe("hello π\n"); expect(f.stderr()).toBe("");
  expect(f.barrier).toHaveBeenCalledTimes(2); expect(f.readProcessIdentity).toHaveBeenCalledTimes(4);
  expect(f.messages.map(m => m.method)).toEqual(["initialize", "print.invoke", "health.ping", "print.admit", "print.ack"]);
  expect(f.messages[0]!.params.capabilities).toEqual({ "print.invoke.v1": true });
  expect(new Set(f.messages.map(m => m.connection)).size).toBe(1);
});
it.each(["pid", "processStart", "instanceId", "runtimeVersion", "commit", "buildTime"])("refuses changed authenticated %s", async field => {
  const f = await fixture(); f.behavior.identity = { ...f.identity, [field]: field === "pid" ? 5300 : "other" };
  expect(await f.run()).toBe(null); expect(f.messages.map(m => m.method)).toEqual(["initialize"]);
});
it.each(["absent", "protocol", "capability", "auth", "build"])("selects canonical fallback before invocation for %s", async kind => {
  const f = await fixture();
  if (kind === "absent") await rm(resolveAgenCDaemonPidPath(f.env));
  if (kind === "protocol") f.behavior.protocol = "1.28.0";
  if (kind === "capability") f.behavior.capability = false;
  if (kind === "auth") f.behavior.cookie = "other";
  if (kind === "build") await writeFile(join(f.home, "dist/VERSION"), JSON.stringify({ ...f.identity, commit: "different" }));
  expect(await f.run()).toBe(null); expect(f.messages.some(m => m.method === "print.invoke")).toBe(false);
});
it.each(["sidecar", "process", "cookie", "socket"])("refuses %s mutation at the second proof", async kind => {
  const f = await fixture();
  f.behavior.beforeReply = async method => {
    if (method !== "health.ping") return;
    if (kind === "sidecar") f.record({ instanceId: "changed" });
    if (kind === "process") f.readProcessIdentity.mockReturnValue("changed");
    if (kind === "cookie") await writeFile(f.cookiePath, "cookie\n\n");
    if (kind === "socket") { await rename(f.socketPath, f.socketPath + ".old"); await symlink(f.socketPath + ".old", f.socketPath); }
  };
  expect(await f.run()).toBe(null); expect(f.messages.some(m => m.method === "print.admit")).toBe(false);
});
it("crosses the publication barrier again after preflight", async () => {
  const f = await fixture();
  f.barrier.mockImplementation(async () => { if (f.barrier.mock.calls.length === 2) throw new Error("held"); });
  expect(await f.run()).toBe(null); expect(f.messages.some(m => m.method === "print.admit")).toBe(false);
});
it("never returns fallback when the admission reply is lost", async () => {
  const f = await fixture(); f.behavior.beforeReply = (method, socket) => { if (method === "print.admit") socket.destroy(); };
  expect(await f.run()).toBe(1); expect(f.messages.filter(m => m.method === "print.invoke")).toHaveLength(1);
  expect(f.stderr()).toBe("agenc: Daemon print connection failed\n");
});
it("returns definite unsupported fallback without output", async () => {
  const f = await fixture(); f.behavior.invoke = socket => f.result(socket, { kind: "fallback" });
  expect(await f.run()).toBe(null); expect(f.stdout()).toBe("");
});
it("preserves refusal output and exit status without admitting a session", async () => {
  const f = await fixture(); f.behavior.invoke = socket => f.notice(socket, "print.output", { sequence: 1, stream: "stderr", data: "refusal\n" });
  f.behavior.exitCode = 2;
  expect(await f.run()).toBe(2); expect(f.stderr()).toBe("refusal\n"); expect(f.messages.some(m => m.method === "print.admit")).toBe(false);
});
it("does not acknowledge output until the sink write completes and drains", async () => {
  const f = await fixture(); let release!: () => void;
  f.io.stdout = new Writable({ highWaterMark: 1, write(_chunk, _encoding, callback) { release = callback; } });
  const done = f.run();
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  expect(f.messages.some(m => m.method === "print.ack")).toBe(false);
  release(); expect(await done).toBe(0);
});
it("closes instead of growing an unbounded queue behind a stalled output", async () => {
  const f = await fixture(); f.io.stdout = new Writable({ highWaterMark: 1, write() {} });
  f.behavior.admit = socket => {
    for (let sequence = 1; sequence <= 300; sequence++) f.notice(socket, "print.output", { sequence, stream: "stdout", data: "x".repeat(8192) });
  };
  expect(await f.run()).toBe(1); expect(f.messages.some(m => m.method === "print.ack")).toBe(false);
});
it.each([["SIGINT", 130], ["SIGTERM", 0], ["SIGHUP", 130]] as const)("maps %s cancellation and removes listeners", async (signal, code) => {
  const f = await fixture(); f.behavior.admit = () => f.io.signals.emit(signal);
  expect(await f.run()).toBe(code);
  expect(f.messages.find(m => m.method === "print.cancel")?.params.signal).toBe(signal);
  expect(f.io.signals.listenerCount(signal)).toBe(0);
});
it("does not connect for an oversized environment envelope", async () => {
  const f = await fixture(); f.invocation.env.OVERSIZE = "x".repeat(MICRO_PRINT_MAX_FRAME_BYTES);
  expect(await f.run()).toBe(null); expect(f.messages).toHaveLength(0);
});
it("cancellation releases a blocked sink callback without claiming delivery", async () => {
  const sink = new Writable({ highWaterMark: 1, write() {} }), abort = new AbortController();
  const delivery = writeMicroOutput(sink, "blocked", abort.signal); abort.abort();
  await expect(delivery).rejects.toThrow(); expect(sink.listenerCount("drain")).toBe(0);
});
it("bounds pending RPCs and closes all waiters", async () => {
  const f = await fixture(); f.behavior.beforeReply = () => new Promise(() => {});
  const client = await MicroPrintTransport.connect(f.socketPath, 150);
  const pending = Array.from({ length: 8 }, () => client.request("health.ping", {}).catch(() => "closed"));
  expect(() => client.request("health.ping", {})).toThrow(); client.close();
  expect(await Promise.all(pending)).toEqual(Array(8).fill("closed"));
});
