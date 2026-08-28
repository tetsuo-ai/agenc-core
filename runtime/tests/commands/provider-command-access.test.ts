import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { EnvSnapshot } from "../../src/config/env.js";
import {
  resolveHomeContext,
  type HomeContext,
} from "../../src/config/home.js";
import type { ConfigStore } from "../../src/config/store.js";
import type { Session } from "../../src/session/session.js";
import type { SecureStorageData } from "../../src/utils/secureStorage/index.js";
import type { SlashCommandContext } from "../../src/commands/types.js";

const secureStorageModulePath = "../../src/utils/secureStorage/index.js";

type CommandConfigStore = Pick<ConfigStore, "current" | "homeContext">;

let testRoot = "";
let secureStorageByIdentity = new Map<string, SecureStorageData>();

function secureStorageKey(home: HomeContext): string {
  return [
    home.identityKey,
    home.oauthFileSuffix,
    home.secureStorageAccount,
  ].join("\0");
}

function storedData(home: HomeContext): SecureStorageData {
  return structuredClone(
    secureStorageByIdentity.get(secureStorageKey(home)) ?? {},
  );
}

function installSecureStorage(): void {
  vi.doMock(secureStorageModulePath, () => ({
    getSecureStorage: (home: HomeContext) => ({
      name: "provider-command-access-test",
      read: () => storedData(home),
      readFresh: () => storedData(home),
      readAsync: async () => storedData(home),
      update: (data: SecureStorageData) => {
        secureStorageByIdentity.set(
          secureStorageKey(home),
          structuredClone(data),
        );
        return { success: true };
      },
      delete: () => secureStorageByIdentity.delete(secureStorageKey(home)),
    }),
  }));
}

async function createHome(name: string): Promise<HomeContext> {
  const path = join(testRoot, name);
  await mkdir(path, { recursive: true });
  return resolveHomeContext(
    { AGENC_HOME: path },
    { platformHome: testRoot },
  );
}

function commandConfigStore(
  homeContext: HomeContext,
  config: unknown = {},
): CommandConfigStore {
  return {
    homeContext,
    current: () => config as ReturnType<ConfigStore["current"]>,
  };
}

function stubSession(options: {
  readonly provider?: string;
  readonly model?: string;
  readonly configStore: CommandConfigStore;
  readonly environment?: EnvSnapshot;
}): Session {
  return {
    state: {
      unsafePeek: () => ({
        sessionConfiguration: {
          provider: { slug: options.provider ?? "grok" },
          collaborationMode: { model: options.model ?? "grok-4.6" },
        },
      }),
    },
    services: {
      configStore: options.configStore,
      providerEnvironment: options.environment ?? Object.freeze({}),
    },
  } as unknown as Session;
}

function commandContext(session: Session): SlashCommandContext {
  return {
    session,
    argsRaw: "",
    cwd: testRoot,
    home: testRoot,
  };
}

function expectRedactedSnapshot(
  snapshot: unknown,
  secrets: readonly string[] = [],
): void {
  const visited = new Set<object>();
  const pending: unknown[] = [snapshot];
  while (pending.length > 0) {
    const value = pending.pop();
    expect(typeof value).not.toBe("function");
    if (value === null || typeof value !== "object") continue;
    if (visited.has(value)) continue;
    visited.add(value);
    pending.push(...Reflect.ownKeys(value).map((key) => Reflect.get(value, key)));
  }

  const serialized = JSON.stringify(snapshot);
  expect(serialized).toBeTypeOf("string");
  for (const secret of secrets) {
    expect(serialized).not.toContain(secret);
  }
}

async function loadModules() {
  const [access, xaiCredentials, openAiCredentials] = await Promise.all([
    import("../../src/commands/provider-command-access.js"),
    import("../../src/utils/xaiOauthCredentials.js"),
    import("../../src/utils/openAiOauthCredentials.js"),
  ]);
  return { access, xaiCredentials, openAiCredentials };
}

