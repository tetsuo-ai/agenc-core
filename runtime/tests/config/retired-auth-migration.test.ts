import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { resolveHomeContext } from "../../src/config/home.js";
import {
  applyRetiredAuthSecureStorageMutation,
  assertRetiredAuthSecureStorageMutationCommitted,
  discoverRetiredAuthMigration,
  rollbackRetiredAuthSecureStorageMutation,
  RetiredAuthSecureStorageConflictError,
  type RetiredAuthMigrationDiscovery,
  type RetiredAuthMigrationEnvironment,
} from "../../src/config/retired-auth-migration.js";
import type { SecureStorageData } from "../../src/utils/secureStorage/index.js";

const CREATED_AT = "2026-08-24T00:00:00.000Z";
const roots: string[] = [];

afterEach(async () => {
  delete process.env.AGENC_HOME;
  await Promise.all(
    roots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true })
    ),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "agenc-retired-auth-"));
  roots.push(root);
  const platformHome = join(root, "platform-home");
  const homePath = join(root, "agenc-home");
  await Promise.all([
    mkdir(platformHome, { recursive: true }),
    mkdir(homePath, { recursive: true }),
  ]);
  const home = resolveHomeContext(
    { AGENC_HOME: homePath },
    { platformHome },
  );
  return { root, platformHome, home };
}

async function discover(options: {
  readonly env?: RetiredAuthMigrationEnvironment;
  readonly currentSecureStorage?: Readonly<SecureStorageData>;
}) {
  const context = await fixture();
  const discovery = await discoverRetiredAuthMigration({
    home: context.home,
    platformHome: context.platformHome,
    env: options.env,
    currentSecureStorage: options.currentSecureStorage ?? {},
  });
  return { ...context, discovery };
}

