import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type WebSocket from "ws";
import { canonicalRemoteWorkspace, pathWithin, RemoteAccessBoundary } from "../../src/remote/access.js";
import { RemoteService } from "../../src/remote/service.js";
import type { RemoteBackend, RemoteBackendPoll, RemotePairParams } from "../../src/remote/types.js";
import type { AgenCDaemonResponse, JsonObject } from "../../src/app-server/protocol/index.js";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); vi.useRealTimers(); });
class Socket extends EventEmitter {
  readyState = 0; bufferedAmount = 0;
  sent: string[] = [];
  send(value: string) { this.sent.push(value); }
  terminate() { if (this.readyState === 3) return; this.readyState = 3; this.emit("close"); }
  open() { this.readyState = 1; this.emit("open"); }
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
function fixture() {
  vi.useFakeTimers();
  const root = realpathSync(mkdtempSync(join(tmpdir(), "remote-test-")));
  const workspace = join(root, "workspace"); const privateHome = join(root, "private");
  mkdirSync(workspace); mkdirSync(privateHome);
  const sockets: Socket[] = []; const boundaries: RemoteAccessBoundary[] = [];
  let workspaceId = "";
  const pair = { pairingId: "pair-1", hostSecret: "fixture-host-secret", code: "ABCD1234", pairUrl: "https://connect.example/#code=ABCD1234", expiresAt: new Date(Date.now() + 180_000).toISOString(), relayUrl: "wss://relay.example" };
  const poll = (active = false): RemoteBackendPoll => ({ pairingId: pair.pairingId, status: active ? "active" : "claimed", device: { deviceId: "device-1", label: "Browser", role: "control", workspaceIds: [workspaceId] }, ...(active ? { hostTicket: "fixture-ticket", ticketExpiresAt: new Date(Date.now() + 300_000).toISOString() } : {}) });
  const backend: RemoteBackend = {
    start: vi.fn(async (params) => { workspaceId = params.workspaceIds[0]!; return pair; }),
    poll: vi.fn(async () => poll()), approve: vi.fn(async () => poll(true)), revoke: vi.fn(async () => {}),
  };
  const dispatch = vi.fn(async (message: JsonObject): Promise<AgenCDaemonResponse> => ({ jsonrpc: "2.0", id: message.id as string, result: { ok: true } }));
  const lookup = vi.fn(async (sessionId: string) => sessionId === "allowed" ? { sessionId, cwd: workspace, title: "Allowed", runtimeOptions: { credentials: "private" } } : sessionId === "outside" ? { sessionId, cwd: root } : null);
  const service = new RemoteService({ home: privateHome, backend, lookupSession: lookup, socket: () => { const socket = new Socket(); sockets.push(socket); return socket as unknown as WebSocket; }, qrDataUrl: async () => "data:image/png;base64,fixture", createConnection: (boundary) => {
    boundaries.push(boundary);
    return { dispatch: async (message) => { await boundary.authorize(message.method as string, message.params as JsonObject ?? {}); return dispatch(message); }, close: vi.fn(async () => {}) };
  } });
  cleanups.push(() => { service.stop(); rmSync(root, { recursive: true, force: true }); });
  const params: RemotePairParams = { workspacePath: workspace, sessionIds: ["allowed"], role: "control", allowFiles: true, allowApprovals: true };
  async function approve() { service.start(); await service.begin(params); await vi.advanceTimersByTimeAsync(1_500); await service.approve("device-1"); sockets[0]!.open(); }
  function frame(id: string, method = "session.transcript.v2", params: JsonObject = { sessionId: "allowed" }) {
    return JSON.stringify({ t: "data", cid: "peer-1", deviceId: "device-1", role: "control", workspaceIds: [workspaceId], payload: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
  }
  return { root, privateHome, workspace, backend, service, params, pair, poll, approve, sockets, dispatch, boundaries, frame, lookup };
}

describe("daemon browser remote lifecycle", () => {
  it("is disabled by default and idempotent; capability inspection creates no pairing", () => {
    const f = fixture(); expect(f.service.status().state).toBe("stopped");
    expect(f.service.capabilities().requiresLocalApproval).toBe(true);
    expect(f.service.start()).toEqual(f.service.start()); expect(f.backend.start).not.toHaveBeenCalled();
    expect(f.service.stop()).toEqual(f.service.stop());
  });
  it("requires an explicit local approval before obtaining a host socket", async () => {
    const f = fixture(); f.service.start(); await f.service.begin(f.params); await vi.advanceTimersByTimeAsync(1_500);
    expect(f.service.status().pairing?.deviceId).toBe("device-1"); expect(f.sockets).toHaveLength(0);
    expect(JSON.stringify(f.service.status())).not.toContain("fixture-host-secret");
    await expect(f.service.approve("unclaimed")).rejects.toMatchObject({ code: "REMOTE_DEVICE_NOT_PENDING" });
    await f.service.approve("device-1"); expect(f.sockets).toHaveLength(1);
    expect(JSON.stringify(f.service.status())).not.toContain("fixture-ticket");
  });
  it("stopping closes sockets immediately and late ticket refresh cannot reconnect", async () => {
    const f = fixture(); await f.approve();
    const pending = deferred<RemoteBackendPoll>(); vi.mocked(f.backend.poll).mockImplementation(() => pending.promise);
    f.sockets[0]!.terminate(); await vi.advanceTimersByTimeAsync(2_000);
    f.service.stop(); pending.resolve(f.poll(true)); await vi.advanceTimersByTimeAsync(100_000);
    expect(f.sockets).toHaveLength(1); expect(f.service.status().state).toBe("stopped");
  });
  it("stopping during pair creation cannot restore a code or active state", async () => {
    const f = fixture(); const pending = deferred<typeof f.pair>();
    vi.mocked(f.backend.start).mockImplementation(() => pending.promise); f.service.start();
    const start = f.service.begin(f.params); await vi.advanceTimersByTimeAsync(0);
    f.service.stop(); f.service.start(); pending.resolve(f.pair);
    await expect(start).rejects.toMatchObject({ code: "REMOTE_OPERATION_CANCELLED" });
    expect(f.service.status().pairing).toBeNull(); expect(f.backend.revoke).toHaveBeenCalled();
  });
  it("pending requests are cancelled and a delayed approval cannot revive stopped access", async () => {
    const f = fixture(); f.service.start(); await f.service.begin(f.params); await vi.advanceTimersByTimeAsync(1_500);
    const pending = deferred<RemoteBackendPoll>(); vi.mocked(f.backend.approve).mockImplementation(() => pending.promise);
    const approval = f.service.approve("device-1"); f.service.stop(); pending.resolve(f.poll(true));
    await expect(approval).rejects.toMatchObject({ code: "REMOTE_OPERATION_CANCELLED" }); expect(f.sockets).toHaveLength(0);
  });
  it("cancelling in-flight pairing fences late backend responses without disabling other devices", async () => {
    const f = fixture(); const pending = deferred<typeof f.pair>();
    vi.mocked(f.backend.start).mockImplementation(() => pending.promise); f.service.start();
    const start = f.service.begin(f.params); await vi.advanceTimersByTimeAsync(0);
    f.service.cancelPair(); pending.resolve(f.pair);
    await expect(start).rejects.toMatchObject({ code: "REMOTE_OPERATION_CANCELLED" });
    expect(f.service.status()).toMatchObject({ enabled: true, pairing: null, error: null });
  });
  it("rejects forged relay identity and replay after reconnect, with bounded request processing", async () => {
    const f = fixture(); await f.approve(); const socket = f.sockets[0]!;
    socket.emit("message", f.frame("forged").replace('"deviceId":"device-1"', '"deviceId":"forged"'));
    expect(f.dispatch).not.toHaveBeenCalled();
    const mutation = f.frame("one", "message.send", { sessionId: "allowed", content: "hello", clientMessageId: "one", ifBusy: "reject" });
    socket.emit("message", mutation); await vi.advanceTimersByTimeAsync(0);
    socket.emit("message", mutation); await vi.advanceTimersByTimeAsync(0);
    expect(f.dispatch).toHaveBeenCalledTimes(1); expect(socket.sent.join("")).toContain("REMOTE_REPLAY_DENIED");
    vi.mocked(f.backend.poll).mockImplementation(async () => f.poll(true)); socket.terminate(); await vi.advanceTimersByTimeAsync(2_000); f.sockets[1]!.open();
    f.sockets[1]!.emit("message", mutation); expect(f.sockets[1]!.sent.join("")).toContain("REMOTE_REPLAY_DENIED");
  });
  it("allows polling and cancellation while a message request awaits a long turn", async () => {
    const f = fixture(); await f.approve();
    const pending = deferred<AgenCDaemonResponse>();
    f.dispatch.mockImplementation(async (message) => message.method === "message.send" ? pending.promise : { jsonrpc: "2.0", id: message.id as string, result: { ok: true } });
    f.sockets[0]!.emit("message", f.frame("send", "message.send", { sessionId: "allowed", content: "hello", clientMessageId: "send", ifBusy: "reject" }));
    await vi.advanceTimersByTimeAsync(0);
    f.sockets[0]!.emit("message", f.frame("poll"));
    f.sockets[0]!.emit("message", f.frame("cancel", "session.cancelTurn", { sessionId: "allowed" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.dispatch.mock.calls.map(([message]) => message.method)).toEqual(["message.send", "session.transcript.v2", "session.cancelTurn"]);
    expect(f.sockets[0]!.sent).toHaveLength(2);
    pending.resolve({ jsonrpc: "2.0", id: "send", result: { done: true } });
    await vi.advanceTimersByTimeAsync(0); expect(f.sockets[0]!.sent).toHaveLength(3);
  });
  it("read-only polling does not consume the mutation replay ledger", async () => {
    const f = fixture(); await f.approve();
    for (let i = 0; i < 4100; i++) { f.sockets[0]!.emit("message", f.frame(`poll-${i}`)); await vi.advanceTimersByTimeAsync(0); }
    f.sockets[0]!.emit("message", f.frame("mutation", "session.cancelTurn", { sessionId: "allowed" })); await vi.advanceTimersByTimeAsync(0);
    expect(f.dispatch).toHaveBeenCalledTimes(4101);
  });
  it("revocation fences old boundaries immediately and closes their transport", async () => {
    const f = fixture(); await f.approve(); f.sockets[0]!.emit("message", f.frame("one")); await vi.advanceTimersByTimeAsync(0);
    f.service.revoke("device-1"); expect(f.sockets[0]!.readyState).toBe(3);
    await expect(f.boundaries[0]!.authorize("session.transcript.v2", { sessionId: "allowed" })).rejects.toMatchObject({ code: "REMOTE_ACCESS_REVOKED" });
  });
  it("validates every selected session before making a backend request", async () => {
    const f = fixture(); f.service.start(); await expect(f.service.begin({ ...f.params, sessionIds: ["outside"] })).rejects.toMatchObject({ code: "REMOTE_SESSION_DENIED" }); expect(f.backend.start).not.toHaveBeenCalled();
  });
});

describe("browser workspace boundary", () => {
  it("handles Windows drives, separators and case without prefix confusion", () => {
    expect(pathWithin("C:\\Work\\Project", "c:\\work\\PROJECT\\src\\a.ts", "win32")).toBe(true);
    expect(pathWithin("C:\\Work\\Project", "C:\\Work\\Project-old\\a.ts", "win32")).toBe(false);
    expect(pathWithin("C:\\Work\\Project", "D:\\Work\\Project", "win32")).toBe(false);
    expect(pathWithin("/work/Project", "/work/project/a", "linux")).toBe(false);
    expect(pathWithin("/work/project", "/work/project/../private", "darwin")).toBe(false);
  });
  it("excludes the private home even when a caller supplies a symlink alias", () => {
    const f = fixture(); const alias = join(f.root, "private-alias");
    symlinkSync(f.privateHome, alias, process.platform === "win32" ? "junction" : "dir");
    expect(() => canonicalRemoteWorkspace(f.privateHome, alias)).toThrow("REMOTE_WORKSPACE_INVALID");
    expect(() => canonicalRemoteWorkspace(f.workspace, join(f.root, "missing-home"))).toThrow();
  });
  it("denies all daemon, config and unscoped methods even to a controller", async () => {
    const f = fixture(); const grant = { ...f.params, workspaceId: "workspace", allowFiles: true, allowApprovals: true };
    const access = new RemoteAccessBoundary(grant, () => true, f.lookup, f.privateHome);
    for (const method of ["remote.approve", "auth.whoami", "agent.attach", "session.applyConfig", "permission.list", "commandExec.start", "session.create", "project.trustStatus", "project.trust"]) await expect(access.authorize(method, { sessionId: "allowed" })).rejects.toMatchObject({ code: "REMOTE_METHOD_DENIED" });
    await expect(access.authorize("session.transcript.v2", { sessionId: "outside" })).rejects.toMatchObject({ code: "REMOTE_SESSION_DENIED" });
    expect(JSON.stringify(await access.sessions())).not.toMatch(/cwd|credentials|runtimeOptions/);
  });
  it("viewers cannot send messages or approve tools; controllers cannot expand approval scope", async () => {
    const f = fixture(); const base = { ...f.params, workspaceId: "workspace", allowFiles: true, allowApprovals: true };
    const viewer = new RemoteAccessBoundary({ ...base, role: "view" }, () => true, f.lookup, f.privateHome);
    await expect(viewer.authorize("message.send", { sessionId: "allowed" })).rejects.toMatchObject({ code: "REMOTE_CONTROL_DENIED" });
    const controller = new RemoteAccessBoundary(base, () => true, f.lookup, f.privateHome);
    await expect(controller.authorize("tool.approve", { sessionId: "allowed", requestId: "request", scope: "session" })).rejects.toMatchObject({ code: "REMOTE_APPROVAL_DENIED" });
    await expect(controller.authorize("tool.approve", { sessionId: "allowed", requestId: "request", scope: "once" })).resolves.toBeUndefined();
    await expect(controller.authorize("message.send", { sessionId: "allowed", content: "hi", clientMessageId: "stable", ifBusy: "reject", metadata: {} })).rejects.toMatchObject({ code: "REMOTE_MESSAGE_INVALID" });
  });
  it("reads ordinary files but rejects traversal, symlinks, hidden configuration and key files", () => {
    const f = fixture(); writeFileSync(join(f.workspace, "hello.ts"), "hello"); writeFileSync(join(f.workspace, ".env"), "secret"); writeFileSync(join(f.privateHome, "secret"), "secret");
    symlinkSync(f.privateHome, join(f.workspace, "linked"), process.platform === "win32" ? "junction" : "dir");
    const access = new RemoteAccessBoundary({ ...f.params, workspaceId: "workspace", allowFiles: true, allowApprovals: false }, () => true, f.lookup, f.privateHome);
    expect(access.files("files.read", { path: "hello.ts" }).content).toBe("hello");
    for (const file of ["../private/secret", "linked/secret", ".env", "auth.json", "private.key", "hello.ts:secret"]) expect(() => access.files("files.read", { path: file })).toThrow();
    expect(access.files("files.list", { path: "" }).entries).toEqual([{ name: "hello.ts", type: "file" }]);
  });
});
