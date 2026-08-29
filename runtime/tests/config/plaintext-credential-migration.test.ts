import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  getSecureStorageForMigration,
  type SecureStorage,
  type SecureStorageData,
} from "../../src/utils/secureStorage/index.js";
import { resolveMigrationHomeContext } from "../../src/config/home.js";
import { getRetiredSecureStorageIdentity } from "../../src/utils/secureStorage/migrationIdentity.js";

const native = vi.hoisted(() => ({
  data: {} as SecureStorageData,
  unavailable: false,
  afterUpdate: null as (() => void) | null,
  homePaths: [] as string[],
  dataByHome: new Map<string, SecureStorageData>(),
}));

vi.mock("../../src/utils/secureStorage/native.js", () => ({
  readNativeSecureStorage: (home: { path: string }) => {
    native.homePaths.push(home.path);
    return structuredClone(
      native.dataByHome.size > 0
        ? native.dataByHome.get(home.path) ?? {}
        : native.data,
    );
  },
  readNativeSecureStorageFresh: (home: { path: string }) => {
    native.homePaths.push(home.path);
    return structuredClone(
      native.dataByHome.size > 0
        ? native.dataByHome.get(home.path) ?? {}
        : native.data,
    );
  },
  updateNativeSecureStorage: (
    home: { path: string },
    updater: (current: Readonly<SecureStorageData>) => SecureStorageData,
    message: string,
  ) => {
    native.homePaths.push(home.path);
    if (native.unavailable) throw new Error(message);
    const previous = structuredClone(
      native.dataByHome.size > 0
        ? native.dataByHome.get(home.path) ?? {}
        : native.data,
    );
    const written = structuredClone(updater(previous));
    if (native.dataByHome.size > 0) native.dataByHome.set(home.path, written);
    else native.data = written;
    const afterUpdate = native.afterUpdate;
    native.afterUpdate = null;
    afterUpdate?.();
    return { previous, written };
  },
  replaceUnreadableNativeSecureStorageForMigration: (
    home: { path: string },
    replacement: SecureStorageData,
    message: string,
  ) => {
    native.homePaths.push(home.path);
    if (native.unavailable) throw new Error(message);
    const written = structuredClone(replacement);
    if (native.dataByHome.size > 0) native.dataByHome.set(home.path, written);
    else native.data = written;
    const afterUpdate = native.afterUpdate;
    native.afterUpdate = null;
    afterUpdate?.();
    return { previous: {}, written };
  },
  rollbackNativeSecureStorage: (
    home: { path: string },
    transaction: { previous: SecureStorageData; written: SecureStorageData } | null,
    updater: (
      current: Readonly<SecureStorageData>,
      transaction: { previous: SecureStorageData; written: SecureStorageData },
    ) => SecureStorageData,
    message: string,
  ) => {
    if (transaction === null) return;
    native.homePaths.push(home.path);
    if (native.unavailable) throw new Error(message);
    const current = structuredClone(
      native.dataByHome.size > 0
        ? native.dataByHome.get(home.path) ?? {}
        : native.data,
    );
    const restored = structuredClone(updater(current, transaction));
    if (native.dataByHome.size > 0) native.dataByHome.set(home.path, restored);
    else native.data = restored;
  },
}));

import {
  applyConfigV2Migration,
  checkConfigV2Migration,
  rollbackConfigV2Migration,
} from "../../src/config/migration.js";

const temporaryDirectories: string[] = [];
const migrationStorageMock = vi.mocked(getSecureStorageForMigration);
const defaultMigrationStorageFactory = migrationStorageMock.getMockImplementation();
const migrationStoragesToClean = new Set<SecureStorage>();

function openMigrationStorage(
  ...args: Parameters<typeof getSecureStorageForMigration>
): SecureStorage {
  const storage = getSecureStorageForMigration(...args);
  migrationStoragesToClean.add(storage);
  return storage;
}

function temp(): string {
  const path = mkdtempSync(join(tmpdir(), "agenc-credential-migration-"));
  temporaryDirectories.push(path);
  return path;
}

beforeEach(() => {
  native.data = {};
  native.unavailable = false;
  native.afterUpdate = null;
  native.homePaths = [];
  native.dataByHome.clear();
  if (defaultMigrationStorageFactory) {
    migrationStorageMock.mockImplementation(defaultMigrationStorageFactory);
  }
});

