import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OwnerTelegramService } from "../../src/gateway/owner-telegram.js";
import type { TelegramAgentRecord, TelegramAgentStatus, TelegramAgentPairingResult, OwnerTelegramMethod } from "../../src/gateway/owner-telegram-types.js";
import type { TelegramTransport, TelegramUpdate } from "../../src/gateway/telegram-channel.js";
import type { OwnerTelegramStorage } from "../../src/gateway/owner-telegram-storage.js";
import type { AgenCDaemonResponse, JsonObject } from "../../src/app-server/protocol/index.js";

vi.mock("qrcode", () => ({ default: { toDataURL: vi.fn(async () => "data:image/png;base64,cXItZml4dHVyZQ==") } }));
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); vi.useRealTimers(); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }

function fixture() {
  vi.useFakeTimers();
  const root = realpathSync(mkdtempSync(join(tmpdir(), "telegram-agents-")));
  const home = join(root, "home"); const workspace = join(root, "work-a"); const workspaceB = join(root, "work-b");
  for (const path of [home, workspace, workspaceB]) mkdirSync(path);
  const records = new Map<string, TelegramAgentRecord>(); const tokens = new Map<string, string>();
  const sessions = new Map<string, string>(); let sequence = 0;
  const batches = new Map<string, TelegramUpdate[][]>();
  const getMe = vi.fn(async (token: string) => ({ id: Number(token.split(":")[0]), username: `fixture_${token.split(":")[0]}` }));
  const sends = vi.fn(async (_identity: string, _owner: string, _text: string) => ({ message_id: 1 }));
  const getUpdates = vi.fn(async (identity: string, _offset: number) => batches.get(identity)?.shift() ?? []);
  const agents = {
    load: vi.fn(() => [...records.values()]),
    save: vi.fn((record: TelegramAgentRecord) => { records.set(record.agentId, { ...record }); }),
    token: vi.fn((agentId: string) => tokens.get(agentId)),
    setToken: vi.fn((agentId: string, token: string) => { tokens.set(agentId, token); }),
    remove: vi.fn((agentId: string) => { records.delete(agentId); tokens.delete(agentId); }),
  };
  const storage: OwnerTelegramStorage = {
    load: () => { const record = records.get("legacy"); return record?.ownerUserId ? { ownerUserId: record.ownerUserId, ownerChatId: record.ownerUserId, workspacePath: record.workspacePath, lastUpdateId: record.lastUpdateId, tokenFingerprint: record.tokenFingerprint } : null; },
    save: (binding) => agents.save({ agentId: "legacy", name: "Telegram agent", instructions: "", telegramIdentityId: null, username: null, ownerUsername: null, ownerUserId: binding.ownerUserId, workspacePath: binding.workspacePath, lastUpdateId: binding.lastUpdateId, tokenFingerprint: binding.tokenFingerprint }),
    token: () => tokens.get("legacy"), setToken: (token) => agents.setToken("legacy", token), revoke: () => agents.remove("legacy"), agents,
  };
  const transport = (token: string, _signal: AbortSignal): TelegramTransport => {
    const identity = token.split(":")[0]!;
    return { getMe: () => getMe(token), getUpdates: (offset) => getUpdates(identity, offset), sendMessage: (owner, text) => sends(identity, owner, text), editMessageText: async () => {} };
  };
  const invoke = vi.fn(async (message: JsonObject): Promise<AgenCDaemonResponse> => ({ jsonrpc: "2.0", id: message.id as string, result: message.method === "session.transcript.v2" ? { messages: [{ role: "assistant", text: "Completed.", turnId: "fixture-turn" }] } : message.method === "message.send" ? { turnId: "fixture-turn", terminal: { code: 0 } } : {} }));
  const createSession = vi.fn(async (cwd: string) => { const sessionId = `session-${++sequence}`; sessions.set(sessionId, cwd); return { sessionId, agentId: `runtime-${sequence}` }; });
  const failures = vi.fn();
  const makeService = () => new OwnerTelegramService({ home, storage, onSessionFailure: failures, lookupSession: async (sessionId) => sessions.has(sessionId) ? { sessionId, cwd: sessions.get(sessionId)! } : null, createSession, transport, createConnection: (access) => ({
    dispatch: async (message) => {
      const params = message.params as JsonObject ?? {}; await access.authorize(message.method as string, params);
      if (message.method === "session.create") return { jsonrpc: "2.0", id: message.id as string, result: await access.createSession(params) };
      return invoke(message);
    }, close: vi.fn(async () => {}),
  }) });
  const service = makeService();
  const rpc = <T = TelegramAgentStatus>(method: OwnerTelegramMethod, params: JsonObject = {}) => service.handle(method, params) as unknown as Promise<T>;
  const token = (id: number) => `${id}:fixture_secret_1234567890`;
  const create = (id = 101, overrides: JsonObject = {}) => rpc("telegram.agents.create", { name: `Agent ${id}`, token: token(id), workspacePath: workspace, ...overrides });
  const update = (id: number, text: string, owner = 123456, overrides: Partial<NonNullable<TelegramUpdate["message"]>> = {}): TelegramUpdate => ({ update_id: id, message: { message_id: id, date: Math.floor(Date.now() / 1000), chat: { id: owner, type: "private" }, from: { id: owner, username: "fixture_owner", first_name: "Fixture" }, text, ...overrides } });
  async function deliver(identity: number, ...updates: TelegramUpdate[]) {
    const queue = batches.get(String(identity)) ?? []; queue.push(updates); batches.set(String(identity), queue); await vi.advanceTimersByTimeAsync(101);
  }
  const begin = (agentId: string) => rpc<TelegramAgentPairingResult>("telegram.agents.pair.begin", { agentId });
  async function link(agentId: string, identity = 101, owner = 123456, updateId = 1) {
    const pairing = await begin(agentId);
    await deliver(identity, update(updateId, `/start ${new URL(pairing.url).searchParams.get("start")}`, owner));
    return rpc("telegram.agents.pair.confirm", { agentId, challengeId: pairing.challengeId });
  }
  const status = (agentId: string) => service.list().agents.find((agent) => agent.agentId === agentId)!;
  cleanups.push(() => { service.close(); rmSync(root, { recursive: true, force: true }); });
  return { failures, service, rpc, create, begin, link, status, update, deliver, tokens, records, agents, getMe, getUpdates, createSession, invoke, sends, workspace, workspaceB, token, makeService };
}

