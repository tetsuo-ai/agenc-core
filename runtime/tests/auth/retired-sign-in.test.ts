import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { removeRetiredAgenCSignIn, withoutRetiredSignIn } from "../../src/auth/retired-sign-in.js";
import type { HomeContext } from "../../src/config/home.js";
import { getSecureStorage } from "../../src/utils/secureStorage/index.js";
import { captureSecureStorageIngress } from "../../src/utils/secureStorage/home.js";
import {
  readNativeSecureStorage,
  updateNativeSecureStorage,
} from "../../src/utils/secureStorage/native.js";
import { SecureStorageUnavailableError } from "../../src/utils/secureStorage/unavailable.js";

// Synthetic values only; the cleanup never prints or returns them.
const BEARER = "retired-bearer-fixture";
const LOCAL_TOKEN = "retired-local-token-fixture";
const PROVIDER_KEY = "provider-key-fixture";

let root: string;
let home: HomeContext;

function seedSecureStorage(): void {
  updateNativeSecureStorage(home, (current) => ({
    ...current,
    remoteAuth: { bearerToken: BEARER, createdAt: "2026-11-01T00:00:00.000Z" },
    localAuth: {
      login: { token: LOCAL_TOKEN, createdAt: "2026-11-01T00:00:00.000Z" },
      byokKeys: { openrouter: { provider: "openrouter", apiKey: PROVIDER_KEY, savedAt: "2026-11-01T00:00:00.000Z" } },
    },
    primaryApiKey: "unrelated-fixture",
  }), "fixture write failed");
}

function writeSignInState(): void {
  mkdirSync(home.path, { recursive: true });
  writeFileSync(home.authPath, `${JSON.stringify({ version: 1, provider: "remote", createdAt: "2026-11-01T00:00:00.000Z", identity: { email: "person@example.invalid" } })}\n`);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "retired-sign-in-"));
  home = captureSecureStorageIngress({ AGENC_HOME: join(root, "home"), HOME: root }).home;
});
afterEach(() => {
  vi.mocked(getSecureStorage).mockClear();
  rmSync(root, { recursive: true, force: true });
});

describe("retired AgenC sign-in cleanup", () => {
  it("removes auth.json and the session tokens, and keeps provider keys", () => {
    seedSecureStorage();
    writeSignInState();
    mkdirSync(`${home.authPath}.lock`);
    const result = removeRetiredAgenCSignIn(home);
    expect(result).toEqual({ found: true, removed: true, errors: [] });
    expect(existsSync(home.authPath)).toBe(false);
    expect(existsSync(`${home.authPath}.lock`)).toBe(false);
    const stored = readNativeSecureStorage(home);
    expect(stored.remoteAuth).toBeUndefined();
    expect(stored.localAuth?.login).toBeUndefined();
    expect(stored.localAuth?.byokKeys?.openrouter?.apiKey).toBe(PROVIDER_KEY);
    expect(stored.primaryApiKey).toBe("unrelated-fixture");
    expect(JSON.stringify(result)).not.toContain(BEARER);
  });

  it("does nothing, and never opens secure storage, in a home that never signed in", () => {
    seedSecureStorage();
    vi.mocked(getSecureStorage).mockClear();
    expect(removeRetiredAgenCSignIn(home)).toEqual({ found: false, removed: true, errors: [] });
    expect(getSecureStorage).not.toHaveBeenCalled();
    expect(readNativeSecureStorage(home).remoteAuth?.bearerToken).toBe(BEARER);
  });

  it("runs once: a second start finds nothing", () => {
    seedSecureStorage();
    writeSignInState();
    expect(removeRetiredAgenCSignIn(home).found).toBe(true);
    vi.mocked(getSecureStorage).mockClear();
    expect(removeRetiredAgenCSignIn(home)).toEqual({ found: false, removed: true, errors: [] });
    expect(getSecureStorage).not.toHaveBeenCalled();
  });

  it("removes an old auth.json that held the token itself", () => {
    mkdirSync(home.path, { recursive: true });
    writeFileSync(home.authPath, JSON.stringify({ version: 1, provider: "remote", token: BEARER, createdAt: "2026-11-01T00:00:00.000Z" }));
    expect(removeRetiredAgenCSignIn(home)).toEqual({ found: true, removed: true, errors: [] });
    expect(existsSync(home.authPath)).toBe(false);
  });

  it("removes the retired policy cache without opening secure storage", () => {
    mkdirSync(home.path, { recursive: true });
    writeFileSync(join(home.path, "policy-limits.json"), "{\"restrictions\":{}}\n");
    vi.mocked(getSecureStorage).mockClear();
    expect(removeRetiredAgenCSignIn(home)).toEqual({ found: true, removed: true, errors: [] });
    expect(existsSync(join(home.path, "policy-limits.json"))).toBe(false);
    expect(getSecureStorage).not.toHaveBeenCalled();
  });

  it("still removes auth.json on a host without secure storage", () => {
    writeSignInState();
    vi.mocked(getSecureStorage).mockImplementationOnce(() => ({
      name: "unavailable-fixture",
      read: () => { throw new SecureStorageUnavailableError("no backend"); },
      readFresh: () => { throw new SecureStorageUnavailableError("no backend"); },
      readAsync: async () => { throw new SecureStorageUnavailableError("no backend"); },
      update: () => ({ success: false }),
      delete: () => false,
    }) as never);
    expect(removeRetiredAgenCSignIn(home)).toEqual({ found: true, removed: true, errors: [] });
    expect(existsSync(home.authPath)).toBe(false);
  });

  it("keeps auth.json, so the next start tries again, when secure storage cannot be updated", () => {
    seedSecureStorage();
    writeSignInState();
    vi.mocked(getSecureStorage).mockImplementationOnce(() => ({
      name: "failing-fixture",
      read: () => readNativeSecureStorage(home),
      readFresh: () => readNativeSecureStorage(home),
      readAsync: async () => readNativeSecureStorage(home),
      update: () => ({ success: false, warning: "locked keychain fixture" }),
      delete: () => false,
    }) as never);
    const result = removeRetiredAgenCSignIn(home);
    expect(result.found).toBe(true);
    expect(result.removed).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(String(result.errors[0])).not.toContain(BEARER);
    expect(existsSync(home.authPath)).toBe(true);
    expect(readNativeSecureStorage(home).remoteAuth?.bearerToken).toBe(BEARER);
  });

  it("drops only the retired sign-in fields", () => {
    expect(withoutRetiredSignIn({
      remoteAuth: { bearerToken: BEARER, createdAt: "x" },
      localAuth: { login: { token: LOCAL_TOKEN, createdAt: "x" } },
      remoteRuntimeAuth: { apiKey: "runtime-fixture" },
    })).toEqual({ remoteRuntimeAuth: { apiKey: "runtime-fixture" } });
  });
});
