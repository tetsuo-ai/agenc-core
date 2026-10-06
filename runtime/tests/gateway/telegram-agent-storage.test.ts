import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveHomeContext } from "../../src/config/home.js";
import { createOwnerTelegramStorage } from "../../src/gateway/owner-telegram-storage.js";
import type { TelegramAgentRecord } from "../../src/gateway/owner-telegram-types.js";
import type { SecureStorageData } from "../../src/utils/secureStorage/index.js";

const native = vi.hoisted(() => ({ data: {} as SecureStorageData, read: vi.fn(), update: vi.fn() }));
vi.mock("../../src/utils/secureStorage/native.js", () => ({
  readNativeSecureStorage: (...args: unknown[]) => { native.read(...args); return structuredClone(native.data); },
  updateNativeSecureStorage: (_home: unknown, update: (value: SecureStorageData) => SecureStorageData) => { native.update(); native.data = update(structuredClone(native.data)); },
}));
const roots: string[] = [];
beforeEach(() => { native.data = {}; native.read.mockReset(); native.update.mockReset(); });
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "telegram-agent-storage-")); roots.push(root);
  const home = resolveHomeContext({ AGENC_HOME: root }, { platformHome: "/unused" });
  return { root, store: createOwnerTelegramStorage(home), path: join(root, "gateway", "telegram-agents.json") };
}
const fingerprint = (token: string) => createHash("sha256").update(token).digest("hex");
const record = (id: string, token: string): TelegramAgentRecord => ({ agentId: id, name: "My agent", instructions: "Work carefully", provider: "deepseek", model: "deepseek-flash", workspacePath: "/fixture/workspace", telegramIdentityId: "101", username: "fixture_agent", ownerUserId: "123", ownerUsername: "fixture_owner", lastUpdateId: 4, tokenFingerprint: fingerprint(token) });

describe("Telegram agent durable storage", () => {
  it("keys each secret independently and removes only the selected identity", () => {
    const f = fixture(); native.data = { primaryApiKey: "unrelated", gateway: { environment: { UNRELATED: "preserve" } } };
    f.store.agents!.setToken("agent-a", "secret-a"); f.store.agents!.save(record("agent-a", "secret-a"));
    f.store.agents!.setToken("agent-b", "secret-b"); f.store.agents!.save(record("agent-b", "secret-b"));
    expect(f.store.agents!.token("agent-a")).toBe("secret-a"); expect(f.store.agents!.token("agent-b")).toBe("secret-b");
    expect(readFileSync(f.path, "utf8")).not.toMatch(/secret-a|secret-b/u);
    expect(f.store.agents!.load()[0]).toMatchObject({ provider: "deepseek", model: "deepseek-flash" });
    if (process.platform !== "win32") expect(statSync(f.path).mode & 0o777).toBe(0o600);
    f.store.agents!.remove("agent-a");
    expect(f.store.agents!.load().map((entry) => entry.agentId)).toEqual(["agent-b"]);
    expect(native.data).toMatchObject({ primaryApiKey: "unrelated", gateway: { environment: { UNRELATED: "preserve" }, ownerControlAgentTokens: { "agent-b": "secret-b" } } });
    expect(f.store.agents!.token("agent-a")).toBeUndefined();
  });
  it("migrates legacy metadata without reading or deleting its native credential", () => {
    const f = fixture(); mkdirSync(join(f.root, "gateway")); const legacy = join(f.root, "gateway", "owner-telegram.json");
    const old = { ownerUserId: "123", ownerChatId: "123", workspacePath: "/fixture/workspace", lastUpdateId: 99, tokenFingerprint: fingerprint("legacy-token") };
    writeFileSync(legacy, JSON.stringify(old)); native.data = { gateway: { ownerControlBotToken: "legacy-token", environment: { KEEP: "yes" } } };
    const migrated = f.store.agents!.load()[0]!;
    expect(migrated).toMatchObject({ agentId: "legacy", name: "Telegram agent", ownerUserId: "123", lastUpdateId: 99 });
    expect(native.read).not.toHaveBeenCalled(); expect(native.update).not.toHaveBeenCalled(); expect(existsSync(f.path)).toBe(false);
    expect(f.store.agents!.token("legacy")).toBe("legacy-token");
    f.store.agents!.save(migrated); expect(readFileSync(legacy, "utf8")).toBe(JSON.stringify(old));
    f.store.agents!.setToken("legacy", "replacement-token"); expect(f.store.agents!.token("legacy")).toBe("replacement-token");
    f.store.agents!.remove("legacy");
    expect(f.store.agents!.load()).toEqual([]); expect(existsSync(legacy)).toBe(false);
    expect(native.data.gateway).toEqual({ environment: { KEEP: "yes" }, ownerControlAgentTokens: {} });
  });
  it("does not resurrect a removed legacy entry when the v2 catalog is empty", () => {
    const f = fixture(); mkdirSync(join(f.root, "gateway"));
    writeFileSync(join(f.root, "gateway", "owner-telegram.json"), JSON.stringify({ ownerUserId: "123", ownerChatId: "123", workspacePath: "/fixture", lastUpdateId: 1, tokenFingerprint: fingerprint("old") }));
    writeFileSync(f.path, JSON.stringify({ version: 2, agents: [] }));
    expect(f.store.agents!.load()).toEqual([]);
  });
  it("preserves malformed state and fails closed instead of silently replacing it", () => {
    const f = fixture(); mkdirSync(join(f.root, "gateway")); writeFileSync(f.path, "{ malformed");
    expect(() => f.store.agents!.load()).toThrow();
    expect(() => f.store.agents!.save(record("agent-a", "secret"))).toThrow();
    expect(readFileSync(f.path, "utf8")).toBe("{ malformed");
  });
  it("preserves metadata when native credential removal fails", () => {
    const f = fixture(); f.store.agents!.setToken("agent-a", "secret"); f.store.agents!.save(record("agent-a", "secret"));
    native.update.mockImplementationOnce(() => { throw new Error("native unavailable"); });
    expect(() => f.store.agents!.remove("agent-a")).toThrow();
    expect(f.store.agents!.load()).toHaveLength(1); expect(f.store.agents!.token("agent-a")).toBe("secret");
  });
});
