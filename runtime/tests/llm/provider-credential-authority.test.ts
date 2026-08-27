import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  resolveHomeContext,
  type HomeContext,
} from "../../src/config/home.js";
import type { SecureStorageData } from "../../src/utils/secureStorage/index.js";

const secureStorageModulePath = "../../src/utils/secureStorage/index.js";

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
      name: "provider-credential-authority-test",
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

async function loadCredentialModules() {
  const [providerOptions, openAiCredentials, xaiCredentials] =
    await Promise.all([
      import("../../src/llm/provider-options.js"),
      import("../../src/utils/openAiOauthCredentials.js"),
      import("../../src/utils/xaiOauthCredentials.js"),
    ]);
  return { providerOptions, openAiCredentials, xaiCredentials };
}

beforeEach(async () => {
  testRoot = await mkdtemp(
    join(tmpdir(), "agenc-provider-credential-authority-"),
  );
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

describe("provider credential authority", () => {
  test("uses Grok OAuth from the exact HomeContext when the environment omits AGENC_HOME", async () => {
    const selectedHome = await createHome("selected");
    const otherHome = await createHome("other");
    const { providerOptions, xaiCredentials } =
      await loadCredentialModules();

    expect(
      xaiCredentials.saveXaiOauthCredentials(selectedHome, {
        accessToken: "selected-xai-oauth",
      }).success,
    ).toBe(true);
    expect(
      xaiCredentials.saveXaiOauthCredentials(otherHome, {
        accessToken: "other-xai-oauth",
      }).success,
    ).toBe(true);

    const resolved = providerOptions.resolveProviderCredentialAuthority(
      "grok",
      {
        credentialHome: selectedHome,
        model: "grok-4.6",
      },
      {},
    );

    expect(resolved.credential).toMatchObject({
      status: "ready",
      mode: "xai-oauth",
      source: "native-sign-in",
    });
    expect(resolved.factoryOptions).toMatchObject({
      credentialHome: selectedHome,
      model: "grok-4.6",
      apiKey: "selected-xai-oauth",
    });
  });

  test("reports Grok environment API keys through the same authority", async () => {
    const { providerOptions } = await loadCredentialModules();

    const resolved = providerOptions.resolveProviderCredentialAuthority(
      "grok",
      { model: "grok-4.6" },
      { XAI_API_KEY: "xai-environment-key" },
    );

    expect(resolved.credential).toMatchObject({
      status: "ready",
      mode: "api-key",
      source: "environment",
    });
    expect(resolved.factoryOptions.apiKey).toBe("xai-environment-key");
  });

  test("does not require a provider credential for Grok composer models", async () => {
    const { providerOptions } = await loadCredentialModules();

    const resolved = providerOptions.resolveProviderCredentialAuthority(
      "grok",
      { model: "grok-composer-2.5-fast" },
      {},
    );

    expect(resolved.credential).toMatchObject({
      status: "not-required",
      mode: "none",
    });
    expect(resolved.factoryOptions.apiKey).toBeUndefined();
  });

  test("recognizes a stored OpenAI ChatGPT subscription", async () => {
    const home = await createHome("openai-chatgpt");
    const { providerOptions, openAiCredentials } =
      await loadCredentialModules();
    expect(
      openAiCredentials.saveOpenAiOauthCredentials(home, {
        accessToken: "chatgpt-access-token",
        accountId: "chatgpt-account",
      }).success,
    ).toBe(true);

    const resolved = providerOptions.resolveProviderCredentialAuthority(
      "openai",
      { credentialHome: home, model: "gpt-5" },
      {},
    );

    expect(resolved.credential).toMatchObject({
      status: "ready",
      mode: "openai-oauth",
      source: "native-sign-in",
    });
    expect(resolved.factoryOptions.apiKey).toBeUndefined();
    expect(resolved.factoryOptions.extra).toMatchObject({
      authMode: "oauth",
      chatgptBackend: true,
    });
  });

  test("recognizes a stored OpenAI platform key", async () => {
    const home = await createHome("openai-platform");
    const { providerOptions, openAiCredentials } =
      await loadCredentialModules();
    expect(
      openAiCredentials.saveOpenAiOauthCredentials(home, {
        apiKey: "stored-openai-platform-key",
      }).success,
    ).toBe(true);

    const resolved = providerOptions.resolveProviderCredentialAuthority(
      "openai",
      { credentialHome: home, model: "gpt-5" },
      { OPENAI_API_KEY: "ignored-environment-key" },
    );

    expect(resolved.credential).toMatchObject({
      status: "ready",
      mode: "api-key",
      source: "native-sign-in",
    });
    expect(resolved.factoryOptions.apiKey).toBe(
      "stored-openai-platform-key",
    );
  });

  test.each([
    {
      name: "Gemini API key",
      environment: {
        GEMINI_API_KEY: "gemini-environment-key",
      },
      mode: "api-key",
      plan: {
        kind: "api-key",
        credential: "gemini-environment-key",
        source: "GEMINI_API_KEY",
      },
    },
    {
      name: "Gemini access token",
      environment: {
        GEMINI_ACCESS_TOKEN: "gemini-access-token",
        GOOGLE_CLOUD_PROJECT: "gemini-project",
        GOOGLE_CLOUD_LOCATION: "us-central1",
      },
      mode: "gemini-access-token",
      plan: {
        kind: "access-token",
        credential: "gemini-access-token",
        source: "GEMINI_ACCESS_TOKEN",
      },
    },
  ])("recognizes $name environment credentials", async ({
    environment,
    mode,
    plan,
  }) => {
    const { providerOptions } = await loadCredentialModules();

    const resolved = providerOptions.resolveProviderCredentialAuthority(
      "gemini",
      { model: "gemini-2.5-pro" },
      environment,
    );

    expect(resolved.credential).toMatchObject({
      status: "ready",
      mode,
      source: "environment",
    });
    if (plan.kind === "api-key") {
      expect(resolved.credential).toMatchObject({
        provenance: {
          kind: "environment",
          fields: [{ role: "apiKey", envVar: plan.source }],
        },
      });
    }
    expect(resolved.factoryOptions.apiKey).toBeUndefined();
    expect(resolved.factoryOptions.extra).toMatchObject({
      gemini: { credentialPlan: plan },
    });
  });

  test("recognizes a saved Gemini BYOK key", async () => {
    const { providerOptions } = await loadCredentialModules();

    const resolved = providerOptions.resolveProviderCredentialAuthority(
      "gemini",
      { model: "gemini-2.5-pro" },
      {},
      { savedApiKey: "saved-gemini-key" },
    );

    expect(resolved.credential).toMatchObject({
      status: "ready",
      mode: "api-key",
      source: "saved-byok",
    });
    expect(resolved.factoryOptions.extra).toMatchObject({
      gemini: {
        credentialPlan: {
          kind: "api-key",
          credential: "saved-gemini-key",
          source: "saved-byok",
        },
      },
    });
  });

  test("recognizes Gemini ADC from the captured environment", async () => {
    const adcPath = join(testRoot, "adc.json");
    await writeFile(adcPath, "{}", "utf8");
    const { providerOptions } = await loadCredentialModules();

    const resolved = providerOptions.resolveProviderCredentialAuthority(
      "gemini",
      { model: "gemini-2.5-pro" },
      {
        GEMINI_AUTH_MODE: "adc",
        GOOGLE_APPLICATION_CREDENTIALS: adcPath,
        GOOGLE_CLOUD_PROJECT: "gemini-project",
        GOOGLE_CLOUD_LOCATION: "us-central1",
      },
    );

    expect(resolved.credential).toMatchObject({
      status: "ready",
      mode: "gemini-adc",
      source: "environment",
    });
    expect(resolved.factoryOptions.extra).toMatchObject({
      gemini: {
        credentialPlan: {
          kind: "adc",
          credentialPath: adcPath,
          source: "GOOGLE_APPLICATION_CREDENTIALS",
        },
      },
    });
  });

  test("distinguishes well-known Gemini ADC from environment credentials", async () => {
    const { providerOptions } = await loadCredentialModules();

    const resolved = providerOptions.resolveProviderCredentialAuthority(
      "gemini",
      {
        model: "gemini-2.5-pro",
        extra: {
          gemini: {
            credentialPlan: {
              kind: "adc",
              credentialPath: join(testRoot, "well-known-adc.json"),
              source: "well-known-adc",
            },
            endpointPlan: {
              kind: "developer",
              nativeBaseURL:
                "https://generativelanguage.googleapis.com/v1beta",
            },
          },
        },
      },
      {},
    );

    expect(resolved.credential).toMatchObject({
      status: "ready",
      mode: "gemini-adc",
      source: "application-default",
      label: "Google application default credentials",
    });
  });

  test("distinguishes complete and partial Bedrock SigV4 credentials", async () => {
    const { providerOptions } = await loadCredentialModules();

    const complete = providerOptions.resolveProviderCredentialAuthority(
      "amazon-bedrock",
      { model: "amazon.nova-pro-v1:0" },
      {
        AWS_ACCESS_KEY_ID: "bedrock-access",
        AWS_SECRET_ACCESS_KEY: "bedrock-secret",
        AWS_SESSION_TOKEN: "bedrock-session",
        AWS_REGION: "us-west-2",
      },
    );
    expect(complete.credential).toMatchObject({
      status: "ready",
      mode: "aws-sigv4",
      source: "environment",
    });
    expect(complete.factoryOptions.extra).toMatchObject({
      accessKeyId: "bedrock-access",
      secretAccessKey: "bedrock-secret",
      sessionToken: "bedrock-session",
      region: "us-west-2",
    });

    const partial = providerOptions.resolveProviderCredentialAuthority(
      "amazon-bedrock",
      { model: "amazon.nova-pro-v1:0" },
      { AWS_ACCESS_KEY_ID: "bedrock-access" },
    );
    expect(partial.credential).toMatchObject({
      status: "missing",
      mode: "none",
      missingLabel:
        "AWS_BEDROCK_SECRET_ACCESS_KEY or AWS_SECRET_ACCESS_KEY",
      provenance: {
        kind: "environment",
        fields: [{ role: "accessKeyId", envVar: "AWS_ACCESS_KEY_ID" }],
      },
    });
  });

  test("marks Ollama as credential-free and local OpenAI servers as optional", async () => {
    const { providerOptions } = await loadCredentialModules();

    const ollama = providerOptions.resolveProviderCredentialAuthority(
      "ollama",
      { model: "llama3.3" },
      {},
    );
    expect(ollama.credential).toMatchObject({
      status: "not-required",
      mode: "none",
    });

    for (const [provider, model] of [
      ["lmstudio", "local-model"],
      ["openai-compatible", "local-model"],
    ] as const) {
      const resolved = providerOptions.resolveProviderCredentialAuthority(
        provider,
        { model },
        {},
      );
      expect(resolved.credential, provider).toMatchObject({
        status: "optional",
        mode: "none",
      });
      expect(resolved.factoryOptions.apiKey, provider).toBeUndefined();
    }
  });

  test("reports the missing credential label for an ordinary API-key provider", async () => {
    const { providerOptions } = await loadCredentialModules();

    const missing = providerOptions.resolveProviderCredentialAuthority(
      "anthropic",
      { model: "claude-opus-4-7" },
      {},
    );
    expect(missing.credential).toMatchObject({
      status: "missing",
      mode: "none",
      missingLabel: "ANTHROPIC_API_KEY",
    });

    const explicit = providerOptions.resolveProviderCredentialAuthority(
      "anthropic",
      {
        apiKey: "explicit-anthropic-key",
        model: "claude-opus-4-7",
      },
      {},
    );
    expect(explicit.credential).toMatchObject({
      status: "ready",
      mode: "api-key",
      source: "explicit",
    });
    expect(explicit.factoryOptions.apiKey).toBe("explicit-anthropic-key");
  });
});
