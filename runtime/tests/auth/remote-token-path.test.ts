import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  secureStorageIdentityKey,
  resolveSecureStorageHome,
} from "../../src/utils/secureStorage/home.js";

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_CWD = process.cwd();

function storageHome() {
  return resolveSecureStorageHome(process.env);
}

beforeEach(() => {
  vi.resetModules();
  vi.doUnmock("../utils/fsOperations.js");
  installInMemoryNativeStorage();
  resetEnv();
});

afterEach(() => {
  process.chdir(ORIGINAL_CWD);
  resetEnv();
  vi.resetModules();
});

describe("remote descriptor credential storage", () => {
  it("reads the remote OAuth bearer from native secure storage", async () => {
    const home = storageHome();
    const credentials = await loadRemoteRuntimeCredentials();
    credentials.storeRemoteRuntimeCredential(home, "apiKey", "native-api-key");
    credentials.storeRemoteRuntimeCredential(
      home,
      "oauthToken",
      "native-oauth-token",
    );

    const auth = await loadAuthFileDescriptor();

    expect(auth.getOAuthTokenFromFileDescriptor(home, {})).toBe(
      "native-oauth-token",
    );
    expect(auth.getApiKeyFromFileDescriptor(home, {})).toBe(
      "native-api-key",
    );
  });

  it("lets an explicit descriptor beat and replace the persisted bearer", async () => {
    const home = storageHome();
    process.env.AGENC_OAUTH_TOKEN_FILE_DESCRIPTOR = "9";
    mockDescriptorRead("descriptor-oauth-token");
    const credentials = await loadRemoteRuntimeCredentials();
    credentials.storeRemoteRuntimeCredential(
      home,
      "oauthToken",
      "persisted-oauth-token",
    );

    const auth = await loadAuthFileDescriptor();

    expect(
      auth.getOAuthTokenFromFileDescriptor(home, process.env),
    ).toBe(
      "descriptor-oauth-token",
    );
    expect(
      credentials.readRemoteRuntimeCredential(home, "oauthToken"),
    ).toBe("descriptor-oauth-token");
  });

  it("uses native storage when a child inherits an unreadable descriptor number", async () => {
    const home = storageHome();
    process.env.AGENC_OAUTH_TOKEN_FILE_DESCRIPTOR = "9";
    mockDescriptorFailure();
    const credentials = await loadRemoteRuntimeCredentials();
    credentials.storeRemoteRuntimeCredential(
      home,
      "oauthToken",
      "native-child-token",
    );

    const auth = await loadAuthFileDescriptor();

    expect(
      auth.getOAuthTokenFromFileDescriptor(home, process.env),
    ).toBe("native-child-token");
  });

  it("never creates the retired remote plaintext token directory", async () => {
    const home = storageHome();
    const cwd = await mkdtemp(join(tmpdir(), "agenc-remote-token-cwd-"));
    const retiredTokenDir = join(cwd, "retired-token-dir");
    process.env.AGENC_REMOTE = "1";
    process.env.AGENC_REMOTE_TOKEN_DIR = retiredTokenDir;
    process.env.AGENC_OAUTH_TOKEN_FILE_DESCRIPTOR = "9";
    process.chdir(cwd);
    mockDescriptorRead("descriptor-oauth-token");

    const auth = await loadAuthFileDescriptor();
    expect(
      auth.getOAuthTokenFromFileDescriptor(home, process.env),
    ).toBe(
      "descriptor-oauth-token",
    );
    await expect(stat(retiredTokenDir)).rejects.toMatchObject({ code: "ENOENT" });
    await rm(cwd, { recursive: true, force: true });
  });

  it("ignores the retired session-ingress token file authority", async () => {
    const home = storageHome();
    const cwd = await mkdtemp(join(tmpdir(), "agenc-session-ingress-token-"));
    const retiredTokenFile = join(cwd, "session-token");
    await writeFile(retiredTokenFile, "plaintext-file-token", { mode: 0o600 });
    process.env.AGENC_SESSION_INGRESS_TOKEN_FILE = retiredTokenFile;
    const credentials = await loadRemoteRuntimeCredentials();
    credentials.storeRemoteRuntimeCredential(
      home,
      "sessionIngressToken",
      "native-session-token",
    );

    const ingress = await loadSessionIngressAuth();

    expect(ingress.getSessionIngressAuthToken(home, {})).toBe(
      "native-session-token",
    );
    await rm(cwd, { recursive: true, force: true });
  });

  it("lets the explicit session env token beat native persistence", async () => {
    const home = storageHome();
    process.env.AGENC_SESSION_ACCESS_TOKEN = "explicit-session-token";
    const credentials = await loadRemoteRuntimeCredentials();
    credentials.storeRemoteRuntimeCredential(
      home,
      "sessionIngressToken",
      "native-session-token",
    );

    const ingress = await loadSessionIngressAuth();

    expect(
      ingress.getSessionIngressAuthToken(home, process.env),
    ).toBe("explicit-session-token");
  });

  it("does not forward the retired token-directory override to teammates", async () => {
    process.env.AGENC_REMOTE_TOKEN_DIR = "/remote/tokens";

    const { buildInheritedEnvVars } = await loadSpawnUtils();
    const { runWithAgentRuntimeOptions } = await import(
      "../session/runtime-options.js"
    );
    const runtimeOptions = Object.freeze({
      simpleMode: false,
      stdinDataMode: false,
      remoteMode: false,
      sessionTempRoot: "/tmp/agenc-remote-token-test-temp",
      pluginStorageRoot: "/tmp/agenc-remote-token-test-plugins",
      allowUntrustedHooks: false,
    });

    expect(
      runWithAgentRuntimeOptions(runtimeOptions, () =>
        buildInheritedEnvVars({ HOME: "/tmp", PATH: "/usr/bin:/bin" }),
      ),
    ).not.toContain("AGENC_REMOTE_TOKEN_DIR");
  });

  it("isolates one-shot descriptor caches by explicit home and environment", async () => {
    const homeAPath = await mkdtemp(join(tmpdir(), "agenc-fd-home-a-"));
    const homeBPath = await mkdtemp(join(tmpdir(), "agenc-fd-home-b-"));
    let descriptorToken = "token-a";
    mockDescriptorReadFrom(() => descriptorToken);
    const auth = await loadAuthFileDescriptor();
    const homeA = resolveSecureStorageHome({ HOME: homeAPath }, homeAPath);
    const homeB = resolveSecureStorageHome({ HOME: homeBPath }, homeBPath);

    expect(
      auth.getOAuthTokenFromFileDescriptor(homeA, {
        AGENC_OAUTH_TOKEN_FILE_DESCRIPTOR: "9",
      }),
    ).toBe("token-a");
    descriptorToken = "token-b";
    expect(
      auth.getOAuthTokenFromFileDescriptor(homeB, {
        AGENC_OAUTH_TOKEN_FILE_DESCRIPTOR: "9",
      }),
    ).toBe("token-b");
    expect(
      auth.getOAuthTokenFromFileDescriptor(homeA, {
        AGENC_OAUTH_TOKEN_FILE_DESCRIPTOR: "9",
      }),
    ).toBe("token-a");

    await rm(homeAPath, { recursive: true, force: true });
    await rm(homeBPath, { recursive: true, force: true });
  });

  it("isolates descriptor caches across same-path OAuth storage identities", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "agenc-fd-oauth-stores-"));
    const prodHome = resolveSecureStorageHome({ HOME: homePath }, homePath);
    const localHome = resolveSecureStorageHome(
      { HOME: homePath, USER_TYPE: "ant", USE_LOCAL_OAUTH: "1" },
      homePath,
    );
    const customHome = resolveSecureStorageHome(
      { HOME: homePath, AGENC_CUSTOM_OAUTH_URL: "https://agenc.tech" },
      homePath,
    );
    const homes = [
      [prodHome, "prod"],
      [localHome, "local"],
      [customHome, "custom"],
    ] as const;
    let descriptorToken = "";
    mockDescriptorReadFrom(() => descriptorToken);

    const auth = await loadAuthFileDescriptor();
    for (const [home, label] of homes) {
      descriptorToken = `oauth-${label}`;
      expect(
        auth.getOAuthTokenFromFileDescriptor(home, {
          AGENC_OAUTH_TOKEN_FILE_DESCRIPTOR: "9",
        }),
      ).toBe(`oauth-${label}`);
    }

    const ingress = await loadSessionIngressAuth();
    for (const [home, label] of homes) {
      descriptorToken = `session-${label}`;
      expect(
        ingress.getSessionIngressAuthToken(home, {
          AGENC_WEBSOCKET_AUTH_FILE_DESCRIPTOR: "9",
        }),
      ).toBe(`session-${label}`);
    }

    await rm(homePath, { recursive: true, force: true });
  });
});