describe("Telegram agent manager", () => {
  it("creates isolated stopped identities without leaking credentials or creating Core work", async () => {
    const f = fixture(); const a = await f.create(); const b = await f.create(202);
    expect(a).toMatchObject({ name: "Agent 101", state: "unlinked", enabled: false, ownerUserId: null });
    expect(a.agentId).not.toBe(b.agentId); expect(f.tokens.size).toBe(2);
    expect(JSON.stringify(f.service.list())).not.toContain(f.token(101));
    expect(JSON.stringify([...f.records.values()])).not.toContain(f.token(101));
    expect(f.createSession).not.toHaveBeenCalled();
    await expect(f.rpc("telegram.agents.start", { agentId: a.agentId })).rejects.toMatchObject({ code: "TELEGRAM_ACCOUNT_NOT_LINKED" });
  });
  it("rejects invalid profiles and duplicate Telegram identity even after credential rotation", async () => {
    const f = fixture(); await expect(f.create(101, { workspacePath: "/" })).rejects.toMatchObject({ code: "REMOTE_WORKSPACE_INVALID" });
    await expect(f.create(101, { name: "" })).rejects.toMatchObject({ code: "TELEGRAM_CONFIG_INVALID" });
    await f.create(); await expect(f.create(101, { token: "101:rotated_fixture_secret_123456" })).rejects.toMatchObject({ code: "TELEGRAM_AGENT_DUPLICATE" });
    expect(f.tokens.size).toBe(1);
  });
  it("serializes concurrent create requests so one Telegram identity cannot be registered twice", async () => {
    const f = fixture(); const results = await Promise.allSettled([f.create(), f.create()]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(f.service.list().agents).toHaveLength(1);
  });
  it("rejects a duplicate credential through the legacy configure API too", async () => {
    const f = fixture(); await f.create();
    await expect(f.rpc("telegram.configure", { token: f.token(101), ownerUserId: "123456", workspacePath: f.workspace })).rejects.toMatchObject({ code: "TELEGRAM_AGENT_DUPLICATE" });
    expect(f.service.list().agents).toHaveLength(1);
    expect(() => f.service.configure({ token: f.token(101), ownerUserId: "123456", workspacePath: f.workspace })).toThrow("TELEGRAM_AGENT_DUPLICATE");
  });
  it("does not leave an undiscoverable native credential when metadata creation fails", async () => {
    const f = fixture(); f.agents.save.mockImplementationOnce(() => { throw new Error("storage full"); });
    await expect(f.create()).rejects.toMatchObject({ code: "TELEGRAM_STATE_STORAGE_FAILED" });
    expect(f.tokens.size).toBe(0); expect(f.service.list().agents).toEqual([]);
    f.agents.setToken.mockImplementationOnce(() => { throw new Error("native unavailable"); });
    await expect(f.create()).rejects.toMatchObject({ code: "TELEGRAM_CREDENTIAL_STORAGE_UNAVAILABLE" });
    expect(f.service.list().agents).toHaveLength(1); expect(f.service.list().agents[0]).toMatchObject({ enabled: false, error: "TELEGRAM_CREDENTIAL_STORAGE_UNAVAILABLE" });
  });
  it("links only after the exact one-time challenge and explicit local confirmation", async () => {
    const f = fixture(); const a = await f.create(); const pairing = await f.begin(a.agentId);
    expect(pairing.qrDataUrl).toMatch(/^data:image\/png;base64,/u);
    const nonce = new URL(pairing.url).searchParams.get("start")!;
    expect(nonce).toHaveLength(43); expect(pairing.url).not.toContain(f.token(101));
    expect(JSON.stringify([...f.records.values()])).not.toContain(nonce);
    await f.deliver(101, f.update(1, `/start ${nonce}`));
    expect(f.status(a.agentId)).toMatchObject({ state: "awaiting_confirmation", ownerUserId: null, pairing: { candidate: { userId: "123456" } } });
    expect(f.createSession).not.toHaveBeenCalled();
    await expect(f.rpc("telegram.agents.pair.confirm", { agentId: a.agentId, challengeId: "wrong" })).rejects.toMatchObject({ code: "TELEGRAM_PAIRING_NOT_PENDING" });
    expect(await f.rpc("telegram.agents.pair.confirm", { agentId: a.agentId, challengeId: pairing.challengeId })).toMatchObject({ state: "stopped", ownerUserId: "123456", pairing: null });
    await expect(f.rpc("telegram.agents.pair.confirm", { agentId: a.agentId, challengeId: pairing.challengeId })).rejects.toMatchObject({ code: "TELEGRAM_PAIRING_NOT_PENDING" });
  });
  it("ignores groups, forwarded messages, automated identities, wrong nonce, edited and old updates", async () => {
    const f = fixture(); const a = await f.create(); const pairing = await f.begin(a.agentId); const text = `/start ${new URL(pairing.url).searchParams.get("start")}`;
    const forwarded = f.update(3, text); Object.assign(forwarded.message!, { forward_origin: {} });
    await f.deliver(101, f.update(1, text, 123456, { chat: { id: -1, type: "group" } }), f.update(2, text, 123456, { from: { id: 123456, is_bot: true } }), forwarded, f.update(4, `/start ${"x".repeat(43)}`), { update_id: 5, edited_message: f.update(5, text).message }, f.update(6, text, 123456, { date: Math.floor(Date.now() / 1000) - 60 }));
    expect(f.status(a.agentId).pairing?.candidate).toBeNull();
    await f.deliver(101, f.update(7, text));
    const calls = f.getUpdates.mock.calls.length;
    await f.deliver(101, f.update(8, text, 999));
    expect(f.getUpdates.mock.calls).toHaveLength(calls);
    expect(f.status(a.agentId).pairing?.candidate?.userId).toBe("123456");
  });
  it("expires and refreshes challenges, rejecting both old links and old confirmations", async () => {
    const f = fixture(); const a = await f.create(); const first = await f.begin(a.agentId); const second = await f.begin(a.agentId);
    expect(first.url).not.toBe(second.url);
    await f.deliver(101, f.update(1, `/start ${new URL(first.url).searchParams.get("start")}`));
    expect(f.status(a.agentId).pairing?.candidate).toBeNull();
    await f.deliver(101, f.update(2, `/start ${new URL(second.url).searchParams.get("start")}`));
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(f.status(a.agentId)).toMatchObject({ state: "unlinked", pairing: null });
    await expect(f.rpc("telegram.agents.pair.confirm", { agentId: a.agentId, challengeId: second.challengeId })).rejects.toMatchObject({ code: "TELEGRAM_PAIRING_NOT_PENDING" });
  });
  it("cancel fences a late polling response and never binds an account", async () => {
    const f = fixture(); const a = await f.create(); const late = deferred<TelegramUpdate[]>(); f.getUpdates.mockImplementation(() => late.promise);
    const pairing = await f.begin(a.agentId); await vi.advanceTimersByTimeAsync(0);
    await f.rpc("telegram.agents.pair.cancel", { agentId: a.agentId, challengeId: pairing.challengeId });
    late.resolve([f.update(1, `/start ${new URL(pairing.url).searchParams.get("start")}`)]); await vi.advanceTimersByTimeAsync(100);
    expect(f.status(a.agentId)).toMatchObject({ state: "unlinked", pairing: null, ownerUserId: null });
  });
  it("keeps Stop and list responsive while credential validation is pending", async () => {
    const f = fixture(); const a = await f.create(); const identity = deferred<{ id: number; username: string }>(); f.getMe.mockImplementation(() => identity.promise);
    const begin = f.begin(a.agentId); const rejected = expect(begin).rejects.toMatchObject({ code: "TELEGRAM_OPERATION_CANCELLED" });
    await Promise.resolve(); await Promise.resolve();
    expect(await f.rpc("telegram.agents.stop", { agentId: a.agentId })).toMatchObject({ state: "unlinked" });
    expect(await f.rpc("telegram.agents.list")).toMatchObject({ agents: [{ agentId: a.agentId }] });
    identity.resolve({ id: 101, username: "fixture_101" }); await rejected;
    expect(f.status(a.agentId).pairing).toBeNull();
  });
  it("removes an identity while Start is pending and fences late activation", async () => {
    const f = fixture(); const a = await f.create(); await f.link(a.agentId);
    const identity = deferred<{ id: number; username: string }>(); f.getMe.mockImplementation(() => identity.promise);
    const start = f.rpc("telegram.agents.start", { agentId: a.agentId }); const rejected = expect(start).rejects.toMatchObject({ code: "TELEGRAM_OPERATION_CANCELLED" });
    await Promise.resolve(); await Promise.resolve();
    expect(await f.rpc("telegram.agents.remove", { agentId: a.agentId })).toMatchObject({ removed: true, agentId: a.agentId });
    identity.resolve({ id: 101, username: "fixture_101" }); await rejected;
    expect(f.service.list().agents).toEqual([]); expect(f.tokens.size).toBe(0); expect(f.createSession).not.toHaveBeenCalled();
  });
  it("fences legacy reconfiguration after Remove and clears the compatibility status", async () => {
    const f = fixture(); await f.rpc("telegram.configure", { token: f.token(101), ownerUserId: "123456", workspacePath: f.workspace });
    expect(f.service.list().agents[0]).toMatchObject({ agentId: "legacy", state: "stopped" });
    const identity = deferred<{ id: number; username: string }>(); f.getMe.mockImplementation(() => identity.promise);
    const configure = f.rpc("telegram.configure", { token: f.token(101), ownerUserId: "123456", workspacePath: f.workspaceB });
    const rejected = expect(configure).rejects.toMatchObject({ code: "TELEGRAM_OPERATION_CANCELLED" });
    await Promise.resolve(); await Promise.resolve();
    await f.rpc("telegram.agents.remove", { agentId: "legacy" });
    identity.resolve({ id: 101, username: "fixture_101" }); await rejected;
    expect(f.service.list().agents).toEqual([]); expect(f.tokens.size).toBe(0); expect(f.service.status().configured).toBe(false);
  });
  it("runs multiple identities with isolated accounts, workspaces, instructions and lifecycle", async () => {
    const f = fixture(); const a = await f.create(101, { instructions: "Review code carefully." }); const b = await f.create(202, { workspacePath: f.workspaceB });
    await f.link(a.agentId); await f.link(b.agentId, 202, 654321);
    await f.rpc("telegram.agents.start", { agentId: a.agentId }); await f.rpc("telegram.agents.start", { agentId: b.agentId });
    await f.deliver(101, f.update(2, "Please inspect"), f.update(3, "Wrong owner", 654321));
    await f.deliver(202, f.update(2, "Other project", 654321));
    expect(f.createSession.mock.calls.map(([cwd]) => cwd)).toEqual([f.workspace, f.workspaceB]);
    const messages = f.invoke.mock.calls.map(([request]) => request).filter((request) => request.method === "message.send");
    expect(messages).toHaveLength(2);
    expect(messages[0]?.params).toMatchObject({ content: expect.stringContaining("Review code carefully."), clientMessageId: `telegram:${a.agentId}:123456:2` });
    await f.rpc("telegram.agents.stop", { agentId: a.agentId });
    expect(f.status(a.agentId).enabled).toBe(false); expect(f.status(b.agentId).enabled).toBe(true);
    expect(f.invoke.mock.calls.some(([request]) => request.method === "session.cancelTurn")).toBe(false);
    await f.rpc("telegram.agents.remove", { agentId: a.agentId });
    expect(f.tokens.has(a.agentId)).toBe(false); expect(f.tokens.has(b.agentId)).toBe(true);
    f.service.stop(); expect(f.status(b.agentId).enabled).toBe(false);
  });
  it("updates a profile while stopped and requires a new account link if the credential identity changes", async () => {
    const f = fixture(); const a = await f.create(); await f.link(a.agentId);
    expect(await f.rpc("telegram.agents.update", { agentId: a.agentId, name: "Research agent", instructions: "Research first", workspacePath: f.workspaceB })).toMatchObject({ name: "Research agent", state: "stopped", ownerUserId: "123456" });
    expect(await f.rpc("telegram.agents.update", { agentId: a.agentId, token: f.token(202) })).toMatchObject({ state: "unlinked", ownerUserId: null, username: "fixture_202" });
  });
  it("fails closed on pairing persistence failure and credential metadata mismatch", async () => {
    const f = fixture(); const a = await f.create(); const pairing = await f.begin(a.agentId);
    f.agents.save.mockImplementationOnce(() => { throw new Error("disk failed"); });
    await f.deliver(101, f.update(1, `/start ${new URL(pairing.url).searchParams.get("start")}`));
    expect(f.status(a.agentId)).toMatchObject({ state: "error", pairing: null, ownerUserId: null, error: "TELEGRAM_STATE_STORAGE_FAILED" });
    f.tokens.set(a.agentId, f.token(202));
    await expect(f.begin(a.agentId)).rejects.toMatchObject({ code: "TELEGRAM_CONFIGURATION_MISMATCH" });
  });
  it("restarts with durable identity, confirmed account and replay cursor but no active connections or pending nonce", async () => {
    const f = fixture(); const a = await f.create(); await f.link(a.agentId); f.service.close();
    const reloaded = f.makeService(); cleanups.push(() => reloaded.close());
    expect(reloaded.list().agents[0]).toMatchObject({ agentId: a.agentId, state: "stopped", ownerUserId: "123456", pairing: null });
    expect(f.records.get(a.agentId)?.lastUpdateId).toBe(1);
  });
  it("never forwards an unrelated previous answer as the new turn result", async () => {
    const f = fixture(); const a = await f.create(); await f.link(a.agentId); await f.rpc("telegram.agents.start", { agentId: a.agentId });
    f.invoke.mockImplementation(async (request) => ({ jsonrpc: "2.0", id: request.id as string, result: request.method === "message.send" ? { turnId: "new-turn", terminal: { code: 0 } } : { messages: [{ role: "assistant", text: "Old sensitive answer", turnId: "previous-turn" }] } }));
    await f.deliver(101, f.update(2, "New task"));
    expect(JSON.stringify(f.sends.mock.calls)).not.toContain("Old sensitive answer");
    expect(f.sends).toHaveBeenCalledWith("101", "123456", "Turn completed. Check AgenC on the host for details.");
    f.invoke.mockImplementation(async (request) => ({ jsonrpc: "2.0", id: request.id as string, result: { turnId: "cancelled-turn", terminal: { code: 130 } } }));
    await f.deliver(101, f.update(3, "Another task"));
    expect(f.sends).toHaveBeenCalledWith("101", "123456", "Task cancelled.");
  });
});

it("passes the saved provider/model and fresh ephemeral credentials to each Telegram session", async () => {
  const f = fixture();
  const agent = await f.create(101, { provider: "deepseek", model: "deepseek-flash" });
  await f.link(agent.agentId);
  await f.rpc("telegram.agents.start", { agentId: agent.agentId, provider: "deepseek", envOverrides: { DEEPSEEK_API_KEY: "private-key-one" } });
  await f.deliver(101, f.update(2, "/new"));
  expect(f.createSession).toHaveBeenLastCalledWith(f.workspace, "Telegram · Agent 101", expect.any(AbortSignal), expect.objectContaining({ provider: "deepseek", model: "deepseek-flash", envOverrides: expect.objectContaining({ DEEPSEEK_API_KEY: "private-key-one", OPENAI_API_KEY: "" }) }));
  await f.rpc("telegram.agents.stop", { agentId: agent.agentId });
  await f.rpc("telegram.agents.start", { agentId: agent.agentId, provider: "deepseek", envOverrides: { DEEPSEEK_API_KEY: "private-key-two" } });
  await f.deliver(101, f.update(3, "/new"));
  expect(f.createSession).toHaveBeenLastCalledWith(f.workspace, expect.any(String), expect.any(AbortSignal), expect.objectContaining({ envOverrides: expect.objectContaining({ DEEPSEEK_API_KEY: "private-key-two" }) }));
  expect(JSON.stringify([...f.records.values()])).not.toContain("private-key");
  expect(JSON.stringify(f.service.list())).not.toContain("private-key");
  f.service.close();
  const restarted = f.makeService();
  try {
    expect(restarted.list().agents[0]).toMatchObject({ provider: "deepseek", model: "deepseek-flash", enabled: false });
    await restarted.handle("telegram.agents.start", { agentId: agent.agentId, provider: "deepseek", envOverrides: { DEEPSEEK_API_KEY: "private-key-after-restart" } });
    await f.deliver(101, f.update(4, "/new"));
    expect(f.createSession).toHaveBeenLastCalledWith(f.workspace, expect.any(String), expect.any(AbortSignal), expect.objectContaining({ envOverrides: expect.objectContaining({ DEEPSEEK_API_KEY: "private-key-after-restart" }) }));
  } finally { restarted.close(); }
});
it("logs safe session failures, keeps them visible across polls, and replies with a recovery action", async () => {
  const f = fixture(); const agent = await f.create(); await f.link(agent.agentId);
  f.createSession.mockRejectedValueOnce({ code: -32603, message: "deepseek authentication failed (HTTP 401): deepseek provider requires credentials. Set DEEPSEEK_API_KEY." });
  await f.rpc("telegram.agents.start", { agentId: agent.agentId });
  await f.deliver(101, f.update(2, "hi"));
  expect(f.failures).toHaveBeenCalledWith(expect.stringContaining("Set DEEPSEEK_API_KEY."));
  expect(f.sends).toHaveBeenCalledWith("101", "123456", expect.stringContaining("No credential for deepseek"));
  await f.deliver(101);
  expect(f.status(agent.agentId).error).toBe("TELEGRAM_PROVIDER_CREDENTIAL_MISSING");
  await f.deliver(101, f.update(3, "/new"));
  expect(f.status(agent.agentId).error).toBeNull();
});
it("refuses invalid provider/model profiles and environment injection before activation", async () => {
  const f = fixture();
  await expect(f.create(101, { provider: "not-a-provider", model: "anything" })).rejects.toThrow("TELEGRAM_CONFIG_INVALID");
  await expect(f.create(101, { provider: "deepseek" })).rejects.toThrow("TELEGRAM_CONFIG_INVALID");
  const agent = await f.create(101, { provider: "deepseek", model: "deepseek-flash" }); await f.link(agent.agentId);
  await expect(f.rpc("telegram.agents.start", { agentId: agent.agentId, provider: "openai", envOverrides: { OPENAI_API_KEY: "wrong-provider-secret" } })).rejects.toThrow("TELEGRAM_PROVIDER_CHANGED");
  for (const envOverrides of [{ HOME: "/elsewhere" }, { DEEPSEEK_API_KEY: 123 }, []]) {
    await expect(f.rpc("telegram.agents.start", { agentId: agent.agentId, provider: "deepseek", envOverrides })).rejects.toThrow("TELEGRAM_CONFIG_INVALID");
  }
  expect(f.status(agent.agentId).enabled).toBe(false);
});

it("clears transient send errors after a successful exchange without losing a session failure", async () => {
  const f = fixture(); const a = await f.create(); await f.link(a.agentId);
  await f.rpc("telegram.agents.start", { agentId: a.agentId });
  f.sends.mockRejectedValueOnce(new Error("transient transport error"));
  await f.deliver(101, f.update(2, "hi"));
  expect(f.status(a.agentId)).toMatchObject({ state: "error", error: "TELEGRAM_COMMAND_FAILED" });
  await f.deliver(101, f.update(3, "hi again"));
  expect(f.status(a.agentId)).toMatchObject({ state: "running", error: null });
  f.createSession.mockRejectedValueOnce(new Error("deepseek provider requires credentials. Set DEEPSEEK_API_KEY."));
  f.sends.mockRejectedValueOnce(new Error("failed error delivery"));
  await f.deliver(101, f.update(4, "/new"));
  expect(f.status(a.agentId).error).toBe("TELEGRAM_PROVIDER_CREDENTIAL_MISSING");
  await f.deliver(101, f.update(5, "/status"));
  expect(f.status(a.agentId).error).toBe("TELEGRAM_PROVIDER_CREDENTIAL_MISSING");
  await f.deliver(101, f.update(6, "/new"));
  expect(f.status(a.agentId)).toMatchObject({ state: "running", error: null });
});