afterEach(() => {
  for (const storage of migrationStoragesToClean) storage.delete();
  migrationStoragesToClean.clear();
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function options(home: string, id: string) {
  const root = join(home, "..");
  return {
    env: {},
    home,
    projectRoot: join(root, "project"),
    managedConfigPath: join(root, "managed", "config.toml"),
    managedSettingsPath: join(root, "managed", "managed-settings.json"),
    globalStatePath: join(root, "missing-global.json"),
    id,
    confirmRetiredWritersStopped: true,
  } as const;
}

describe("explicit plaintext credential migration", () => {
  test("copies the old unscoped vault and retains its shared default-home source", async () => {
    const root = temp();
    const home = join(root, "relocated-home");
    mkdirSync(home, { recursive: true });
    const env = { AGENC_HOME: home };
    const homeContext = resolveMigrationHomeContext(env, { platformHome: root });
    const retiredIdentity = getRetiredSecureStorageIdentity(env, root);
    const retiredStorage = openMigrationStorage(
      homeContext,
      retiredIdentity,
    );
    expect(retiredStorage.update({
      primaryApiKey: "old-unscoped-secret",
      mcpOAuthClientConfig: { server: { clientSecret: "client-secret" } },
    }).success).toBe(true);
    native.data = { trustedDeviceToken: "canonical-unrelated" };

    const plan = await checkConfigV2Migration({
      ...options(home, "vault-home-cutover"),
      platformHome: root,
    });

    expect(plan.conflicts).toEqual([]);
    expect(plan.secureStorageNamespaceMigration).toMatchObject({
      source: retiredIdentity,
      sourceDisposition: "retain-shared",
      fields: ["mcpOAuthClientConfig", "primaryApiKey"],
    });
    expect(JSON.stringify(plan)).not.toContain("old-unscoped-secret");
    expect(JSON.stringify(plan)).not.toContain("client-secret");

    const applied = await applyConfigV2Migration(plan);
    expect(native.data).toEqual({
      trustedDeviceToken: "canonical-unrelated",
      primaryApiKey: "old-unscoped-secret",
      mcpOAuthClientConfig: { server: { clientSecret: "client-secret" } },
    });
    expect(retiredStorage.read()).toEqual({
      primaryApiKey: "old-unscoped-secret",
      mcpOAuthClientConfig: { server: { clientSecret: "client-secret" } },
    });
    const journal = readFileSync(applied.journalPath, "utf8");
    expect(journal).not.toContain("old-unscoped-secret");
    expect(journal).not.toContain("client-secret");

    await rollbackConfigV2Migration("vault-home-cutover", {
      env,
      home,
      platformHome: root,
    });
    expect(retiredStorage.read()?.primaryApiKey).toBe("old-unscoped-secret");
    expect(native.data.primaryApiKey).toBe("old-unscoped-secret");
  });

  test("deletes the shared unscoped vault only after explicit ownership confirmation", async () => {
    const root = temp();
    const home = join(root, "relocated-home");
    mkdirSync(home, { recursive: true });
    const env = { AGENC_HOME: home };
    const homeContext = resolveMigrationHomeContext(env, { platformHome: root });
    const retiredIdentity = getRetiredSecureStorageIdentity(env, root);
    const retiredStorage = openMigrationStorage(
      homeContext,
      retiredIdentity,
    );
    expect(retiredStorage.update({ primaryApiKey: "confirmed-transfer" }).success)
      .toBe(true);

    const plan = await checkConfigV2Migration({
      ...options(home, "vault-shared-confirmed"),
      platformHome: root,
      retireSharedSecureStorage: true,
    });
    expect(plan.secureStorageNamespaceMigration?.sourceDisposition).toBe(
      "delete-shared-confirmed",
    );

    await applyConfigV2Migration(plan);
    expect(native.data.primaryApiKey).toBe("confirmed-transfer");
    expect(retiredStorage.read()).toBeNull();
  });

  test("fails a copy-retain cutover if a retired writer changes the source after commit", async () => {
    const root = temp();
    const home = join(root, "relocated-home");
    mkdirSync(home, { recursive: true });
    const env = { AGENC_HOME: home };
    const homeContext = resolveMigrationHomeContext(env, { platformHome: root });
    const retiredIdentity = getRetiredSecureStorageIdentity(env, root);
    const retiredStorage = openMigrationStorage(homeContext, retiredIdentity);
    retiredStorage.update({ primaryApiKey: "checked-secret" });

    const plan = await checkConfigV2Migration({
      ...options(home, "vault-retain-writer-race"),
      platformHome: root,
    });
    expect(plan.secureStorageNamespaceMigration?.sourceDisposition).toBe(
      "retain-shared",
    );
    native.afterUpdate = () => {
      retiredStorage.update({ primaryApiKey: "newer-retired-secret" });
    };

    await expect(applyConfigV2Migration(plan)).rejects.toThrow(
      /retained native secure storage namespace changed/u,
    );
    expect(retiredStorage.read()?.primaryApiKey).toBe("newer-retired-secret");
    expect(native.data.primaryApiKey).toBe("checked-secret");
  });

  test("copies an explicitly scoped default AGENC_CONFIG_DIR vault and retains its collision-prone source", async () => {
    const root = temp();
    const home = join(root, ".agenc");
    mkdirSync(home, { recursive: true });
    const env = {
      AGENC_HOME: home,
      AGENC_CONFIG_DIR: home,
    };
    const homeContext = resolveMigrationHomeContext(env, { platformHome: root });
    const retiredIdentity = getRetiredSecureStorageIdentity(env, root);
    const retiredStorage = openMigrationStorage(
      homeContext,
      retiredIdentity,
    );
    expect(retiredStorage.update({ primaryApiKey: "old-scoped-secret" }).success)
      .toBe(true);

    const plan = await checkConfigV2Migration({
      ...options(home, "vault-default-cutover"),
      env: { AGENC_CONFIG_DIR: home },
      platformHome: root,
    });
    expect(plan.conflicts).toEqual([]);
    expect(plan.secureStorageNamespaceMigration?.source.serviceName).toBe(
      retiredIdentity.serviceName,
    );
    expect(plan.secureStorageNamespaceMigration?.sourceDisposition).toBe(
      "retain-shared",
    );

    await applyConfigV2Migration(plan);
    expect(native.data.primaryApiKey).toBe("old-scoped-secret");
    expect(retiredStorage.read()?.primaryApiKey).toBe("old-scoped-secret");
  });

  test("re-encrypts a default Windows DPAPI file in place when historical USER entropy differs", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      const root = temp();
      const home = join(root, ".agenc");
      mkdirSync(home, { recursive: true });
      const env = { AGENC_HOME: home, USER: "historical-shell-user" };
      const homeContext = resolveMigrationHomeContext(env, {
        platformHome: root,
        platform: "win32",
      });
      const retiredIdentity = getRetiredSecureStorageIdentity(env, root);
      const retiredStorage = openMigrationStorage(
        homeContext,
        retiredIdentity,
      );
      retiredStorage.update({ primaryApiKey: "windows-retired-secret" });

      const plan = await checkConfigV2Migration({
        ...options(home, "windows-account-reencrypt"),
        env,
        platformHome: root,
      });
      expect(plan.secureStorageNamespaceMigration).toMatchObject({
        sourceDisposition: "rewrite-in-place",
        source: { accountName: "historical-shell-user" },
      });
      expect(plan.secureStorageNamespaceMigration?.target.accountName).not.toBe(
        "historical-shell-user",
      );

      await applyConfigV2Migration(plan);
      expect(native.data.primaryApiKey).toBe("windows-retired-secret");
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  test("reports a vault namespace conflict without changing either record", async () => {
    const root = temp();
    const home = join(root, "relocated-home");
    mkdirSync(home, { recursive: true });
    const env = { AGENC_HOME: home };
    const homeContext = resolveMigrationHomeContext(env, { platformHome: root });
    const retiredIdentity = getRetiredSecureStorageIdentity(env, root);
    const retiredStorage = openMigrationStorage(
      homeContext,
      retiredIdentity,
    );
    expect(retiredStorage.update({ primaryApiKey: "retired-value" }).success)
      .toBe(true);
    native.data = { primaryApiKey: "canonical-value" };

    const plan = await checkConfigV2Migration({
      ...options(home, "vault-conflict"),
      platformHome: root,
    });

    expect(plan.conflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        field: "credentials",
        reason: expect.stringMatching(/conflicts.*primaryApiKey/u),
      }),
    ]));
    expect(plan.writes).toEqual([]);
    expect(native.data.primaryApiKey).toBe("canonical-value");
    expect(retiredStorage.read()?.primaryApiKey).toBe("retired-value");
  });

  test("keeps the canonical copy after a retired writer races final cleanup", async () => {
    const root = temp();
    const home = join(root, "relocated-home");
    const plaintextSource = join(home, ".credentials.json");
    mkdirSync(home, { recursive: true });
    writeFileSync(
      plaintextSource,
      JSON.stringify({ trustedDeviceToken: "plaintext-token" }),
      { mode: 0o600 },
    );
    let retiredData: SecureStorageData | null = {
      primaryApiKey: "retired-native-secret",
    };
    let mutateOnDelete = false;
    migrationStorageMock.mockImplementation(() => ({
      name: "controlled-retired-vault",
      read: () => retiredData === null ? null : structuredClone(retiredData),
      readAsync: async () =>
        retiredData === null ? null : structuredClone(retiredData),
      update: data => {
        retiredData = structuredClone(data);
        return { success: true };
      },
      delete: () => {
        retiredData = null;
        if (mutateOnDelete) {
          writeFileSync(
            plaintextSource,
            JSON.stringify({ trustedDeviceToken: "changed-after-check" }),
            { mode: 0o600 },
          );
        }
        return true;
      },
    }));
    native.data = { chromePairingIdentity: {
      pairedDeviceId: "unrelated-device",
      pairedDeviceName: "unrelated",
    } };

    const plan = await checkConfigV2Migration({
      ...options(home, "vault-restore-on-failure"),
      platformHome: root,
      retireSharedSecureStorage: true,
    });
    expect(plan.conflicts).toEqual([]);
    mutateOnDelete = true;

    await expect(applyConfigV2Migration(plan)).rejects.toThrow(
      /changed during credential cutover/u,
    );
    expect(retiredData).toBeNull();
    expect(native.data).toEqual({
      chromePairingIdentity: {
        pairedDeviceId: "unrelated-device",
        pairedDeviceName: "unrelated",
      },
      primaryApiKey: "retired-native-secret",
      trustedDeviceToken: "plaintext-token",
    });
    expect(existsSync(plaintextSource)).toBe(true);
  });

  test("keeps canonical credentials once retired-vault deletion was attempted", async () => {
    const root = temp();
    const home = join(root, "relocated-home");
    mkdirSync(home, { recursive: true });
    let retiredData: SecureStorageData | null = {
      primaryApiKey: "retired-secret",
    };
    migrationStorageMock.mockImplementation(() => ({
      name: "undeletable-retired-vault",
      read: () => retiredData === null ? null : structuredClone(retiredData),
      readAsync: async () =>
        retiredData === null ? null : structuredClone(retiredData),
      update: data => {
        retiredData = structuredClone(data);
        return { success: true };
      },
      delete: () => false,
    }));
    native.data = { trustedDeviceToken: "canonical-unrelated" };

    const plan = await checkConfigV2Migration({
      ...options(home, "vault-delete-failure"),
      platformHome: root,
      retireSharedSecureStorage: true,
    });

    await expect(applyConfigV2Migration(plan)).rejects.toThrow(
      /could not be deleted/u,
    );
    expect(retiredData).toEqual({ primaryApiKey: "retired-secret" });
    expect(native.data).toEqual({
      trustedDeviceToken: "canonical-unrelated",
      primaryApiKey: "retired-secret",
    });
  });

  test("accepts authoritative absence even when retired deletion reports failure", async () => {
    const root = temp();
    const home = join(root, "relocated-home");
    mkdirSync(home, { recursive: true });
    let retiredData: SecureStorageData | null = {
      primaryApiKey: "retired-secret",
    };
    migrationStorageMock.mockImplementation(() => ({
      name: "ambiguous-delete-retired-vault",
      read: () => retiredData === null ? null : structuredClone(retiredData),
      readAsync: async () =>
        retiredData === null ? null : structuredClone(retiredData),
      update: data => {
        retiredData = structuredClone(data);
        return { success: true };
      },
      delete: () => {
        retiredData = null;
        return false;
      },
    }));

    const plan = await checkConfigV2Migration({
      ...options(home, "vault-delete-false-but-absent"),
      platformHome: root,
      retireSharedSecureStorage: true,
    });
    await expect(applyConfigV2Migration(plan)).resolves.toMatchObject({
      id: "vault-delete-false-but-absent",
    });
    expect(retiredData).toBeNull();
    expect(native.data.primaryApiKey).toBe("retired-secret");
  });

  test("preserves the canonical copy when deletion changes the retired source", async () => {
    const root = temp();
    const home = join(root, "relocated-home");
    mkdirSync(home, { recursive: true });
    let retiredData: SecureStorageData | null = {
      primaryApiKey: "retired-secret",
    };
    migrationStorageMock.mockImplementation(() => ({
      name: "racing-retired-vault",
      read: () => retiredData === null ? null : structuredClone(retiredData),
      readAsync: async () =>
        retiredData === null ? null : structuredClone(retiredData),
      update: data => {
        retiredData = structuredClone(data);
        return { success: true };
      },
      delete: () => {
        retiredData = { primaryApiKey: "replacement-secret" };
        return true;
      },
    }));

    const plan = await checkConfigV2Migration({
      ...options(home, "vault-delete-race"),
      platformHome: root,
      retireSharedSecureStorage: true,
    });
    await expect(applyConfigV2Migration(plan)).rejects.toThrow(
      /changed during deletion/u,
    );
    expect(retiredData).toEqual({ primaryApiKey: "replacement-secret" });
    expect(native.data.primaryApiKey).toBe("retired-secret");
  });

  test("rejects duplicate credential JSON keys without exposing either value", async () => {
    const root = temp();
    const home = join(root, "home");
    const source = join(home, ".credentials.json");
    mkdirSync(home, { recursive: true });
    writeFileSync(
      source,
      '{"primaryApiKey":"first-secret","primaryApiKey":"second-secret"}\n',
      { mode: 0o600 },
    );

    const plan = await checkConfigV2Migration(
      options(home, "credential-duplicate-key"),
    );
    expect(plan.conflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: expect.stringMatching(/duplicate object keys/u) }),
    ]));
    expect(JSON.stringify(plan)).not.toContain("first-secret");
    expect(JSON.stringify(plan)).not.toContain("second-secret");
    expect(plan.writes).toEqual([]);
    expect(readFileSync(source, "utf8")).toContain("first-secret");
  });

  test("requires an explicit stopped-writer assertion before plaintext sanitization", async () => {
    const root = temp();
    const home = join(root, "home");
    const source = join(home, ".credentials.json");
    mkdirSync(home, { recursive: true });
    writeFileSync(source, JSON.stringify({ primaryApiKey: "secret-key" }), {
      mode: 0o600,
    });

    const plan = await checkConfigV2Migration({
      ...options(home, "credential-quiescence-required"),
      confirmRetiredWritersStopped: false,
    });
    expect(plan.requiresRetiredWriterQuiescence).toBe(true);
    await expect(applyConfigV2Migration(plan)).rejects.toThrow(
      /retired AgenC writer is stopped/u,
    );
    expect(readFileSync(source, "utf8")).toContain("secret-key");
    expect(native.data).toEqual({});
  });

  test("rejects removed Gemini token storage without changing the source or vault", async () => {
    const root = temp();
    const home = join(root, "home");
    const source = join(home, ".credentials.json");
    const legacy = JSON.stringify({
      gemini: { accessToken: "removed-gemini-token" },
    });
    mkdirSync(home, { recursive: true });
    writeFileSync(source, legacy, { mode: 0o600 });
    native.data = { trustedDeviceToken: "unrelated" };

    const plan = await checkConfigV2Migration(
      options(home, "removed-gemini-token"),
    );

    expect(plan.conflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        field: "credentials",
        reason: expect.stringMatching(/unsupported fields.*gemini/u),
      }),
    ]));
    expect(plan.writes).toEqual([]);
    expect(readFileSync(source, "utf8")).toBe(legacy);
    expect(native.data).toEqual({ trustedDeviceToken: "unrelated" });
  });

  test("moves secrets one-way into the native secure storage without a plaintext archive", async () => {
    const root = temp();
    const home = join(root, "home");
    const source = join(home, ".credentials.json");
    const legacy = JSON.stringify({
      primaryApiKey: "secret-key",
      apiKeyApprovals: { approved: ["sha256:approved"] },
      githubModels: {
        accessToken: "github-access-token",
        oauthAccessToken: "github-oauth-token",
      },
      agenc: {
        apiKey: "openai-platform-key",
        accessToken: "openai-access-token",
        accountId: "openai-account",
        profileId: "obsolete-profile-link",
      },
    });
    mkdirSync(home, { recursive: true });
    writeFileSync(source, legacy, { mode: 0o600 });
    native.data = { trustedDeviceToken: "unrelated" };

    const plan = await checkConfigV2Migration(options(home, "credential-success"));
    expect(plan.conflicts).toEqual([]);
    expect(plan.credentialMigration?.sourcePath).toBe(source);

    const applied = await applyConfigV2Migration(plan);
    expect(native.data).toEqual({
      trustedDeviceToken: "unrelated",
      primaryApiKey: "secret-key",
      apiKeyApprovals: { approved: ["sha256:approved"] },
      githubModels: {
        accessToken: "github-access-token",
        oauthAccessToken: "github-oauth-token",
      },
      openAiOauth: {
        apiKey: "openai-platform-key",
        accessToken: "openai-access-token",
        accountId: "openai-account",
        authMode: "apiKey",
      },
    });
    expect(existsSync(source)).toBe(false);
    expect(existsSync(`${source}.migrated-v2-credential-success`)).toBe(false);
    expect(applied.archives).toBe(0);
    const journal = readFileSync(applied.journalPath, "utf8");
    expect(journal).not.toContain("secret-key");
    expect(journal).not.toContain("sha256:approved");
    expect(journal).not.toContain("github-access-token");
    expect(journal).not.toContain("github-oauth-token");
    expect(journal).not.toContain("openai-platform-key");
    expect(journal).not.toContain("openai-access-token");

    await rollbackConfigV2Migration("credential-success", { env: {}, home });
    expect(existsSync(source)).toBe(false);
    expect(native.data).toEqual({
      trustedDeviceToken: "unrelated",
      primaryApiKey: "secret-key",
      apiKeyApprovals: { approved: ["sha256:approved"] },
      githubModels: {
        accessToken: "github-access-token",
        oauthAccessToken: "github-oauth-token",
      },
      openAiOauth: {
        apiKey: "openai-platform-key",
        accessToken: "openai-access-token",
        accountId: "openai-account",
        authMode: "apiKey",
      },
    });
  });

  test("atomically sanitizes every discovered retired auth source without secret journals", async () => {
    const root = temp();
    const home = join(root, "home");
    const authPath = join(home, "auth.json");
    const byokPath = join(home, "byok-keys.json");
    const providerCodePath = join(root, ".providerCode", "auth.json");
    const createdAt = "2026-08-24T00:00:00.000Z";
    mkdirSync(home, { recursive: true });
    mkdirSync(join(root, ".providerCode"), { recursive: true });
    writeFileSync(authPath, JSON.stringify({
      version: 1,
      provider: "local",
      token: "local-login-secret",
      createdAt,
      identity: { accountId: "local-user" },
      unknownSecret: "must-not-survive",
    }), { mode: 0o600 });
    writeFileSync(byokPath, JSON.stringify({
      version: 1,
      byokKeys: {
        grok: { provider: "grok", apiKey: "grok-secret", savedAt: createdAt },
      },
    }), { mode: 0o600 });
    writeFileSync(providerCodePath, JSON.stringify({
      tokens: {
        access_token: "provider-access-secret",
        id_token: "provider-id-secret",
        account_id: "provider-account",
      },
    }), { mode: 0o600 });
    native.data = { trustedDeviceToken: "unrelated" };

    const plan = await checkConfigV2Migration(options(home, "all-retired-auth"));
    expect(plan.conflicts).toEqual([]);
    expect(plan.retiredAuthMigration?.descriptor.fileActions).toHaveLength(3);
    const applied = await applyConfigV2Migration(plan);

    expect(applied.credentialSourcesSanitized).toBe(3);
    expect(native.data).toMatchObject({
      trustedDeviceToken: "unrelated",
      localAuth: {
        login: { token: "local-login-secret", createdAt },
        byokKeys: {
          grok: { provider: "grok", apiKey: "grok-secret", savedAt: createdAt },
        },
      },
      openAiOauth: {
        authMode: "chatgpt",
        accessToken: "provider-access-secret",
        idToken: "provider-id-secret",
        accountId: "provider-account",
      },
    });
    expect(JSON.parse(readFileSync(authPath, "utf8"))).toEqual({
      version: 1,
      provider: "local",
      createdAt,
      identity: { accountId: "local-user" },
    });
    expect(existsSync(byokPath)).toBe(false);
    expect(existsSync(providerCodePath)).toBe(false);
    const journal = readFileSync(applied.journalPath, "utf8");
    for (const secret of [
      "local-login-secret",
      "must-not-survive",
      "grok-secret",
      "provider-access-secret",
      "provider-id-secret",
    ]) {
      expect(journal).not.toContain(secret);
    }

    await rollbackConfigV2Migration("all-retired-auth", { env: {}, home });
    expect(existsSync(byokPath)).toBe(false);
    expect(existsSync(providerCodePath)).toBe(false);
    expect(JSON.stringify(native.data)).toContain("provider-access-secret");
    expect(JSON.stringify(native.data)).toContain("local-login-secret");
  });

  test("verifies combined native and retired-auth leaves under one top-level namespace", async () => {
    const root = temp();
    const home = join(root, "relocated-home");
    const remoteDirectory = join(root, ".agenc", "remote");
    const oauthPath = join(remoteDirectory, ".oauth_token");
    mkdirSync(home, { recursive: true });
    mkdirSync(remoteDirectory, { recursive: true });
    writeFileSync(oauthPath, "retired-oauth-token\n", { mode: 0o600 });
    const env = { AGENC_HOME: home };
    const homeContext = resolveMigrationHomeContext(env, { platformHome: root });
    const retiredIdentity = getRetiredSecureStorageIdentity(env, root);
    const retiredStorage = openMigrationStorage(homeContext, retiredIdentity);
    retiredStorage.update({
      remoteRuntimeAuth: { apiKey: "retired-api-key" },
    });

    const plan = await checkConfigV2Migration({
      ...options(home, "combined-native-retired-auth"),
      platformHome: root,
    });
    await applyConfigV2Migration(plan);

    expect(native.data.remoteRuntimeAuth).toEqual({
      apiKey: "retired-api-key",
      oauthToken: "retired-oauth-token",
    });
    expect(existsSync(oauthPath)).toBe(false);
  });

  test("commits retired gateway credentials before deleting plaintext and never recreates them", async () => {
    const root = temp();
    const home = join(root, "home");
    const gatewayDirectory = join(home, "gateway");
    const envPath = join(gatewayDirectory, "env");
    const hooksPath = join(gatewayDirectory, "hooks-token");
    const webchatPath = join(gatewayDirectory, "webchat-token");
    mkdirSync(gatewayDirectory, { recursive: true });
    writeFileSync(
      envPath,
      [
        "AGENC_DISCORD_BOT_TOKEN=discord-plaintext-secret",
        "AGENC_GATEWAY_HOOKS_TOKEN=hooks-override-secret",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    writeFileSync(hooksPath, "generated-hooks-plaintext", { mode: 0o600 });
    writeFileSync(webchatPath, "generated-webchat-plaintext", { mode: 0o600 });
    native.data = { trustedDeviceToken: "unrelated" };

    const plan = await checkConfigV2Migration(options(home, "gateway-retired-auth"));
    expect(plan.conflicts).toEqual([]);
    expect(plan.retiredAuthMigration?.descriptor.fileActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "delete", path: envPath }),
        expect.objectContaining({ kind: "delete", path: hooksPath }),
        expect.objectContaining({ kind: "delete", path: webchatPath }),
      ]),
    );
    let sourcesPresentAtVaultCommit = false;
    native.afterUpdate = () => {
      sourcesPresentAtVaultCommit = [envPath, hooksPath, webchatPath].every(
        existsSync,
      );
    };

    const applied = await applyConfigV2Migration(plan);

    expect(sourcesPresentAtVaultCommit).toBe(true);
    expect(native.data).toEqual({
      trustedDeviceToken: "unrelated",
      gateway: {
        environment: {
          AGENC_DISCORD_BOT_TOKEN: "discord-plaintext-secret",
          AGENC_HOOKS_TOKEN: "hooks-override-secret",
        },
        generatedTokens: {
          hooks: "generated-hooks-plaintext",
          webchat: "generated-webchat-plaintext",
        },
      },
    });
    for (const source of [envPath, hooksPath, webchatPath]) {
      expect(existsSync(source)).toBe(false);
      expect(existsSync(`${source}.migrated-v2-gateway-retired-auth`)).toBe(false);
    }
    expect(applied.archives).toBe(0);
    const journal = readFileSync(applied.journalPath, "utf8");
    for (const secret of [
      "discord-plaintext-secret",
      "hooks-override-secret",
      "generated-hooks-plaintext",
      "generated-webchat-plaintext",
    ]) {
      expect(journal).not.toContain(secret);
    }

    await rollbackConfigV2Migration("gateway-retired-auth", { env: {}, home });
    for (const source of [envPath, hooksPath, webchatPath]) {
      expect(existsSync(source)).toBe(false);
    }
    expect(native.data.gateway).toBeDefined();
  });

  test("leaves plaintext bytes untouched when the native secure storage is unavailable", async () => {
    const root = temp();
    const home = join(root, "home");
    const source = join(home, ".credentials.json");
    const legacy = JSON.stringify({ primaryApiKey: "secret-key" });
    mkdirSync(home, { recursive: true });
    writeFileSync(source, legacy, { mode: 0o600 });
    native.unavailable = true;

    const plan = await checkConfigV2Migration(options(home, "credential-unavailable"));
    await expect(applyConfigV2Migration(plan)).rejects.toThrow(
      /Native secure storage is unavailable/u,
    );
    expect(readFileSync(source, "utf8")).toBe(legacy);
    expect(native.data).toEqual({});
  });

  test("compensates the vault when a later migration step fails before plaintext deletion", async () => {
    const root = temp();
    const home = join(root, "home");
    const source = join(home, ".credentials.json");
    const config = join(home, "config.toml");
    const legacy = JSON.stringify({ primaryApiKey: "secret-key" });
    mkdirSync(home, { recursive: true });
    writeFileSync(source, legacy, { mode: 0o600 });
    writeFileSync(config, 'configVersion = 1\nmodel = "planned"\n', { mode: 0o600 });
    native.data = { trustedDeviceToken: "unrelated" };

    const plan = await checkConfigV2Migration(options(home, "credential-compensation"));
    expect(plan.writes.some(write => write.targetPath === config)).toBe(true);
    native.afterUpdate = () => {
      native.data = {
        ...native.data,
        pluginSecrets: { concurrent: { token: "preserve-me" } },
      };
      writeFileSync(config, 'configVersion = 1\nmodel = "foreign"\n', { mode: 0o600 });
    };

    await expect(applyConfigV2Migration(plan)).rejects.toThrow(/rollback|changed outside/u);
    expect(readFileSync(source, "utf8")).toBe(legacy);
    expect(native.data).toEqual({
      trustedDeviceToken: "unrelated",
      pluginSecrets: { concurrent: { token: "preserve-me" } },
    });
    expect(existsSync(`${source}.migrated-v2-credential-compensation`)).toBe(false);
  });

  test("refuses to replace a same-content target whose inode changed after preparation", async () => {
    const root = temp();
    const home = join(root, "home");
    const credentialSource = join(home, ".credentials.json");
    const config = join(home, "config.toml");
    const credentialBytes = JSON.stringify({ primaryApiKey: "secret-key" });
    const configBytes = 'configVersion = 1\nmodel = "planned"\n';
    mkdirSync(home, { recursive: true });
    writeFileSync(credentialSource, credentialBytes, { mode: 0o600 });
    writeFileSync(config, configBytes, { mode: 0o600 });
    native.data = { trustedDeviceToken: "unrelated" };

    const plan = await checkConfigV2Migration(options(home, "same-content-target-swap"));
    native.afterUpdate = () => {
      renameSync(config, `${config}.before-swap`);
      writeFileSync(config, configBytes, { mode: 0o600 });
    };

    await expect(applyConfigV2Migration(plan)).rejects.toThrow(
      /changed identity or content/u,
    );
    expect(readFileSync(config, "utf8")).toBe(configBytes);
    expect(readFileSync(credentialSource, "utf8")).toBe(credentialBytes);
    expect(native.data).toEqual({ trustedDeviceToken: "unrelated" });
  });

  test("refuses to delete a same-content credential source whose inode changed", async () => {
    const root = temp();
    const home = join(root, "home");
    const source = join(home, ".credentials.json");
    const legacy = JSON.stringify({ primaryApiKey: "secret-key" });
    mkdirSync(home, { recursive: true });
    writeFileSync(source, legacy, { mode: 0o600 });
    native.data = { trustedDeviceToken: "unrelated" };

    const plan = await checkConfigV2Migration(options(home, "same-content-secret-swap"));
    native.afterUpdate = () => {
      renameSync(source, `${source}.before-swap`);
      writeFileSync(source, legacy, { mode: 0o600 });
    };

    await expect(applyConfigV2Migration(plan)).rejects.toThrow(
      /changed identity or content/u,
    );
    expect(readFileSync(source, "utf8")).toBe(legacy);
    expect(native.data).toEqual({
      trustedDeviceToken: "unrelated",
      primaryApiKey: "secret-key",
    });
  });

  test("does not overwrite an archive path that appears during apply", async () => {
    const root = temp();
    const home = join(root, "home");
    const credentialSource = join(home, ".credentials.json");
    const settingsSource = join(home, "settings.json");
    const credentialBytes = JSON.stringify({ primaryApiKey: "secret-key" });
    const settingsBytes = JSON.stringify({ spinnerTipsEnabled: false });
    mkdirSync(home, { recursive: true });
    writeFileSync(credentialSource, credentialBytes, { mode: 0o600 });
    writeFileSync(settingsSource, settingsBytes, { mode: 0o600 });
    native.data = { trustedDeviceToken: "unrelated" };

    const id = "late-archive-destination";
    const archivePath = `${settingsSource}.migrated-v2-${id}`;
    const plan = await checkConfigV2Migration(options(home, id));
    expect(plan.archivePaths).toContain(settingsSource);
    native.afterUpdate = () => {
      writeFileSync(archivePath, "foreign archive bytes\n", { mode: 0o600 });
    };

    await expect(applyConfigV2Migration(plan)).rejects.toThrow(
      /refuses to overwrite a path that appeared/u,
    );
    expect(readFileSync(archivePath, "utf8")).toBe("foreign archive bytes\n");
    expect(readFileSync(settingsSource, "utf8")).toBe(settingsBytes);
    expect(readFileSync(credentialSource, "utf8")).toBe(credentialBytes);
    expect(native.data).toEqual({ trustedDeviceToken: "unrelated" });
  });

  test("binds check and apply to the explicit migration home, never ambient AGENC_HOME", async () => {
    const root = temp();
    const homeA = join(root, "home-a");
    const homeB = join(root, "home-b");
    mkdirSync(homeA, { recursive: true });
    mkdirSync(homeB, { recursive: true });
    writeFileSync(
      join(homeB, ".credentials.json"),
      JSON.stringify({ primaryApiKey: "secret-b" }),
      { mode: 0o600 },
    );
    native.dataByHome.set(homeA, { primaryApiKey: "secret-a" });
    native.dataByHome.set(homeB, { trustedDeviceToken: "device-b" });
    const previousAmbientHome = process.env.AGENC_HOME;
    process.env.AGENC_HOME = homeA;
    try {
      const plan = await checkConfigV2Migration(options(homeB, "credential-home-b"));
      await applyConfigV2Migration(plan);

      expect(native.homePaths.length).toBeGreaterThan(0);
      expect(native.homePaths.every(path => path === plan.home.path)).toBe(true);
      expect(native.dataByHome.get(homeA)).toEqual({ primaryApiKey: "secret-a" });
      expect(native.dataByHome.get(homeB)).toEqual({
        trustedDeviceToken: "device-b",
        primaryApiKey: "secret-b",
      });
    } finally {
      if (previousAmbientHome === undefined) delete process.env.AGENC_HOME;
      else process.env.AGENC_HOME = previousAmbientHome;
    }
  });

  test("reports a native secure storage conflict during check and plans zero writes", async () => {
    const root = temp();
    const home = join(root, "home");
    const source = join(home, ".credentials.json");
    const legacy = JSON.stringify({ primaryApiKey: "legacy-key" });
    mkdirSync(home, { recursive: true });
    writeFileSync(source, legacy, { mode: 0o600 });
    native.data = { primaryApiKey: "current-key" };

    const plan = await checkConfigV2Migration(options(home, "credential-conflict"));
    expect(plan.conflicts).toContainEqual(expect.objectContaining({
      field: "credentials",
      reason: expect.stringMatching(/conflicts.*primaryApiKey/u),
    }));
    expect(plan.writes).toEqual([]);
    expect(readFileSync(source, "utf8")).toBe(legacy);
    expect(native.data).toEqual({ primaryApiKey: "current-key" });
  });
});
