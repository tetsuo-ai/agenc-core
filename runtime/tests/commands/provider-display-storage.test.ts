import { expect, it, vi } from "vitest";
import { resolveHomeContext } from "../../src/config/home.js";
import { readProvidersHubSnapshot } from "../../src/commands/providers-hub-snapshot.js";
import { readModelMenuSnapshot } from "../../src/commands/model-menu-snapshot.js";
import { readLocalByokCredential } from "../../src/auth/native-credentials.js";
import type { SlashCommandContext } from "../../src/commands/types.js";
vi.unmock("../../src/utils/secureStorage/index.js");
const backend = vi.hoisted(() => ({ read: vi.fn(() => null), readFresh: vi.fn(() => null) }));
vi.mock("../../src/utils/secureStorage/linuxSecretStorage.js", () => ({ createLinuxSecretStorage: () => ({ name: "fixture", ...backend, readAsync: async () => backend.read(), update: () => ({ success: true }), delete: () => true }) }));
it.skipIf(process.platform !== "linux")("reads native credentials once per display snapshot and keeps later reads fresh", () => {
  const home = resolveHomeContext({ AGENC_HOME: "/private/provider-display-fixture" });
  const ctx = { session: { state: { unsafePeek: () => ({ sessionConfiguration: { provider: { slug: "deepseek" }, collaborationMode: { model: "deepseek-flash" } } }) }, services: { configStore: { homeContext: home, current: () => ({}) }, providerEnvironment: { AGENC_HOME: home.path, DEEPSEEK_API_KEY: "via-recorder" } } }, argsRaw: "", cwd: "/private" } as unknown as SlashCommandContext;
  backend.read.mockClear();
  expect(readProvidersHubSnapshot(ctx).currentProvider).toBe("deepseek");
  expect(backend.read).toHaveBeenCalledOnce();
  backend.read.mockClear();
  expect(readModelMenuSnapshot(ctx).rows.some(row => row.model === "deepseek-flash")).toBe(true);
  expect(backend.read).toHaveBeenCalledOnce();
  backend.read.mockClear();
  readLocalByokCredential(home, "deepseek");
  readLocalByokCredential(home, "deepseek");
  expect(backend.read).toHaveBeenCalledTimes(2);
});

it.skipIf(process.platform !== "linux")("bypasses display reads for fresh preconditions and invalidates them after a write", async () => {
  const { getSecureStorage, withSecureStorageDisplaySnapshot } = await import("../../src/utils/secureStorage/index.js");
  const home = resolveHomeContext({ AGENC_HOME: "/private/provider-display-fixture" });
  backend.read.mockClear(); backend.readFresh.mockClear();
  withSecureStorageDisplaySnapshot(home, () => {
    const storage = getSecureStorage(home);
    storage.read(); storage.read();
    expect(backend.read).toHaveBeenCalledOnce();
    storage.readFresh?.(); storage.readFresh?.();
    expect(backend.readFresh).toHaveBeenCalledTimes(2);
    storage.update({}); storage.read();
    expect(backend.read).toHaveBeenCalledTimes(2);
  });
  await withSecureStorageDisplaySnapshot(home, () => Promise.resolve().then(() => {
    getSecureStorage(home).read(); getSecureStorage(home).read();
  }));
  expect(backend.read).toHaveBeenCalledTimes(4);
});

it.skipIf(process.platform !== "linux")("preserves storage errors during the display scope and retries later", async () => {
  const { getSecureStorage, withSecureStorageDisplaySnapshot } = await import("../../src/utils/secureStorage/index.js");
  const home = resolveHomeContext({ AGENC_HOME: "/private/provider-display-fixture" });
  backend.read.mockClear(); backend.read.mockImplementationOnce(() => { throw new Error("unreadable record"); });
  withSecureStorageDisplaySnapshot(home, () => {
    expect(() => getSecureStorage(home).read()).toThrow("unreadable record");
    expect(() => getSecureStorage(home).read()).toThrow("unreadable record");
    expect(backend.read).toHaveBeenCalledOnce();
  });
  expect(getSecureStorage(home).read()).toBeNull();
  expect(backend.read).toHaveBeenCalledTimes(2);
});
