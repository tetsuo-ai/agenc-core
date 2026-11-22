import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  hasSavedProviderKey,
  readProviderKey,
  removeProviderKey,
  saveProviderKey,
} from "../../src/auth/provider-keys.js";
import type { HomeContext } from "../../src/config/home.js";
import { captureSecureStorageIngress } from "../../src/utils/secureStorage/home.js";
import { readNativeSecureStorage } from "../../src/utils/secureStorage/native.js";

const SAVED_AT = new Date("2026-11-01T00:00:00.000Z");
const homes: string[] = [];

async function makeHome(): Promise<{ path: string; home: HomeContext }> {
  const path = await mkdtemp(join(tmpdir(), "agenc-provider-keys-"));
  homes.push(path);
  return { path, home: captureSecureStorageIngress({ AGENC_HOME: path }).home };
}

afterEach(async () => {
  await Promise.all(homes.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("saved provider keys", () => {
  it("persists and reads a key only in native secure storage", async () => {
    const { path, home } = await makeHome();
    saveProviderKey(home, "Grok", "xai-test-key", () => SAVED_AT);
    expect(readProviderKey(home, "grok")).toBe("xai-test-key");
    expect(hasSavedProviderKey(home, "grok")).toBe(true);
    expect(readNativeSecureStorage(home).localAuth).toMatchObject({
      byokKeys: { grok: { provider: "grok", apiKey: "xai-test-key", savedAt: SAVED_AT.toISOString() } },
    });
    await expect(readFile(join(path, "auth.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(path, "byok-keys.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes a key and says whether one was saved", async () => {
    const { home } = await makeHome();
    saveProviderKey(home, "openrouter", "sk-or-test", () => SAVED_AT);
    expect(removeProviderKey(home, "openrouter")).toBe(true);
    expect(removeProviderKey(home, "openrouter")).toBe(false);
    expect(readProviderKey(home, "openrouter")).toBeUndefined();
  });

  it("rejects blank or whitespace keys", async () => {
    const { home } = await makeHome();
    expect(() => saveProviderKey(home, "grok", "   ")).toThrow("Paste a key first.");
    expect(() => saveProviderKey(home, "grok", "xai test key")).toThrow("A key has no spaces.");
    expect(readProviderKey(home, "grok")).toBeUndefined();
  });
});
