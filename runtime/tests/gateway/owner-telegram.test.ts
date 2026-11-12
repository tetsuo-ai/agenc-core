import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OwnerTelegramService } from "../../src/gateway/owner-telegram.js";
import type { OwnerTelegramBinding } from "../../src/gateway/owner-telegram-types.js";
import type { TelegramTransport, TelegramUpdate } from "../../src/gateway/telegram-channel.js";
import type { AgenCDaemonResponse, JsonObject } from "../../src/app-server/protocol/index.js";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); vi.useRealTimers(); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
function fixture() {
  vi.useFakeTimers(); const root = realpathSync(mkdtempSync(join(tmpdir(), "owner-telegram-"))); const home = join(root, "home"); const workspace = join(root, "workspace"); mkdirSync(home); mkdirSync(workspace);
  let binding: OwnerTelegramBinding | null = null; let token: string | undefined; let sequence = 0;
  const batches: TelegramUpdate[][] = [];
  const transport: TelegramTransport = { getMe: vi.fn(async () => ({ id: 12, username: "owner_bot" })), getUpdates: vi.fn(async () => batches.shift() ?? []), sendMessage: vi.fn(async () => ({ message_id: 1 })), editMessageText: vi.fn(async () => {}) };
  const storage = { load: vi.fn(() => binding), save: vi.fn((value: OwnerTelegramBinding) => { binding = value; }), token: vi.fn(() => token), setToken: vi.fn((value: string) => { token = value; }), revoke: vi.fn(() => { binding = null; token = undefined; }) };
  const createSession = vi.fn(async () => ({ sessionId: `session-${++sequence}`, agentId: `agent-${sequence}` }));
  const invoke = vi.fn(async (message: JsonObject): Promise<AgenCDaemonResponse> => ({ jsonrpc: "2.0", id: message.id as string, result: message.method === "session.transcript.v2" ? { messages: [{ role: "assistant", text: "Completed work." }] } : {} }));
  const service = new OwnerTelegramService({ home, storage, lookupSession: async (sessionId) => ({ sessionId, cwd: workspace }), createSession, transport: () => transport, createConnection: (access) => ({
    async dispatch(message) {
      const params = message.params as JsonObject ?? {}; await access.authorize(message.method as string, params);
      if (message.method === "session.create") return { jsonrpc: "2.0", id: message.id as string, result: await access.createSession(params) };
      return invoke(message);
    }, close: vi.fn(async () => {}),
  }) });
  const config = { token: "12345:fixture_token_123456789", ownerUserId: "123456", workspacePath: workspace };
  const update = (id: number, text: string, changes: Partial<NonNullable<TelegramUpdate["message"]>> = {}): TelegramUpdate => ({ update_id: id, message: { message_id: id, date: Math.floor(Date.now() / 1000), chat: { id: 123456, type: "private" }, from: { id: 123456, is_bot: false }, text, ...changes } });
  async function deliver(...updates: TelegramUpdate[]) { batches.push(updates); await vi.advanceTimersByTimeAsync(101); }
  async function start() { service.configure(config); await service.start(); await vi.advanceTimersByTimeAsync(0); }
  const request = (sessionId: string, requestId: string): void => service.observeSessionEvent(sessionId, { method: "event.permission_request", params: { requestId } });
  const notices = (): number => vi.mocked(transport.sendMessage).mock.calls.filter(([, text]) => text.includes("needs permission to continue")).length;
  cleanups.push(() => { service.stop(); rmSync(root, { recursive: true, force: true }); });
  return { service, config, storage, transport, createSession, invoke, update, deliver, start, batches, request, notices };
}