async function loadAuthFileDescriptor(): Promise<
  typeof import("../utils/authFileDescriptor.js")
> {
  return import("../utils/authFileDescriptor.js");
}

async function loadRemoteRuntimeCredentials(): Promise<
  typeof import("../utils/secureStorage/remoteRuntimeCredentials.js")
> {
  return import("../utils/secureStorage/remoteRuntimeCredentials.js");
}

function installInMemoryNativeStorage(): void {
  const records = new Map<string, import("../../src/utils/secureStorage/index.js").SecureStorageData>();
  vi.doMock("../utils/secureStorage/index.js", async (importOriginal) => {
    const original = await importOriginal<
      typeof import("../../src/utils/secureStorage/index.js")
    >();
    return {
      ...original,
      getSecureStorage: (home: Parameters<typeof secureStorageIdentityKey>[0]) => ({
        name: "in-memory-native-test-storage",
        read: () => structuredClone(records.get(secureStorageIdentityKey(home)) ?? null),
        readAsync: async () =>
          structuredClone(records.get(secureStorageIdentityKey(home)) ?? null),
        update: (data: import("../../src/utils/secureStorage/index.js").SecureStorageData) => {
          records.set(secureStorageIdentityKey(home), structuredClone(data));
          return { success: true };
        },
        delete: () => records.delete(secureStorageIdentityKey(home)),
      }),
    };
  });
}