describe("retired auth credential migration discovery", () => {
  test("moves the retired native OpenAI record into the sole canonical field", async () => {
    const current = {
      trustedDeviceToken: "keep-unrelated",
      agenc: {
        apiKey: "platform-secret",
        accessToken: "oauth-secret",
        refreshToken: "refresh-secret",
        accountId: "acct-openai",
        profileId: "discarded-profile-link",
      },
    } as SecureStorageData & {
      agenc: {
        apiKey: string;
        accessToken: string;
        refreshToken: string;
        accountId: string;
        profileId: string;
      };
    };
    const { discovery } = await discover({ currentSecureStorage: current });

    expect(discovery.descriptor.conflicts).toEqual([]);
    expect(discovery.descriptor.vaultFields).toEqual(["agenc", "openAiOauth"]);
    const applied = appliedVault(discovery, current);
    expect(applied).toMatchObject({
      trustedDeviceToken: "keep-unrelated",
      openAiOauth: {
        apiKey: "platform-secret",
        accessToken: "oauth-secret",
        refreshToken: "refresh-secret",
        accountId: "acct-openai",
        authMode: "apiKey",
      },
    });
    expect((applied as Record<string, unknown>).agenc).toBeUndefined();
    expect(applied.openAiOauth).not.toHaveProperty("profileId");
    assertRetiredAuthSecureStorageMutationCommitted(applied, discovery.mutation!);
    expect(rollbackRetiredAuthSecureStorageMutation(
      applied,
      discovery.mutation!,
    )).toEqual(current);
    expectSecretFreeDescriptor(discovery.descriptor, [
      "platform-secret",
      "oauth-secret",
      "refresh-secret",
      "keep-unrelated",
    ]);
  });

  test("composes retired native and ProviderCode OpenAI credentials into one vault write", async () => {
    const context = await fixture();
    const providerPath = join(context.root, "provider-auth.json");
    await writeJson(providerPath, {
      openai_api_key: "platform-secret",
      access_token: "oauth-secret",
      refresh_token: "provider-refresh-secret",
      account_id: "acct-openai",
    });
    const current = {
      trustedDeviceToken: "keep-unrelated",
      agenc: {
        apiKey: "platform-secret",
        accessToken: "oauth-secret",
        accountId: "acct-openai",
        profileId: "discarded-profile-link",
      },
    } as SecureStorageData & {
      agenc: {
        apiKey: string;
        accessToken: string;
        accountId: string;
        profileId: string;
      };
    };
    const discovery = await discoverRetiredAuthMigration({
      home: context.home,
      platformHome: context.platformHome,
      env: { PROVIDER_CODE_AUTH_JSON_PATH: providerPath },
      currentSecureStorage: current,
    });

    expect(discovery.descriptor.conflicts).toEqual([]);
    expect(discovery.descriptor.vaultFields).toEqual([
      "agenc",
      "openAiOauth",
    ]);
    expect(discovery.mutation?.vaultWrites.map(write => write.path)).toEqual([
      ["agenc"],
      ["openAiOauth"],
    ]);

    const applied = appliedVault(discovery, current);
    expect(applied).toMatchObject({
      trustedDeviceToken: "keep-unrelated",
      openAiOauth: {
        apiKey: "platform-secret",
        authMode: "apiKey",
        accessToken: "oauth-secret",
        refreshToken: "provider-refresh-secret",
        accountId: "acct-openai",
      },
    });
    expect((applied as Record<string, unknown>).agenc).toBeUndefined();
    assertRetiredAuthSecureStorageMutationCommitted(applied, discovery.mutation!);
    expect(rollbackRetiredAuthSecureStorageMutation(
      applied,
      discovery.mutation!,
    )).toEqual(current);
    expectSecretFreeDescriptor(discovery.descriptor, [
      "platform-secret",
      "oauth-secret",
      "provider-refresh-secret",
      "keep-unrelated",
    ]);
  });

  test("refuses to delete a retired native OpenAI record that conflicts", async () => {
    const current = {
      agenc: {
        apiKey: "retired-platform-secret",
        accessToken: "oauth-secret",
      },
      openAiOauth: {
        apiKey: "canonical-platform-secret",
        authMode: "apiKey" as const,
      },
    } as SecureStorageData & {
      agenc: { apiKey: string; accessToken: string };
    };
    const { discovery } = await discover({ currentSecureStorage: current });

    expect(discovery.mutation).toBeUndefined();
    expect(discovery.descriptor.conflicts).toContainEqual(
      expect.objectContaining({
        kind: "retired-native-openai-oauth",
        field: "openAiOauth.apiKey",
      }),
    );
    expectSecretFreeDescriptor(discovery.descriptor, [
      "retired-platform-secret",
      "canonical-platform-secret",
      "oauth-secret",
    ]);
  });

  test("rejects duplicate credential JSON keys without retaining secret values", async () => {
    const context = await fixture();
    await writeFile(
      context.home.authPath,
      `{"version":1,"token":"first-secret","token":"second-secret","createdAt":"${CREATED_AT}","provider":"local"}\n`,
      { mode: 0o600 },
    );

    const discovery = await discoverRetiredAuthMigration({
      home: context.home,
      platformHome: context.platformHome,
      env: {},
      currentSecureStorage: {},
    });

    expect(discovery.mutation).toBeUndefined();
    expect(discovery.descriptor.conflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: expect.stringMatching(/duplicate object keys/u) }),
    ]));
    expect(JSON.stringify(discovery.descriptor)).not.toContain("first-secret");
    expect(JSON.stringify(discovery.descriptor)).not.toContain("second-secret");
  });

  test("plans local login and BYOK import with a metadata-only auth rewrite", async () => {
    const context = await fixture();
    await writeJson(context.home.authPath, {
      version: 1,
      token: "local-login-secret",
      createdAt: CREATED_AT,
      provider: "local",
      identity: {
        accountId: "local",
        displayName: "Local AgenC user",
        plan: "free",
      },
      byokKeys: {
        grok: byok("grok", "xai-secret"),
      },
      refreshToken: "unknown-plaintext-secret",
    });
    const byokPath = join(context.home.path, "byok-keys.json");
    await writeJson(byokPath, {
      version: 1,
      byokKeys: {
        openrouter: byok("openrouter", "openrouter-secret"),
      },
    });

    const discovery = await discoverRetiredAuthMigration({
      home: context.home,
      platformHome: context.platformHome,
      currentSecureStorage: { trustedDeviceToken: "unrelated-native-secret" },
    });

    expect(discovery.descriptor.conflicts).toEqual([]);
    expect(appliedVault(discovery, {
      trustedDeviceToken: "unrelated-native-secret",
    })).toMatchObject({
      trustedDeviceToken: "unrelated-native-secret",
      localAuth: {
        login: {
          token: "local-login-secret",
          createdAt: CREATED_AT,
        },
        byokKeys: {
          grok: byok("grok", "xai-secret"),
          openrouter: byok("openrouter", "openrouter-secret"),
        },
      },
    });
    expect(discovery.descriptor.vaultFields).toEqual([
      'localAuth.byokKeys["grok"]',
      'localAuth.byokKeys["openrouter"]',
      "localAuth.login",
    ]);

    const rewrite = discovery.mutation?.fileActions.find(
      (action) => action.path === context.home.authPath,
    );
    expect(rewrite?.kind).toBe("rewrite");
    expect(rewrite?.content).not.toContain("local-login-secret");
    expect(rewrite?.content).not.toContain("xai-secret");
    expect(rewrite?.content).not.toContain("unknown-plaintext-secret");
    expect(JSON.parse(rewrite?.content ?? "{}")).toEqual({
      version: 1,
      createdAt: CREATED_AT,
      provider: "local",
      identity: {
        accountId: "local",
        displayName: "Local AgenC user",
        plan: "free",
      },
    });
    expect(
      discovery.mutation?.fileActions.find((action) => action.path === byokPath),
    ).toMatchObject({ kind: "delete" });
    expectSecretFreeDescriptor(discovery.descriptor, [
      "local-login-secret",
      "xai-secret",
      "openrouter-secret",
      "unknown-plaintext-secret",
      "unrelated-native-secret",
    ]);
  });

  test("imports remote bearer, remote runtime files, and ProviderCode OAuth", async () => {
    const context = await fixture();
    await writeJson(context.home.authPath, {
      version: 1,
      provider: "remote",
      token: "remote-bearer-secret",
      createdAt: CREATED_AT,
      identity: { accountId: "acct-remote", email: "user@example.com" },
      subscriptionTier: "team",
    });
    const remoteDir = join(context.platformHome, ".agenc", "remote");
    await mkdir(remoteDir, { recursive: true });
    await Promise.all([
      writeFile(join(remoteDir, ".oauth_token"), " oauth-secret \n"),
      writeFile(join(remoteDir, ".api_key"), " api-secret \n"),
      writeFile(
        join(remoteDir, ".session_ingress_token"),
        " session-secret \n",
      ),
    ]);
    const providerPath = join(
      context.platformHome,
      ".providerCode",
      "auth.json",
    );
    await writeJson(providerPath, {
      tokens: {
        access_token: "provider-bearer-secret",
        id_token: "provider-id-secret",
        account_id: "acct-provider",
      },
    });

    const discovery = await discoverRetiredAuthMigration({
      home: context.home,
      platformHome: context.platformHome,
      currentSecureStorage: {},
    });

    expect(discovery.descriptor.conflicts).toEqual([]);
    expect(appliedVault(discovery)).toMatchObject({
      remoteAuth: {
        bearerToken: "remote-bearer-secret",
        createdAt: CREATED_AT,
      },
      remoteRuntimeAuth: {
        oauthToken: "oauth-secret",
        apiKey: "api-secret",
        sessionIngressToken: "session-secret",
      },
      openAiOauth: {
        authMode: "chatgpt",
        accessToken: "provider-bearer-secret",
        idToken: "provider-id-secret",
        accountId: "acct-provider",
      },
    });
    expect(discovery.mutation?.fileActions).toHaveLength(5);
    expect(
      discovery.mutation?.fileActions.filter((action) => action.kind === "delete"),
    ).toHaveLength(4);
    expectSecretFreeDescriptor(discovery.descriptor, [
      "remote-bearer-secret",
      "oauth-secret",
      "api-secret",
      "session-secret",
      "provider-bearer-secret",
      "provider-id-secret",
    ]);
  });

  test("moves every retired gateway credential source into leaf-level native fields", async () => {
    const context = await fixture();
    const gatewayDirectory = join(context.home.path, "gateway");
    const envPath = join(gatewayDirectory, "env");
    const hooksPath = join(gatewayDirectory, "hooks-token");
    const webchatPath = join(gatewayDirectory, "webchat-token");
    await mkdir(gatewayDirectory, { recursive: true });
    await Promise.all([
      writeFile(envPath, [
        "# Retired gateway credentials",
        "AGENC_GATEWAY_HELIUS_API_KEY=helius-secret=with-equals",
        "AGENC_TELEGRAM_BOT_TOKEN=telegram-secret",
        "AGENC_TELEGRAM_OWNER_CLAIM_CODE=owner-claim-code",
        "AGENC_WEBCHAT_TOKEN=explicit-webchat-secret",
        "AGENC_DISCORD_BOT_TOKEN=discord-secret",
        "AGENC_SLACK_BOT_TOKEN=slack-bot-secret",
        "AGENC_SLACK_APP_TOKEN=slack-app-secret",
        "AGENC_GATEWAY_HOOKS_TOKEN=retired-hooks-secret",
        "",
      ].join("\r\n"), { mode: 0o600 }),
      writeFile(hooksPath, "generated-hooks-secret\n", { mode: 0o600 }),
      writeFile(webchatPath, "generated-webchat-secret", { mode: 0o600 }),
    ]);

    const discovery = await discoverRetiredAuthMigration({
      home: context.home,
      platformHome: context.platformHome,
      currentSecureStorage: { trustedDeviceToken: "unrelated-native-secret" },
    });

    expect(discovery.descriptor.conflicts).toEqual([]);
    expect(appliedVault(discovery, {
      trustedDeviceToken: "unrelated-native-secret",
    })).toEqual({
      trustedDeviceToken: "unrelated-native-secret",
      gateway: {
        environment: {
          AGENC_GATEWAY_HELIUS_API_KEY: "helius-secret=with-equals",
          AGENC_TELEGRAM_BOT_TOKEN: "telegram-secret",
          AGENC_TELEGRAM_OWNER_CLAIM_CODE: "owner-claim-code",
          AGENC_WEBCHAT_TOKEN: "explicit-webchat-secret",
          AGENC_DISCORD_BOT_TOKEN: "discord-secret",
          AGENC_SLACK_BOT_TOKEN: "slack-bot-secret",
          AGENC_SLACK_APP_TOKEN: "slack-app-secret",
          AGENC_HOOKS_TOKEN: "retired-hooks-secret",
        },
        generatedTokens: {
          hooks: "generated-hooks-secret",
          webchat: "generated-webchat-secret",
        },
      },
    });
    expect(discovery.descriptor.inputs.map(({ kind }) => kind)).toEqual(
      expect.arrayContaining([
        "gateway-env",
        "gateway-hooks-token",
        "gateway-webchat-token",
      ]),
    );
    expect(discovery.mutation?.fileActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "delete", path: envPath }),
        expect.objectContaining({ kind: "delete", path: hooksPath }),
        expect.objectContaining({ kind: "delete", path: webchatPath }),
      ]),
    );
    expect(discovery.mutation?.fileActions.every(
      (action) => action.kind === "delete" && action.content === undefined,
    )).toBe(true);
    expect(discovery.descriptor.vaultFields).toContain(
      'gateway.environment["AGENC_HOOKS_TOKEN"]',
    );
    expect(discovery.descriptor.vaultFields).not.toContain(
      'gateway.environment["AGENC_GATEWAY_HOOKS_TOKEN"]',
    );
    expectSecretFreeDescriptor(discovery.descriptor, [
      "helius-secret=with-equals",
      "telegram-secret",
      "owner-claim-code",
      "explicit-webchat-secret",
      "discord-secret",
      "slack-bot-secret",
      "slack-app-secret",
      "retired-hooks-secret",
      "generated-hooks-secret",
      "generated-webchat-secret",
      "unrelated-native-secret",
    ]);
  });

  test.each([
    {
      name: "a malformed line",
      body: "NOT_AN_ASSIGNMENT\n",
      field: undefined,
      reason: /malformed/u,
    },
    {
      name: "an unknown non-secret setting",
      body: "AGENC_GATEWAY_PORT=18790\n",
      field: "AGENC_GATEWAY_PORT",
      reason: /unsupported non-secret or unknown/u,
    },
    {
      name: "a duplicate key",
      body: [
        "AGENC_TELEGRAM_BOT_TOKEN=telegram-secret-a",
        "AGENC_TELEGRAM_BOT_TOKEN=telegram-secret-b",
        "",
      ].join("\n"),
      field: "AGENC_TELEGRAM_BOT_TOKEN",
      reason: /duplicate/u,
    },
    {
      name: "an empty value",
      body: "AGENC_DISCORD_BOT_TOKEN=   \n",
      field: "AGENC_DISCORD_BOT_TOKEN",
      reason: /empty/u,
    },
    {
      name: "disagreeing hooks aliases",
      body: [
        "AGENC_HOOKS_TOKEN=canonical-hooks-secret",
        "AGENC_GATEWAY_HOOKS_TOKEN=different-hooks-secret",
        "",
      ].join("\n"),
      field: "AGENC_HOOKS_TOKEN",
      reason: /refuses to assign precedence/u,
    },
    {
      name: "a short hooks override",
      body: "AGENC_HOOKS_TOKEN=short\n",
      field: "AGENC_HOOKS_TOKEN",
      reason: /shorter than 16/u,
    },
    {
      name: "a short webchat override",
      body: "AGENC_WEBCHAT_TOKEN=short\n",
      field: "AGENC_WEBCHAT_TOKEN",
      reason: /shorter than 16/u,
    },
  ])("rejects gateway/env containing $name", async ({ body, field, reason }) => {
    const context = await fixture();
    const envPath = join(context.home.path, "gateway", "env");
    await mkdir(join(envPath, ".."), { recursive: true });
    await writeFile(envPath, body, { mode: 0o600 });

    const discovery = await discoverRetiredAuthMigration({
      home: context.home,
      platformHome: context.platformHome,
      currentSecureStorage: {},
    });

    expect(discovery.mutation).toBeUndefined();
    expect(discovery.descriptor.fileActions).toEqual([]);
    expect(discovery.descriptor.conflicts).toContainEqual(
      expect.objectContaining({
        kind: "gateway-env",
        path: envPath,
        ...(field !== undefined ? { field } : {}),
        reason: expect.stringMatching(reason),
      }),
    );
    expectSecretFreeDescriptor(discovery.descriptor, [body]);
    expect(await readFile(envPath, "utf8")).toBe(body);
  });

  test("rejects non-UTF-8 gateway/env bytes instead of lossy decoding", async () => {
    const context = await fixture();
    const envPath = join(context.home.path, "gateway", "env");
    const bytes = Buffer.concat([
      Buffer.from("AGENC_DISCORD_BOT_TOKEN=discord-secret-"),
      Buffer.from([0xff]),
      Buffer.from("\n"),
    ]);
    await mkdir(join(envPath, ".."), { recursive: true });
    await writeFile(envPath, bytes, { mode: 0o600 });

    const discovery = await discoverRetiredAuthMigration({
      home: context.home,
      platformHome: context.platformHome,
      currentSecureStorage: {},
    });

    expect(discovery.mutation).toBeUndefined();
    expect(discovery.descriptor.conflicts).toContainEqual(
      expect.objectContaining({
        kind: "gateway-env",
        path: envPath,
        reason: expect.stringMatching(/not valid UTF-8/u),
      }),
    );
    expect(await readFile(envPath)).toEqual(bytes);
  });

  test.each([
    ["hooks-token", "gateway-hooks-token", "gateway.generatedTokens.hooks"],
    ["webchat-token", "gateway-webchat-token", "gateway.generatedTokens.webchat"],
  ] as const)(
    "rejects a short retired gateway %s",
    async (fileName, kind, field) => {
      const context = await fixture();
      const sourcePath = join(context.home.path, "gateway", fileName);
      await mkdir(join(sourcePath, ".."), { recursive: true });
      await writeFile(sourcePath, "too-short", { mode: 0o600 });

      const discovery = await discoverRetiredAuthMigration({
        home: context.home,
        platformHome: context.platformHome,
        currentSecureStorage: {},
      });

      expect(discovery.mutation).toBeUndefined();
      expect(discovery.descriptor.conflicts).toContainEqual(
        expect.objectContaining({ kind, path: sourcePath, field }),
      );
      expect(discovery.descriptor.fileActions).toEqual([]);
      expectSecretFreeDescriptor(discovery.descriptor, ["too-short"]);
    },
  );

  test("rejects gateway source disagreement with native secure storage", async () => {
    const context = await fixture();
    const gatewayDirectory = join(context.home.path, "gateway");
    await mkdir(gatewayDirectory, { recursive: true });
    await Promise.all([
      writeFile(
        join(gatewayDirectory, "env"),
        "AGENC_TELEGRAM_BOT_TOKEN=plaintext-telegram-secret\n",
        { mode: 0o600 },
      ),
      writeFile(
        join(gatewayDirectory, "hooks-token"),
        "plaintext-hooks-secret",
        { mode: 0o600 },
      ),
    ]);

    const discovery = await discoverRetiredAuthMigration({
      home: context.home,
      platformHome: context.platformHome,
      currentSecureStorage: {
        gateway: {
          environment: {
            AGENC_TELEGRAM_BOT_TOKEN: "native-telegram-secret",
          },
          generatedTokens: { hooks: "native-hooks-secret" },
        },
      },
    });

    expect(discovery.mutation).toBeUndefined();
    expect(discovery.descriptor.conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'gateway.environment["AGENC_TELEGRAM_BOT_TOKEN"]',
        }),
        expect.objectContaining({ field: "gateway.generatedTokens.hooks" }),
      ]),
    );
    expectSecretFreeDescriptor(discovery.descriptor, [
      "plaintext-telegram-secret",
      "plaintext-hooks-secret",
      "native-telegram-secret",
      "native-hooks-secret",
    ]);
  });

  test("applies and compensates gateway leaves without clobbering concurrent namespaces", async () => {
    const context = await fixture();
    const gatewayDirectory = join(context.home.path, "gateway");
    await mkdir(gatewayDirectory, { recursive: true });
    await Promise.all([
      writeFile(
        join(gatewayDirectory, "env"),
        "AGENC_DISCORD_BOT_TOKEN=discord-migration-secret\n",
        { mode: 0o600 },
      ),
      writeFile(
        join(gatewayDirectory, "hooks-token"),
        "generated-hooks-migration-secret",
        { mode: 0o600 },
      ),
    ]);
    const discovery = await discoverRetiredAuthMigration({
      home: context.home,
      platformHome: context.platformHome,
      currentSecureStorage: {},
    });
    expect(discovery.mutation).toBeDefined();

    const applied = applyRetiredAuthSecureStorageMutation(
      {
        gateway: {
          generatedTokens: { webchat: "concurrent-webchat-token" },
        },
      },
      discovery.mutation!,
    );
    const rolledBack = rollbackRetiredAuthSecureStorageMutation(
      {
        ...applied,
        pluginSecrets: { concurrent: { token: "preserve-me" } },
      },
      discovery.mutation!,
    );
    expect(rolledBack).toEqual({
      gateway: {
        generatedTokens: { webchat: "concurrent-webchat-token" },
      },
      pluginSecrets: { concurrent: { token: "preserve-me" } },
    });

    expect(() => applyRetiredAuthSecureStorageMutation(
      {
        gateway: {
          environment: {
            AGENC_DISCORD_BOT_TOKEN: "changed-before-apply",
          },
        },
      },
      discovery.mutation!,
    )).toThrowError(RetiredAuthSecureStorageConflictError);
    expect(() => rollbackRetiredAuthSecureStorageMutation(
      {
        ...applied,
        gateway: {
          ...applied.gateway,
          generatedTokens: {
            ...applied.gateway?.generatedTokens,
            hooks: "changed-after-apply",
          },
        },
      },
      discovery.mutation!,
    )).toThrowError(RetiredAuthSecureStorageConflictError);
  });

  test("refuses symlink gateway credential inputs without following them", async () => {
    const context = await fixture();
    const target = join(context.root, "outside-gateway-env");
    const envPath = join(context.home.path, "gateway", "env");
    await mkdir(join(envPath, ".."), { recursive: true });
    await writeFile(target, "AGENC_DISCORD_BOT_TOKEN=outside-secret\n");
    await symlink(target, envPath);

    const discovery = await discoverRetiredAuthMigration({
      home: context.home,
      platformHome: context.platformHome,
      currentSecureStorage: {},
    });

    expect(discovery.mutation).toBeUndefined();
    expect(discovery.descriptor.conflicts).toContainEqual(
      expect.objectContaining({
        kind: "gateway-env",
        path: envPath,
        reason: expect.stringMatching(/symbolic-link/u),
      }),
    );
    expect(await readFile(target, "utf8")).toContain("outside-secret");
    expectSecretFreeDescriptor(discovery.descriptor, ["outside-secret"]);
  });

  test("sanitizes an auth.json that contains only retired secret fields", async () => {
    const context = await fixture();
    await writeJson(context.home.authPath, {
      version: 1,
      provider: "local",
      createdAt: CREATED_AT,
      refreshToken: "orphaned-refresh-secret",
      password: "orphaned-password-secret",
    });

    const discovery = await discoverRetiredAuthMigration({
      home: context.home,
      platformHome: context.platformHome,
      currentSecureStorage: {},
    });

    expect(discovery.descriptor.conflicts).toEqual([]);
    expect(discovery.descriptor.vaultFields).toEqual([]);
    expect(discovery.mutation?.fileActions).toHaveLength(1);
    expect(JSON.parse(discovery.mutation?.fileActions[0]?.content ?? "{}")).toEqual({
      version: 1,
      provider: "local",
      createdAt: CREATED_AT,
    });
    expectSecretFreeDescriptor(discovery.descriptor, [
      "orphaned-refresh-secret",
      "orphaned-password-secret",
    ]);
  });

  test("reports native and cross-file conflicts and plans zero mutations", async () => {
    const context = await fixture();
    await writeJson(context.home.authPath, {
      version: 1,
      token: "retired-login-secret",
      createdAt: CREATED_AT,
      provider: "local",
      identity: {
        accountId: "local",
        displayName: "Local AgenC user",
        plan: "free",
      },
      byokKeys: {
        grok: byok("grok", "embedded-secret"),
      },
    });
    await writeJson(join(context.home.path, "byok-keys.json"), {
      version: 1,
      byokKeys: {
        grok: byok("grok", "separate-secret"),
      },
    });

    const discovery = await discoverRetiredAuthMigration({
      home: context.home,
      platformHome: context.platformHome,
      currentSecureStorage: {
        localAuth: {
          login: {
            token: "native-login-secret",
            createdAt: CREATED_AT,
          },
        },
      },
    });

    expect(discovery.mutation).toBeUndefined();
    expect(discovery.descriptor.conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "localAuth.login" }),
        expect.objectContaining({ field: 'localAuth.byokKeys["grok"]' }),
      ]),
    );
    expectSecretFreeDescriptor(discovery.descriptor, [
      "retired-login-secret",
      "native-login-secret",
      "embedded-secret",
      "separate-secret",
    ]);
  });

  test("preserves unrelated concurrent vault changes and rejects an imported-leaf race", async () => {
    const context = await fixture();
    await writeJson(context.home.authPath, {
      version: 1,
      token: "retired-login-secret",
      createdAt: CREATED_AT,
      provider: "local",
    });
    const discovery = await discoverRetiredAuthMigration({
      home: context.home,
      platformHome: context.platformHome,
      currentSecureStorage: {
        pluginSecrets: { alpha: { token: "plugin-before" } },
      },
    });

    const applied = appliedVault(discovery, {
      pluginSecrets: { alpha: { token: "plugin-after" } },
    });
    expect(applied.pluginSecrets).toEqual({
      alpha: { token: "plugin-after" },
    });
    expect(applied.localAuth?.login?.token).toBe("retired-login-secret");

    expect(() => appliedVault(discovery, {
      localAuth: {
        login: { token: "concurrent-login", createdAt: CREATED_AT },
      },
    })).toThrowError(RetiredAuthSecureStorageConflictError);
  });

  test("compensates imported leaves without reverting unrelated vault changes", async () => {
    const context = await fixture();
    await writeJson(context.home.authPath, {
      version: 1,
      token: "retired-login-secret",
      createdAt: CREATED_AT,
      provider: "local",
    });
    const discovery = await discoverRetiredAuthMigration({
      home: context.home,
      platformHome: context.platformHome,
      currentSecureStorage: { trustedDeviceToken: "before" },
    });
    expect(discovery.mutation).toBeDefined();
    const applied = applyRetiredAuthSecureStorageMutation(
      { trustedDeviceToken: "changed-concurrently" },
      discovery.mutation!,
    );

    const rolledBack = rollbackRetiredAuthSecureStorageMutation(
      {
        ...applied,
        pluginSecrets: { alpha: { token: "unrelated" } },
      },
      discovery.mutation!,
    );
    expect(rolledBack.localAuth).toBeUndefined();
    expect(rolledBack.trustedDeviceToken).toBe("changed-concurrently");
    expect(rolledBack.pluginSecrets).toEqual({
      alpha: { token: "unrelated" },
    });

    expect(() => rollbackRetiredAuthSecureStorageMutation(
      {
        ...applied,
        localAuth: {
          login: { token: "changed-after-apply", createdAt: CREATED_AT },
        },
      },
      discovery.mutation!,
    )).toThrowError(RetiredAuthSecureStorageConflictError);
  });

  test("explicit retired paths are migration-only authorities and ambient home cannot redirect them", async () => {
    const context = await fixture();
    const ambientHome = join(context.root, "ambient-home-a");
    const explicitRemote = join(context.root, "explicit-remote");
    const explicitIngress = join(context.root, "explicit-ingress-token");
    const explicitProvider = join(context.root, "explicit-provider-auth.json");
    process.env.AGENC_HOME = ambientHome;
    await mkdir(join(ambientHome, "remote"), { recursive: true });
    await mkdir(explicitRemote, { recursive: true });
    await Promise.all([
      writeFile(join(explicitRemote, ".oauth_token"), "explicit-oauth"),
      writeFile(join(explicitRemote, ".api_key"), "explicit-api"),
      writeFile(explicitIngress, "explicit-session"),
      writeJson(explicitProvider, {
        accessToken: "explicit-provider",
        accountId: "explicit-account",
      }),
    ]);

    const discovery = await discoverRetiredAuthMigration({
      home: context.home,
      platformHome: context.platformHome,
      env: {
        AGENC_REMOTE_TOKEN_DIR: explicitRemote,
        AGENC_SESSION_INGRESS_TOKEN_FILE: explicitIngress,
        PROVIDER_CODE_AUTH_JSON_PATH: explicitProvider,
      },
      currentSecureStorage: {},
    });

    expect(discovery.descriptor.conflicts).toEqual([]);
    expect(discovery.descriptor.inputs.map((input) => input.path)).toEqual(
      expect.arrayContaining([
        join(explicitRemote, ".oauth_token"),
        join(explicitRemote, ".api_key"),
        explicitIngress,
        explicitProvider,
      ]),
    );
    expect(discovery.descriptor.inputs.every(
      (input) => !input.path.startsWith(ambientHome),
    )).toBe(true);
    expect(appliedVault(discovery).remoteRuntimeAuth).toEqual({
      oauthToken: "explicit-oauth",
      apiKey: "explicit-api",
      sessionIngressToken: "explicit-session",
    });
  });

  test("rejects ambiguous/non-absolute path authorities and retired Windows PasswordVault", async () => {
    const { discovery } = await discover({
      env: {
        AGENC_REMOTE_TOKEN_DIR: "relative/remote",
        AGENC_SESSION_INGRESS_TOKEN_FILE: "relative/ingress",
        PROVIDER_CODE_AUTH_JSON_PATH: "/tmp/provider-a.json",
        PROVIDER_CODE_HOME: "/tmp/provider-b",
        AGENC_ENABLE_LEGACY_WINDOWS_PASSWORDVAULT: "1",
      },
    });

    expect(discovery.mutation).toBeUndefined();
    expect(discovery.descriptor.conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "AGENC_REMOTE_TOKEN_DIR" }),
        expect.objectContaining({
          field: "AGENC_SESSION_INGRESS_TOKEN_FILE",
        }),
        expect.objectContaining({ field: "ProviderCode credential path" }),
        expect.objectContaining({
          field: "AGENC_ENABLE_LEGACY_WINDOWS_PASSWORDVAULT",
        }),
      ]),
    );
  });

  test("refuses symlink credential inputs without following them", async () => {
    const context = await fixture();
    const target = join(context.root, "outside-secret");
    const byokPath = join(context.home.path, "byok-keys.json");
    await writeJson(target, { version: 1, byokKeys: {} });
    await symlink(target, byokPath);

    const discovery = await discoverRetiredAuthMigration({
      home: context.home,
      platformHome: context.platformHome,
      currentSecureStorage: {},
    });

    expect(discovery.mutation).toBeUndefined();
    expect(discovery.descriptor.conflicts).toContainEqual(
      expect.objectContaining({
        kind: "byok-json",
        path: byokPath,
        reason: expect.stringMatching(/symbolic-link/u),
      }),
    );
    expect(await readFile(target, "utf8")).toContain("byokKeys");
  });

  test("does not delete ProviderCode identity-only or unrecognized auth", async () => {
    const context = await fixture();
    const providerPath = join(context.root, "provider-id-only.json");
    await writeJson(providerPath, {
      id_token: "identity-secret-without-bearer",
      account_id: "acct-only",
    });

    const discovery = await discoverRetiredAuthMigration({
      home: context.home,
      platformHome: context.platformHome,
      env: { PROVIDER_CODE_AUTH_JSON_PATH: providerPath },
      currentSecureStorage: {},
    });

    expect(discovery.mutation).toBeUndefined();
    expect(discovery.descriptor.fileActions).toEqual([]);
    expect(discovery.descriptor.conflicts).toContainEqual(
      expect.objectContaining({
        kind: "provider-code-auth-json",
        field: "ProviderCode credential",
      }),
    );
    expectSecretFreeDescriptor(discovery.descriptor, [
      "identity-secret-without-bearer",
    ]);
  });

  test("keeps distinct ProviderCode API-key and OAuth token fields", async () => {
    const context = await fixture();
    const providerPath = join(context.root, "provider-ambiguous.json");
    await writeJson(providerPath, {
      openai_api_key: "provider-secret-a",
      access_token: "provider-secret-b",
    });

    const discovery = await discoverRetiredAuthMigration({
      home: context.home,
      platformHome: context.platformHome,
      env: {
        PROVIDER_CODE_AUTH_JSON_PATH: providerPath,
      },
      currentSecureStorage: {},
    });

    expect(discovery.descriptor.conflicts).toEqual([]);
    expect(appliedVault(discovery).openAiOauth).toMatchObject({
      apiKey: "provider-secret-a",
      accessToken: "provider-secret-b",
      authMode: "apiKey",
    });
    expectSecretFreeDescriptor(discovery.descriptor, [
      "provider-secret-a",
      "provider-secret-b",
    ]);
  });

  test("refuses conflicting ProviderCode account aliases", async () => {
    const context = await fixture();
    const providerPath = join(context.root, "provider-account-ambiguous.json");
    await writeJson(providerPath, {
      access_token: "provider-secret",
      account_id: "account-from-file",
    });

    const discovery = await discoverRetiredAuthMigration({
      home: context.home,
      platformHome: context.platformHome,
      env: {
        PROVIDER_CODE_AUTH_JSON_PATH: providerPath,
        PROVIDER_CODE_ACCOUNT_ID: "account-from-env",
      },
      currentSecureStorage: {},
    });

    expect(discovery.mutation).toBeUndefined();
    expect(discovery.descriptor.fileActions).toEqual([]);
    expect(discovery.descriptor.conflicts).toContainEqual(
      expect.objectContaining({ field: "ProviderCode account id" }),
    );
    expectSecretFreeDescriptor(discovery.descriptor, [
      "provider-secret",
      "account-from-file",
      "account-from-env",
    ]);
  });

  test.each([
    ["openai_api_key", { openai_api_key: "provider-secret" }],
    ["openaiApiKey", { openaiApiKey: "provider-secret" }],
  ])("parses ProviderCode API-key path %s", async (_name, authJson) => {
    const context = await fixture();
    const providerPath = join(context.root, "provider-auth.json");
    await writeJson(providerPath, authJson);

    const discovery = await discoverRetiredAuthMigration({
      home: context.home,
      platformHome: context.platformHome,
      env: { PROVIDER_CODE_AUTH_JSON_PATH: providerPath },
      currentSecureStorage: {},
    });

    expect(discovery.descriptor.conflicts).toEqual([]);
    expect(appliedVault(discovery).openAiOauth).toMatchObject({
      apiKey: "provider-secret",
      authMode: "apiKey",
    });
    expectSecretFreeDescriptor(discovery.descriptor, ["provider-secret"]);
  });

  test.each([
    ["access_token", { access_token: "provider-secret" }],
    ["accessToken", { accessToken: "provider-secret" }],
    ["tokens.access_token", { tokens: { access_token: "provider-secret" } }],
    ["tokens.accessToken", { tokens: { accessToken: "provider-secret" } }],
    ["auth.access_token", { auth: { access_token: "provider-secret" } }],
    ["auth.accessToken", { auth: { accessToken: "provider-secret" } }],
    ["token.access_token", { token: { access_token: "provider-secret" } }],
    ["token.accessToken", { token: { accessToken: "provider-secret" } }],
  ])("parses ProviderCode access-token path %s", async (_name, authJson) => {
    const context = await fixture();
    const providerPath = join(context.root, "provider-auth.json");
    await writeJson(providerPath, authJson);

    const discovery = await discoverRetiredAuthMigration({
      home: context.home,
      platformHome: context.platformHome,
      env: {
        PROVIDER_CODE_AUTH_JSON_PATH: providerPath,
        PROVIDER_CODE_ACCOUNT_ID: "acct-provider",
      },
      currentSecureStorage: {},
    });

    expect(discovery.descriptor.conflicts).toEqual([]);
    expect(appliedVault(discovery).openAiOauth).toMatchObject({
      accessToken: "provider-secret",
      accountId: "acct-provider",
      authMode: "chatgpt",
    });
    expectSecretFreeDescriptor(discovery.descriptor, ["provider-secret"]);
  });
});

function appliedVault(
  discovery: RetiredAuthMigrationDiscovery,
  current: Readonly<SecureStorageData> = {},
): SecureStorageData {
  expect(discovery.mutation).toBeDefined();
  return applyRetiredAuthSecureStorageMutation(current, discovery.mutation!);
}

function byok(provider: string, apiKey: string) {
  return { provider, apiKey, savedAt: CREATED_AT };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function expectSecretFreeDescriptor(
  descriptor: unknown,
  secrets: readonly string[],
): void {
  const serialized = JSON.stringify(descriptor);
  for (const secret of secrets) expect(serialized).not.toContain(secret);
  expect(serialized).not.toContain("nextVault");
  expect(serialized).not.toContain("content");
}