describe("managed private Telegram owner control", () => {
  it("stores the token separately, never returns it, and stays disabled until explicit start", () => {
    const f = fixture(); expect(f.storage.token).not.toHaveBeenCalled(); expect(f.transport.getMe).not.toHaveBeenCalled();
    f.service.configure(f.config); expect(f.service.status()).toMatchObject({ configured: true, enabled: false, state: "stopped", ownerChatId: "123456" });
    expect(JSON.stringify(f.service.status())).not.toContain(f.config.token); expect(JSON.stringify(f.storage.save.mock.calls)).not.toContain(f.config.token);
    expect(f.transport.getMe).not.toHaveBeenCalled();
  });
  it("rejects group chat bindings and invalid owner identity before credential persistence", () => {
    const f = fixture(); expect(() => f.service.configure({ ...f.config, ownerChatId: "-123456" })).toThrow();
    expect(() => f.service.configure({ ...f.config, ownerUserId: "*" })).toThrow(); expect(f.storage.setToken).not.toHaveBeenCalled();
  });
  it("silently rejects groups, foreign users, bots, forwards and edited messages", async () => {
    const f = fixture(); await f.start();
    const forwarded = f.update(5, "hello"); Object.assign(forwarded.message!, { forward_origin: { type: "user" } });
    await f.deliver(f.update(1, "hello", { chat: { id: -123456, type: "group" } }), f.update(2, "hello", { from: { id: 42 } }), f.update(3, "hello", { chat: { id: 42, type: "private" } }), f.update(4, "hello", { from: { id: 123456, is_bot: true } }), forwarded, { update_id: 6, edited_message: f.update(6, "hello").message });
    expect(f.createSession).not.toHaveBeenCalled(); expect(f.transport.sendMessage).not.toHaveBeenCalled();
  });
  it("limits the owner to chat, new, status and cancel and keeps requests workspace bound", async () => {
    const f = fixture(); await f.start(); await f.deliver(f.update(1, "/new"));
    expect(f.createSession).toHaveBeenCalledWith(f.config.workspacePath, "Telegram owner session", expect.any(AbortSignal));
    await f.deliver(f.update(2, "Implement this change"));
    const prompt = f.invoke.mock.calls.map(([message]) => message).find((message) => message.method === "message.send");
    expect(prompt?.params).toMatchObject({ sessionId: "session-1", content: "Implement this change", clientMessageId: "telegram:123456:2", ifBusy: "reject" });
    await f.deliver(f.update(3, "/approve anything"));
    expect(f.invoke.mock.calls.some(([message]) => message.method === "tool.approve")).toBe(false);
    expect(f.transport.sendMessage).toHaveBeenCalledWith("123456", "Completed work.");
  });
  it("persists update replay progress before effects and does not repeat a delivered prompt", async () => {
    const f = fixture(); await f.start(); await f.deliver(f.update(1, "hello")); await f.deliver(f.update(1, "hello"));
    expect(f.invoke.mock.calls.filter(([message]) => message.method === "message.send")).toHaveLength(1);
    expect(f.storage.save).toHaveBeenLastCalledWith(expect.objectContaining({ lastUpdateId: 1 }));
  });
  it("does not execute queued messages sent before this activation", async () => {
    const f = fixture(); await f.start(); await f.deliver(f.update(1, "old workspace command", { date: Math.floor(Date.now() / 1000) - 100 }));
    expect(f.createSession).not.toHaveBeenCalled();
  });
  it("fails closed if token storage succeeds but binding persistence fails", async () => {
    const f = fixture(); f.service.configure(f.config);
    f.storage.save.mockImplementationOnce(() => { throw new Error("fixture storage failure"); });
    expect(() => f.service.configure({ ...f.config, token: "98765:different_fixture_token_123456" })).toThrow("TELEGRAM_CREDENTIAL_STORAGE_UNAVAILABLE");
    await expect(f.service.start()).rejects.toMatchObject({ code: "TELEGRAM_CONFIGURATION_MISMATCH" });
    expect(f.transport.getMe).not.toHaveBeenCalled();
  });
  it("keeps cancel and status available during a long-running prompt", async () => {
    const f = fixture(); const turn = deferred<AgenCDaemonResponse>();
    f.invoke.mockImplementation(async (message) => message.method === "message.send" ? turn.promise : { jsonrpc: "2.0", id: message.id as string, result: {} });
    await f.start(); await f.deliver(f.update(1, "hello")); await f.deliver(f.update(2, "/status")); await f.deliver(f.update(3, "/cancel"));
    expect(f.invoke.mock.calls.some(([message]) => message.method === "session.cancelTurn")).toBe(true);
    expect(f.transport.sendMessage).toHaveBeenCalledWith("123456", expect.stringContaining("working"));
    turn.resolve({ jsonrpc: "2.0", id: "turn", result: {} }); await vi.advanceTimersByTimeAsync(0);
  });
  it("notifies only its current session to obtain permission on the host", async () => {
    const f = fixture(); await f.start(); await f.deliver(f.update(1, "/new"));
    const event = { method: "event.permission_request", params: { requestId: "request", input: { secret: "must-not-send" } } };
    f.service.observeSessionEvent("other", event); f.service.observeSessionEvent("session-1", event); await vi.advanceTimersByTimeAsync(0);
    expect(f.transport.sendMessage).toHaveBeenCalledWith("123456", expect.stringContaining("on the host"));
    expect(JSON.stringify(vi.mocked(f.transport.sendMessage).mock.calls)).not.toContain("must-not-send");
  });
  it("announces every distinct permission request, including the 101st in one run", async () => {
    const f = fixture(); await f.start(); await f.deliver(f.update(1, "/new"));
    for (let index = 0; index <= 100; index++) f.request("session-1", `request-${index}`);
    await vi.advanceTimersByTimeAsync(0); expect(f.notices()).toBe(101);
  });
  it("announces a repeated permission request id once", async () => {
    const f = fixture(); await f.start(); await f.deliver(f.update(1, "/new"));
    f.request("session-1", "request"); f.request("session-1", "request"); await vi.advanceTimersByTimeAsync(0);
    expect(f.notices()).toBe(1);
  });
  it("remembers no more than the 100 newest announced request ids", async () => {
    const f = fixture(); await f.start(); await f.deliver(f.update(1, "/new"));
    for (let index = 0; index <= 100; index++) f.request("session-1", `request-${index}`);
    // The 100 newest ids are still remembered, so replaying them announces nothing.
    for (let index = 1; index <= 100; index++) f.request("session-1", `request-${index}`);
    await vi.advanceTimersByTimeAsync(0); expect(f.notices()).toBe(101);
    // The oldest id made room for the 101st. Remembering it again drops the next oldest.
    f.request("session-1", "request-0"); await vi.advanceTimersByTimeAsync(0); expect(f.notices()).toBe(102);
    f.request("session-1", "request-1"); await vi.advanceTimersByTimeAsync(0); expect(f.notices()).toBe(103);
  });
  it("forgets announced request ids when /new starts another session, not when /new fails", async () => {
    const f = fixture(); await f.start(); await f.deliver(f.update(1, "/new"));
    f.request("session-1", "request"); await vi.advanceTimersByTimeAsync(0); expect(f.notices()).toBe(1);
    f.createSession.mockRejectedValueOnce(new Error("fixture creation failure")); await f.deliver(f.update(2, "/new"));
    expect(f.service.status().sessionId).toBe("session-1"); f.request("session-1", "request"); await vi.advanceTimersByTimeAsync(0); expect(f.notices()).toBe(1);
    await f.deliver(f.update(3, "/new")); expect(f.service.status().sessionId).toBe("session-2");
    f.request("session-2", "request"); await vi.advanceTimersByTimeAsync(0); expect(f.notices()).toBe(2);
  });
  it("stop fences a late poll and revoke removes only managed owner credentials", async () => {
    const f = fixture(); const pending = deferred<TelegramUpdate[]>(); vi.mocked(f.transport.getUpdates).mockImplementation(() => pending.promise);
    await f.start(); f.service.stop(); pending.resolve([f.update(1, "must not execute")]); await vi.advanceTimersByTimeAsync(10_000);
    expect(f.createSession).not.toHaveBeenCalled(); expect(f.service.status().state).toBe("stopped");
    f.service.revoke(); expect(f.storage.revoke).toHaveBeenCalledTimes(1); expect(f.service.status().configured).toBe(false);
  });
});