async function writeRemoteAuthSession(
  home: HomeContext,
  tier: "free" | "pro",
  bearerToken: string,
): Promise<void> {
  const createdAt = "2026-08-27T00:00:00.000Z";
  secureStorageByIdentity.set(secureStorageKey(home), {
    ...storedData(home),
    remoteAuth: { bearerToken, createdAt },
  });
  await writeFile(
    home.authPath,
    JSON.stringify({
      version: 1,
      provider: "remote",
      createdAt,
      expiresAt: "2099-01-01T00:00:00.000Z",
      subscriptionTier: tier,
    }),
    "utf8",
  );
}

beforeEach(async () => {
  testRoot = await mkdtemp(join(tmpdir(), "agenc-provider-command-access-"));
  secureStorageByIdentity = new Map();
  vi.resetModules();
  installSecureStorage();
});

afterEach(async () => {
  vi.doUnmock(secureStorageModulePath);
  vi.clearAllMocks();
  vi.resetModules();
  secureStorageByIdentity.clear();
  await rm(testRoot, { recursive: true, force: true });
});

describe("provider command access", () => {
  test("uses ConfigStore home for exact and sibling Grok selections when the environment omits AGENC_HOME", async () => {
    const selectedHome = await createHome("selected-home");
    const otherHome = await createHome("other-home");
    const { access, xaiCredentials } = await loadModules();
    const selectedToken = "selected-xai-oauth-token";
    const otherToken = "other-xai-oauth-token";

    expect(
      xaiCredentials.saveXaiOauthCredentials(selectedHome, {
        accessToken: selectedToken,
      }).success,
    ).toBe(true);
    expect(
      xaiCredentials.saveXaiOauthCredentials(otherHome, {
        accessToken: otherToken,
      }).success,
    ).toBe(true);

    const overlay = access.createProviderCommandAccessOverlay(
      commandContext(
        stubSession({
          provider: "grok",
          model: "grok-4.6",
          configStore: commandConfigStore(selectedHome),
          environment: Object.freeze({}),
        }),
      ),
    );
    const current = overlay.inspect({ provider: "grok", model: "grok-4.6" });
    const sibling = overlay.inspect({ provider: "grok", model: "grok-4.5" });

    expect(current).toMatchObject({
      effect: "unchanged",
      route: "direct",
      directCredential: {
        status: "ready",
        mode: "xai-oauth",
        source: "native-sign-in",
      },
      auth: { state: "ready", label: "xAI OAuth" },
    });
    expect(current.rejection).toBeUndefined();
    expect(sibling).toMatchObject({
      effect: "switch",
      route: "direct",
      directCredential: {
        status: "ready",
        mode: "xai-oauth",
        source: "native-sign-in",
      },
    });
    expect(sibling.rejection).toBeUndefined();
    expectRedactedSnapshot(current, [selectedToken, otherToken]);
    expectRedactedSnapshot(sibling, [selectedToken, otherToken]);
  });

  test("recognizes stored OpenAI ChatGPT OAuth without exposing its bearer", async () => {
    const home = await createHome("openai-home");
    const { access, openAiCredentials } = await loadModules();
    const bearer = "openai-chatgpt-bearer";
    expect(
      openAiCredentials.saveOpenAiOauthCredentials(home, {
        authMode: "chatgpt",
        accessToken: bearer,
        accountId: "chatgpt-account",
      }).success,
    ).toBe(true);

    const overlay = access.createProviderCommandAccessOverlay(
      commandContext(
        stubSession({
          configStore: commandConfigStore(home),
          environment: Object.freeze({}),
        }),
      ),
    );
    const snapshot = overlay.inspect({ provider: "openai", model: "gpt-5" });

    expect(snapshot).toMatchObject({
      effect: "switch",
      route: "direct",
      directCredential: {
        status: "ready",
        mode: "openai-oauth",
        source: "native-sign-in",
      },
      auth: { state: "ready", label: "OpenAI sign-in" },
    });
    expect(snapshot.rejection).toBeUndefined();
    expectRedactedSnapshot(snapshot, [bearer, "chatgpt-account"]);
  });

  test("recognizes saved Gemini BYOK and access-token routing as direct access", async () => {
    const home = await createHome("gemini-home");
    const { access } = await loadModules();
    const savedKey = "saved-gemini-byok";
    secureStorageByIdentity.set(secureStorageKey(home), {
      localAuth: {
        byokKeys: {
          gemini: {
            provider: "gemini",
            apiKey: savedKey,
            savedAt: "2026-08-27T00:00:00.000Z",
          },
        },
      },
    });

    const savedOverlay = access.createProviderCommandAccessOverlay(
      commandContext(
        stubSession({
          configStore: commandConfigStore(home),
          environment: Object.freeze({ GEMINI_AUTH_MODE: "api-key" }),
        }),
      ),
    );
    const saved = savedOverlay.inspect({
      provider: "gemini",
      model: "gemini-2.5-pro",
    });
    expect(saved).toMatchObject({
      effect: "switch",
      route: "direct",
      directCredential: {
        status: "ready",
        mode: "api-key",
        source: "saved-byok",
      },
      auth: { state: "ready", source: "native secure storage" },
    });
    expect(saved.rejection).toBeUndefined();
    expectRedactedSnapshot(saved, [savedKey]);

    const accessToken = "gemini-secret-credential-93";
    const tokenOverlay = access.createProviderCommandAccessOverlay(
      commandContext(
        stubSession({
          configStore: commandConfigStore(home),
          environment: Object.freeze({
            GEMINI_AUTH_MODE: "access-token",
            GEMINI_ACCESS_TOKEN: accessToken,
            GEMINI_PROJECT_ID: "project-id",
            GEMINI_VERTEX_LOCATION: "us-central1",
          }),
        }),
      ),
    );
    const token = tokenOverlay.inspect({
      provider: "gemini",
      model: "gemini-2.5-pro",
    });
    expect(token).toMatchObject({
      effect: "switch",
      route: "direct",
      directCredential: {
        status: "ready",
        mode: "gemini-access-token",
        source: "environment",
      },
      auth: { state: "ready", source: "env GEMINI_ACCESS_TOKEN" },
    });
    expect(token.rejection).toBeUndefined();
    expectRedactedSnapshot(token, [accessToken]);
  });

  test("does not inherit Gemini ADC from the live provider binding", async () => {
    const home = await createHome("gemini-well-known-adc-home");
    const { access } = await loadModules();
    const overlay = access.createProviderCommandAccessOverlay(
      commandContext(
        stubSession({
          configStore: commandConfigStore(home),
        }),
      ),
    );

    expect(
      overlay.inspect({ provider: "gemini", model: "gemini-2.5-pro" }),
    ).toMatchObject({
      effect: "switch",
      route: "deferred",
      directCredential: {
        status: "missing",
        mode: "none",
      },
      auth: {
        state: "missing",
        source: expect.stringContaining("set Gemini"),
      },
    });
  });

  test("blocks partial Bedrock credentials and accepts a complete SigV4 pair", async () => {
    const home = await createHome("bedrock-home");
    const { access } = await loadModules();
    const accessKey = "bedrock-access-key";
    const secretKey = "bedrock-secret-key";

    const config = { auth: { managedKeys: { enabled: true } } };
    const partialOverlay = access.createProviderCommandAccessOverlay(
      commandContext(
        stubSession({
          configStore: commandConfigStore(home, config),
          environment: Object.freeze({ AWS_ACCESS_KEY_ID: accessKey }),
        }),
      ),
    );
    const partial = partialOverlay.inspect({
      provider: "amazon-bedrock",
      model: "amazon.nova-pro-v1:0",
    });
    expect(partial).toMatchObject({
      effect: "blocked",
      route: "unavailable",
      directCredential: {
        status: "missing",
        missingLabel:
          "AWS_BEDROCK_SECRET_ACCESS_KEY or AWS_SECRET_ACCESS_KEY",
      },
      rejection: {
        code: "credential-required",
        missingLabel:
          "AWS_BEDROCK_SECRET_ACCESS_KEY or AWS_SECRET_ACCESS_KEY",
      },
    });
    expectRedactedSnapshot(partial, [accessKey]);

    const completeOverlay = access.createProviderCommandAccessOverlay(
      commandContext(
        stubSession({
          configStore: commandConfigStore(home, config),
          environment: Object.freeze({
            AWS_ACCESS_KEY_ID: accessKey,
            AWS_SECRET_ACCESS_KEY: secretKey,
          }),
        }),
      ),
    );
    const complete = completeOverlay.inspect({
      provider: "amazon-bedrock",
      model: "amazon.nova-pro-v1:0",
    });
    expect(complete).toMatchObject({
      effect: "switch",
      route: "direct",
      directCredential: {
        status: "ready",
        mode: "aws-sigv4",
        source: "environment",
      },
    });
    expect(complete.rejection).toBeUndefined();
    expectRedactedSnapshot(complete, [accessKey, secretKey]);
  });

  test("defers absent credentials but blocks incomplete credentials when managed keys are disabled", async () => {
    const home = await createHome("missing-direct-home");
    const { access } = await loadModules();
    const absentOverlay = access.createProviderCommandAccessOverlay(
      commandContext(
        stubSession({
          configStore: commandConfigStore(home),
          environment: Object.freeze({}),
        }),
      ),
    );
    expect(
      absentOverlay.inspect({
        provider: "anthropic",
        model: "claude-opus-4-7",
      }),
    ).toMatchObject({
      effect: "switch",
      route: "deferred",
      directCredential: {
        status: "missing",
        reason: "absent",
        missingLabel: "ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN",
      },
    });

    const selections = [
      {
        provider: "amazon-bedrock" as const,
        model: "amazon.nova-pro-v1:0",
        environment: Object.freeze({ AWS_ACCESS_KEY_ID: "partial-access" }),
        missingLabel:
          "AWS_BEDROCK_SECRET_ACCESS_KEY or AWS_SECRET_ACCESS_KEY",
      },
      {
        provider: "gemini" as const,
        model: "gemini-2.5-pro",
        environment: Object.freeze({
          GEMINI_AUTH_MODE: "access-token",
          GEMINI_PROJECT_ID: "project-id",
          GEMINI_VERTEX_LOCATION: "us-central1",
        }),
        missingLabel: "GEMINI_ACCESS_TOKEN",
      },
    ];

    for (const selection of selections) {
      const overlay = access.createProviderCommandAccessOverlay(
        commandContext(
          stubSession({
            configStore: commandConfigStore(home),
            environment: selection.environment,
          }),
        ),
      );
      expect(overlay.inspect(selection)).toMatchObject({
        effect: "blocked",
        route: "unavailable",
        directCredential: {
          status: "missing",
          missingLabel: selection.missingLabel,
        },
        rejection: {
          code: "credential-required",
          missingLabel: selection.missingLabel,
        },
      });
    }
  });

  test("keeps local providers selectable without credentials", async () => {
    const home = await createHome("local-home");
    const { access } = await loadModules();
    const overlay = access.createProviderCommandAccessOverlay(
      commandContext(
        stubSession({ configStore: commandConfigStore(home) }),
      ),
    );

    const ollama = overlay.inspect({ provider: "ollama", model: "llama3.3" });
    const lmstudio = overlay.inspect({
      provider: "lmstudio",
      model: "gpt-4o-mini",
    });
    expect(ollama).toMatchObject({
      effect: "switch",
      route: "local",
      directCredential: { status: "not-required", mode: "none" },
      auth: { state: "optional" },
    });
    expect(lmstudio).toMatchObject({
      effect: "switch",
      route: "local",
      directCredential: { status: "optional", mode: "none" },
      auth: { state: "optional" },
    });
    expectRedactedSnapshot(ollama);
    expectRedactedSnapshot(lmstudio);
  });

  test("allows Grok composer models without an xAI credential", async () => {
    const home = await createHome("composer-home");
    const { access } = await loadModules();
    const overlay = access.createProviderCommandAccessOverlay(
      commandContext(
        stubSession({
          provider: "openai",
          model: "gpt-5",
          configStore: commandConfigStore(home),
        }),
      ),
    );
    const snapshot = overlay.inspect({
      provider: "grok",
      model: "grok-composer-2.5-fast",
    });

    expect(snapshot).toMatchObject({
      effect: "switch",
      route: "direct",
      directCredential: { status: "not-required", mode: "none" },
      auth: { state: "optional", label: "Grok CLI authentication" },
    });
    expect(snapshot.rejection).toBeUndefined();
    expectRedactedSnapshot(snapshot);
  });

  test("enforces signed-out, free, and paid OpenRouter managed policy", async () => {
    const signedOutHome = await createHome("managed-signed-out");
    const freeHome = await createHome("managed-free");
    const proHome = await createHome("managed-pro");
    const { access } = await loadModules();
    const config = { auth: { managedKeys: { enabled: true } } };
    const paidModel = "x-ai/grok-4.5";
    const freeModel = "cohere/north-mini-code:free";

    const signedOut = access.createProviderCommandAccessOverlay(
      commandContext(
        stubSession({
          configStore: commandConfigStore(signedOutHome, config),
        }),
      ),
    ).inspect({ provider: "openrouter", model: freeModel });
    expect(signedOut).toMatchObject({
      effect: "blocked",
      route: "unavailable",
      managed: { enabled: true, signedIn: false },
      rejection: { code: "login-required" },
    });

    const freeBearer = "free-managed-bearer";
    await writeRemoteAuthSession(freeHome, "free", freeBearer);
    const freeOverlay = access.createProviderCommandAccessOverlay(
      commandContext(
        stubSession({
          configStore: commandConfigStore(freeHome, config),
        }),
      ),
    );
    const free = freeOverlay.inspect({
      provider: "openrouter",
      model: freeModel,
    });
    const paidForFreeAccount = freeOverlay.inspect({
      provider: "openrouter",
      model: paidModel,
    });
    expect(free).toMatchObject({
      effect: "switch",
      route: "subscription",
      managed: { enabled: true, signedIn: true, tier: "free" },
      auth: { state: "managed" },
    });
    expect(free.rejection).toBeUndefined();
    expect(paidForFreeAccount).toMatchObject({
      effect: "blocked",
      route: "unavailable",
      rejection: { code: "upgrade-required" },
    });

    const proBearer = "pro-managed-bearer";
    await writeRemoteAuthSession(proHome, "pro", proBearer);
    const paid = access.createProviderCommandAccessOverlay(
      commandContext(
        stubSession({
          configStore: commandConfigStore(proHome, config),
        }),
      ),
    ).inspect({ provider: "openrouter", model: paidModel });
    expect(paid).toMatchObject({
      effect: "switch",
      route: "subscription",
      managed: { enabled: true, signedIn: true, tier: "pro" },
      auth: { state: "managed" },
    });
    expect(paid.rejection).toBeUndefined();

    for (const snapshot of [signedOut, free, paidForFreeAccount, paid]) {
      expectRedactedSnapshot(snapshot, [freeBearer, proBearer]);
    }
  });

  test("requires an entitled AgenC login for the managed provider", async () => {
    const signedOutHome = await createHome("agenc-signed-out");
    const freeHome = await createHome("agenc-free");
    const proHome = await createHome("agenc-pro");
    const { access } = await loadModules();
    const config = { auth: { managedKeys: { enabled: true } } };
    const selection = { provider: "agenc" as const, model: "agenc" };

    const signedOut = access.createProviderCommandAccessOverlay(
      commandContext(
        stubSession({
          configStore: commandConfigStore(signedOutHome, config),
        }),
      ),
    ).inspect(selection);
    expect(signedOut).toMatchObject({
      effect: "blocked",
      route: "unavailable",
      rejection: { code: "provider-managed-auth-required" },
    });

    const freeBearer = "free-agenc-bearer";
    await writeRemoteAuthSession(freeHome, "free", freeBearer);
    const free = access.createProviderCommandAccessOverlay(
      commandContext(
        stubSession({
          configStore: commandConfigStore(freeHome, config),
        }),
      ),
    ).inspect(selection);
    expect(free).toMatchObject({
      effect: "blocked",
      route: "unavailable",
      rejection: { code: "upgrade-required" },
    });

    const proBearer = "pro-agenc-bearer";
    await writeRemoteAuthSession(proHome, "pro", proBearer);
    const pro = access.createProviderCommandAccessOverlay(
      commandContext(
        stubSession({
          configStore: commandConfigStore(proHome, config),
        }),
      ),
    ).inspect(selection);
    expect(pro).toMatchObject({
      effect: "switch",
      route: "provider-managed",
      managed: { signedIn: true, tier: "pro" },
      auth: { state: "managed", label: "AgenC sign-in" },
    });
    expect(pro.rejection).toBeUndefined();

    for (const snapshot of [signedOut, free, pro]) {
      expectRedactedSnapshot(snapshot, [freeBearer, proBearer]);
    }
  });
});
