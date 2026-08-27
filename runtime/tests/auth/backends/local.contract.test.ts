import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getSecureStorage } from "../../utils/secureStorage/index.js";
import { readNativeSecureStorage } from "../../utils/secureStorage/native.js";
import { resolveSecureStorageHome } from "../../utils/secureStorage/home.js";
import { LocalAuthBackend } from "./local.js";

const TEST_TOKEN = "00000000-0000-4000-8000-000000000000";
const TEST_TIME = new Date("2026-05-01T12:00:00.000Z");

async function makeTempHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agenc-local-auth-"));
}

describe("LocalAuthBackend", () => {
  const homes: string[] = [];

  beforeEach(() => {
    getSecureStorage(resolveSecureStorageHome(process.env)).delete();
  });

  afterEach(async () => {
    getSecureStorage(resolveSecureStorageHome(process.env)).delete();
    await Promise.all(
      homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
    );
  });

  it("persists the login token only in native secure storage", async () => {
    const home = await makeTempHome();
    homes.push(home);
    const backend = new LocalAuthBackend({
      env: { HOME: home },
      now: () => TEST_TIME,
      randomUUID: () => TEST_TOKEN,
    });

    await expect(backend.login()).resolves.toEqual({
      authenticated: true,
      provider: "local",
      token: TEST_TOKEN,
      identity: {
        accountId: "local",
        displayName: "Local AgenC user",
        plan: "free",
      },
    });

    const authFile = join(home, ".agenc", "auth.json");
    expect(backend.authFile()).toBe(authFile);
    const parsed = JSON.parse(await readFile(authFile, "utf8")) as Record<
      string,
      unknown
    >;
    expect(parsed).toEqual({
      version: 1,
      createdAt: TEST_TIME.toISOString(),
      provider: "local",
      identity: {
        accountId: "local",
        displayName: "Local AgenC user",
        plan: "free",
      },
    });
    expect(JSON.stringify(parsed)).not.toContain(TEST_TOKEN);
    expect(
      readNativeSecureStorage(
        resolveSecureStorageHome({ HOME: home }, join(home, ".agenc")),
      )
        .localAuth?.login,
    ).toEqual({
      token: TEST_TOKEN,
      createdAt: TEST_TIME.toISOString(),
    });
    expect((await stat(authFile)).mode & 0o777).toBe(0o600);
  });

  it("captures the custom-OAuth secure-storage identity before caller env mutation", async () => {
    const agencHome = await makeTempHome();
    homes.push(agencHome);
    const environment: Record<string, string> = {
      AGENC_HOME: agencHome,
      HOME: tmpdir(),
      AGENC_CUSTOM_OAUTH_URL: "https://agenc.tech",
    };
    const credentialHome = resolveSecureStorageHome(
      { ...environment },
      agencHome,
    );
    const backend = new LocalAuthBackend({
      agencHome,
      env: environment,
      now: () => TEST_TIME,
      randomUUID: () => TEST_TOKEN,
    });
    delete environment.AGENC_CUSTOM_OAUTH_URL;
    environment.AGENC_HOME = join(agencHome, "mutated");

    await backend.login();
    expect(readNativeSecureStorage(credentialHome).localAuth?.login).toEqual({
      token: TEST_TOKEN,
      createdAt: TEST_TIME.toISOString(),
    });
  });

  it("rolls back the native login when metadata persistence fails", async () => {
    const agencHome = await makeTempHome();
    homes.push(agencHome);
    await mkdir(join(agencHome, "auth.json"));
    const nativeHome = resolveSecureStorageHome({}, agencHome);
    const backend = new LocalAuthBackend({
      agencHome,
      now: () => TEST_TIME,
      randomUUID: () => TEST_TOKEN,
    });

    await expect(backend.login()).rejects.toMatchObject({
      code: expect.stringMatching(/EISDIR|ENOTDIR|ENOTEMPTY/u),
    });
    expect(readNativeSecureStorage(nativeHome).localAuth?.login).toBeUndefined();
  });

  it("reports local identity from disk and clears it on logout", async () => {
    const agencHome = await makeTempHome();
    homes.push(agencHome);
    const backend = new LocalAuthBackend({
      agencHome,
      randomUUID: () => TEST_TOKEN,
      now: () => TEST_TIME,
    });

    await expect(backend.whoami()).resolves.toEqual({
      authenticated: false,
    });
    await backend.login();
    await expect(backend.whoami()).resolves.toEqual({
      authenticated: true,
      provider: "local",
      identity: {
        accountId: "local",
        displayName: "Local AgenC user",
        plan: "free",
      },
    });
    await expect(backend.logout()).resolves.toEqual({
      authenticated: false,
    });
    await expect(backend.whoami()).resolves.toEqual({
      authenticated: false,
    });
  });

  it("treats malformed auth.json as logged out", async () => {
    const agencHome = await makeTempHome();
    homes.push(agencHome);
    const authFile = join(agencHome, "auth.json");
    await writeFile(authFile, "{not-json", { mode: 0o600 });
    const backend = new LocalAuthBackend({ agencHome });

    await expect(backend.whoami()).resolves.toEqual({
      authenticated: false,
    });
  });

  it("ignores legacy plaintext login and BYOK secrets", async () => {
    const agencHome = await makeTempHome();
    homes.push(agencHome);
    const authFile = join(agencHome, "auth.json");
    await writeFile(
      authFile,
      JSON.stringify({
        version: 1,
        token: TEST_TOKEN,
        createdAt: TEST_TIME.toISOString(),
        provider: "local",
        identity: {
          accountId: "local",
          displayName: "Local AgenC user",
          plan: "free",
        },
        byokKeys: {
          "": {
            provider: "",
            apiKey: "xai-test-key",
            savedAt: TEST_TIME.toISOString(),
          },
        },
      }),
      { mode: 0o600 },
    );
    const backend = new LocalAuthBackend({ agencHome });

    await expect(backend.whoami()).resolves.toEqual({
      authenticated: false,
    });
    await expect(backend.readByokKey("grok")).resolves.toBeUndefined();
  });

  it("persists and reads provider BYOK keys only in native secure storage", async () => {
    const agencHome = await makeTempHome();
    homes.push(agencHome);
    const backend = new LocalAuthBackend({
      agencHome,
      randomUUID: () => TEST_TOKEN,
      now: () => TEST_TIME,
    });

    await expect(
      backend.saveByokKey({
        provider: "Grok",
        apiKey: "xai-test-key",
      }),
    ).resolves.toEqual({
      provider: "grok",
      apiKey: "xai-test-key",
      savedAt: TEST_TIME.toISOString(),
    });
    await expect(backend.readByokKey("grok")).resolves.toBe("xai-test-key");

    expect(
      readNativeSecureStorage(resolveSecureStorageHome({}, agencHome))
        .localAuth,
    ).toMatchObject({
      byokKeys: {
        grok: {
          provider: "grok",
          apiKey: "xai-test-key",
          savedAt: TEST_TIME.toISOString(),
        },
      },
    });
    await expect(
      readFile(join(agencHome, "auth.json"), "utf8"),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      readFile(join(agencHome, "byok-keys.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not clobber a remote auth session when saving BYOK keys", async () => {
    const agencHome = await makeTempHome();
    homes.push(agencHome);
    const authFile = join(agencHome, "auth.json");
    const remoteAuth = {
      version: 1,
      provider: "remote",
      createdAt: TEST_TIME.toISOString(),
      identity: {
        accountId: "acct-1",
        email: "user@example.com",
      },
      subscriptionTier: "free",
    };
    await writeFile(authFile, `${JSON.stringify(remoteAuth, null, 2)}\n`, {
      mode: 0o600,
    });
    const backend = new LocalAuthBackend({
      agencHome,
      now: () => TEST_TIME,
    });

    await backend.saveByokKey({ provider: "grok", apiKey: "xai-test-key" });

    await expect(backend.readByokKey("grok")).resolves.toBe("xai-test-key");
    await expect(readFile(authFile, "utf8")).resolves.toBe(
      `${JSON.stringify(remoteAuth, null, 2)}\n`,
    );
  });

  it("preserves saved BYOK keys when local login refreshes the token", async () => {
    const agencHome = await makeTempHome();
    homes.push(agencHome);
    const backend = new LocalAuthBackend({
      agencHome,
      randomUUID: () => TEST_TOKEN,
      now: () => TEST_TIME,
    });

    await backend.saveByokKey({ provider: "grok", apiKey: "xai-test-key" });
    await backend.login();

    await expect(backend.readByokKey("grok")).resolves.toBe("xai-test-key");
  });

  it("preserves saved BYOK keys when logging out", async () => {
    const agencHome = await makeTempHome();
    homes.push(agencHome);
    const backend = new LocalAuthBackend({
      agencHome,
      randomUUID: () => TEST_TOKEN,
      now: () => TEST_TIME,
    });

    await backend.saveByokKey({ provider: "grok", apiKey: "xai-test-key" });
    await backend.login();
    await backend.logout();

    await expect(backend.readByokKey("grok")).resolves.toBe("xai-test-key");
  });

  it("rejects blank or whitespace BYOK key values", async () => {
    const agencHome = await makeTempHome();
    homes.push(agencHome);
    const backend = new LocalAuthBackend({ agencHome });

    await expect(
      backend.saveByokKey({ provider: "grok", apiKey: "   " }),
    ).rejects.toThrow(/API key is required/);
    await expect(
      backend.saveByokKey({ provider: "grok", apiKey: "xai test key" }),
    ).rejects.toThrow(/must not contain whitespace/);
  });

  it("forces BYOK fallback for managed keys and hosted model inference", () => {
    const backend = new LocalAuthBackend({
      agencHome: "/tmp/agenc-local-auth-test",
    });

    expect(() => backend.vendKey("grok", "session-1")).toThrow(
      /use BYOK fallback/,
    );
    expect(() => backend.inferAgencModel()).toThrow(
      /configured BYOK provider\/model selection/,
    );
    expect(backend.getSubscriptionTier()).toBe("free");
  });
});