async function loadSessionIngressAuth(): Promise<
  typeof import("../utils/sessionIngressAuth.js")
> {
  return import("../utils/sessionIngressAuth.js");
}

function mockDescriptorRead(token: string): void {
  mockDescriptorReadFrom(() => token);
}

function mockDescriptorReadFrom(readToken: () => string): void {
  vi.doMock("../utils/fsOperations.js", async (importOriginal) => {
    const original = await importOriginal<
      typeof import("../utils/fsOperations.js")
    >();
    return {
      ...original,
      getFsImplementation: () => ({
        ...original.getFsImplementation(),
        readFileSync: () => readToken(),
      }),
    };
  });
}

function mockDescriptorFailure(): void {
  vi.doMock("../utils/fsOperations.js", async (importOriginal) => {
    const original = await importOriginal<
      typeof import("../utils/fsOperations.js")
    >();
    return {
      ...original,
      getFsImplementation: () => ({
        ...original.getFsImplementation(),
        readFileSync: () => {
          throw Object.assign(new Error("descriptor unavailable"), {
            code: "ENXIO",
          });
        },
      }),
    };
  });
}

async function loadSpawnUtils(): Promise<
  typeof import("../utils/swarm/spawnUtils.js")
> {
  vi.doMock("../bootstrap/state.js", () => ({
    getChromeFlagOverride: () => undefined,
    getInlinePlugins: () => [],
  }));
  vi.doMock("../utils/bundledMode.js", () => ({
    isInBundledMode: () => false,
  }));
  vi.doMock("../utils/swarm/backends/teammateModeSnapshot.js", () => ({
    getTeammateModeFromSnapshot: () => "default",
  }));
  vi.doMock("../utils/model/providers.js", () => ({
    getSelectedProviderSelection: () => ({
      provider: "grok",
      model: "grok-test",
      environment: {},
    }),
  }));
  vi.doMock("../utils/envUtils.js", () => ({
    getAgenCHomeDir: () => "/tmp/agenc-remote-token-test-home",
  }));
  return import("../utils/swarm/spawnUtils.js");
}

function resetEnv(): void {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, ORIGINAL_ENV, { NODE_ENV: "test" });
  delete process.env.AGENC_API_KEY_FILE_DESCRIPTOR;
  delete process.env.AGENC_OAUTH_TOKEN_FILE_DESCRIPTOR;
  delete process.env.AGENC_REMOTE_TOKEN_DIR;
  delete process.env.AGENC_SESSION_ACCESS_TOKEN;
  delete process.env.AGENC_SESSION_INGRESS_TOKEN_FILE;
  delete process.env.AGENC_WEBSOCKET_AUTH_FILE_DESCRIPTOR;
}
