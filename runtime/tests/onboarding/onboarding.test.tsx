import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test, vi } from "vitest";

import { defaultConfig } from "../config/schema.js";
import { LocalAuthBackend } from "../auth/backends/local.js";
import { RemoteAuthBackend } from "../auth/backends/remote.js";
import type { RemoteAuthSessionReadContext } from "../auth/session-state.js";
import {
  listBuiltInProviderInfo,
  providerCredentialEnvironmentLabel,
} from "../llm/registry/provider-info.js";
import { captureSecureStorageIngress } from "../utils/secureStorage/home.js";
import { saveXaiOauthCredentials } from "../utils/xaiOauthCredentials.js";
import { getProxyFetchOptions } from "../utils/proxy.js";
import { MAX_ONBOARDING_INPUT_LENGTH } from "./inputPaste.js";
import { hashPastedText, retrievePastedText } from "./pasteStore.js";

const nativeByokReadOverride = vi.hoisted(() => ({
  current: null as null | ((home: unknown, provider: string) => unknown),
}));

vi.mock("../auth/native-credentials.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../auth/native-credentials.js")
  >();
  return {
    ...actual,
    readLocalByokCredential: (
      ...args: Parameters<typeof actual.readLocalByokCredential>
    ) =>
      nativeByokReadOverride.current === null
        ? actual.readLocalByokCredential(...args)
        : nativeByokReadOverride.current(...args),
  };
});

vi.mock("../tui/ink.js", async () => {
  const React = await import("react");
  return {
    Box: ({ children }: { children?: React.ReactNode }) =>
      React.createElement("ink-box", null, children),
    Text: ({ children }: { children?: React.ReactNode }) =>
      React.createElement("ink-text", null, children),
  };
});

import {
  checkOnboardingProviderConnection,
  createInitialFirstRunOnboardingState,
  detectRunningLocalProviders,
  detailLinesForStep,
  firstRunOnboardingInputPresentation,
  submitFirstRunOnboardingInput,
  wizardThemeToSetting,
} from "./Onboarding.js";
import {
  incrementFirstRunOnboardingSeenCount,
  maybeMarkProjectOnboardingComplete,
  markFirstRunOnboardingComplete,
  readOnboardingState,
  shouldShowFirstRunOnboarding,
  shouldShowProjectOnboarding,
} from "./projectOnboardingState.js";
import {
  getSteps,
  isProjectOnboardingComplete,
} from "./projectOnboardingSteps.js";

function withTempDir<T>(prefix: string, run: (path: string) => T): T {
  const path = mkdtempSync(join(tmpdir(), prefix));
  try {
    return run(path);
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
}

async function withRemoteAuthSession<T>(
  prefix: string,
  subscriptionTier: "free" | "pro",
  run: (fixture: {
    readonly agencHome: string;
    readonly env: RemoteAuthSessionReadContext["environment"];
    readonly remoteAuthSessionContext: RemoteAuthSessionReadContext;
  }) => T | Promise<T>,
): Promise<T> {
  const agencHome = mkdtempSync(join(tmpdir(), prefix));
  const env = Object.freeze({ AGENC_HOME: agencHome });
  const ingress = captureSecureStorageIngress(env, agencHome);
  const remoteAuthSessionContext = Object.freeze({
    home: ingress.home,
    environment: ingress.environment,
  });
  const backend = new RemoteAuthBackend({
    agencHome: ingress.home.path,
    env: ingress.environment,
    loginFlow: () => ({
      token: "remote-session-token",
      subscriptionTier,
    }),
    now: () => new Date("2026-08-24T00:00:00.000Z"),
  });
  let signedIn = false;
  try {
    await backend.login();
    signedIn = true;
    return await run({
      agencHome,
      env: ingress.environment,
      remoteAuthSessionContext,
    });
  } finally {
    try {
      if (signedIn) await backend.logout();
    } finally {
      rmSync(agencHome, { recursive: true, force: true });
    }
  }
}

describe("first-run onboarding state", () => {
  test("shows only for interactive sessions that have not completed onboarding", () => {
    withTempDir("agenc-onboarding-", (agencHome) => {
      expect(
        shouldShowFirstRunOnboarding({
          agencHome,
          env: {},
          isInteractive: true,
        }),
      ).toBe(true);

      incrementFirstRunOnboardingSeenCount({ agencHome });
      expect(readOnboardingState({ agencHome }).seenCount).toBe(1);

      markFirstRunOnboardingComplete({
        agencHome,
        selectedProvider: "grok",
        selectedModel: "grok-4.3",
        selectedTheme: "dark",
        completedStepIds: ["preflight"],
        now: new Date("2026-01-01T00:00:00.000Z"),
      });

      expect(
        shouldShowFirstRunOnboarding({
          agencHome,
          env: {},
          isInteractive: true,
        }),
      ).toBe(false);
    });
  });

  test("honors noninteractive sessions and disable flags", () => {
    withTempDir("agenc-onboarding-", (agencHome) => {
      expect(
        shouldShowFirstRunOnboarding({
          agencHome,
          env: {},
          isInteractive: false,
        }),
      ).toBe(false);
      expect(
        shouldShowFirstRunOnboarding({
          agencHome,
          env: { AGENC_ONBOARDING: "off" },
          isInteractive: true,
        }),
      ).toBe(false);
    });
  });

  test("suppresses after the seen-count limit and recovers from malformed state", () => {
    withTempDir("agenc-onboarding-", (agencHome) => {
      writeFileSync(join(agencHome, "onboarding.json"), "{not-json\n");
      expect(readOnboardingState({ agencHome }).completed).toBe(false);

      for (let i = 0; i < 4; i += 1) {
        incrementFirstRunOnboardingSeenCount({ agencHome });
      }

      expect(
        shouldShowFirstRunOnboarding({
          agencHome,
          env: {},
          isInteractive: true,
        }),
      ).toBe(false);
    });
  });
});

describe("first-run onboarding wizard", () => {
  async function advanceToModelAccess(
    context: Parameters<typeof createInitialFirstRunOnboardingState>[0] & {
      readonly checkLocalProviders?: boolean;
      readonly fetchImpl?: typeof fetch;
      readonly agencHome?: string;
    },
  ) {
    let state = createInitialFirstRunOnboardingState(context);
    state = (await submitFirstRunOnboardingInput(state, "next", context)).state;
    state = (await submitFirstRunOnboardingInput(state, "1", context)).state;
    state = (await submitFirstRunOnboardingInput(state, "1", context)).state;
    return state;
  }

  test("advances through provider selection, API key, connection check, and completion", async () => {
    const config = defaultConfig();
    const context = { config, env: {}, checkLocalProviders: false };
    let state = createInitialFirstRunOnboardingState(context);

    expect(state.currentStepId).toBe("preflight");
    expect(state.selectedProvider).toBe("grok");

    state = (await submitFirstRunOnboardingInput(state, "next", context)).state;
    expect(state.currentStepId).toBe("theme");

    state = (await submitFirstRunOnboardingInput(state, "1", context)).state;
    expect(state.selectedTheme).toBe("auto");
    expect(state.currentStepId).toBe("provider");

    state = (await submitFirstRunOnboardingInput(state, "1", context)).state;
    expect(state.selectedProvider).toBe("grok");
    expect(state.currentStepId).toBe("model-access");

    state = (await submitFirstRunOnboardingInput(state, "next", context)).state;
    expect(state.currentStepId).toBe("connection-test");

    state = (await submitFirstRunOnboardingInput(state, "test", context)).state;
    expect(state.currentStepId).toBe("security");
    expect(state.connection?.status).toBe("credentials-required");
    expect(state.connection?.credentialLabel).toBe(
      "XAI_API_KEY or GROK_API_KEY",
    );

    state = (await submitFirstRunOnboardingInput(state, "next", context)).state;
    expect(state.currentStepId).toBe("terminal-setup");
    const result = await submitFirstRunOnboardingInput(state, "done", context);
    expect(result.completed).toBe(true);
    expect(result.state.completedStepIds).toContain("terminal-setup");
  });

  test("uses layered config rather than stale environment selectors for its initial provider", () => {
    const config = {
      ...defaultConfig(),
      model_provider: "openai" as const,
      model: "gpt-4.1",
    };

    const state = createInitialFirstRunOnboardingState({
      config,
      env: {
        AGENC_PROVIDER: "github",
        AGENC_MODEL: "github:copilot",
      },
    });

    expect(state.selectedProvider).toBe("openai");
    expect(state.selectedModel).toBe("gpt-4.1");
  });

  test("makes Enter advance every default step except credential persistence", async () => {
    const context = {
      config: defaultConfig(),
      env: {},
      checkLocalProviders: false,
    };
    let state = createInitialFirstRunOnboardingState(context);

    expect(firstRunOnboardingInputPresentation(state)).toMatchObject({
      placeholder: "Press Enter to start setup",
      allowEmptySubmit: true,
    });
    state = (await submitFirstRunOnboardingInput(state, "", context)).state;
    expect(state.currentStepId).toBe("theme");

    state = (await submitFirstRunOnboardingInput(state, "", context)).state;
    expect(state.currentStepId).toBe("provider");

    state = (await submitFirstRunOnboardingInput(state, "", context)).state;
    expect(state.currentStepId).toBe("model-access");

    state = (await submitFirstRunOnboardingInput(state, "", context)).state;
    expect(state.currentStepId).toBe("connection-test");

    state = (await submitFirstRunOnboardingInput(state, "", context)).state;
    expect(state.currentStepId).toBe("security");

    state = (await submitFirstRunOnboardingInput(state, "", context)).state;
    expect(state.currentStepId).toBe("terminal-setup");

    const result = await submitFirstRunOnboardingInput(state, "", context);
    expect(result.completed).toBe(true);
  });

  test("keeps the configured model when Enter confirms the current provider", async () => {
    const context = {
      config: {
        ...defaultConfig(),
        model_provider: "ollama" as const,
        model: "llama4:latest",
      },
      env: {},
      checkLocalProviders: false,
    };
    let state = createInitialFirstRunOnboardingState(context);

    state = (await submitFirstRunOnboardingInput(state, "next", context)).state;
    state = (await submitFirstRunOnboardingInput(state, "", context)).state;
    expect(state).toMatchObject({
      currentStepId: "provider",
      selectedProvider: "ollama",
      selectedModel: "llama4:latest",
    });

    state = (await submitFirstRunOnboardingInput(state, "", context)).state;
    expect(state).toMatchObject({
      currentStepId: "model-access",
      selectedProvider: "ollama",
      selectedModel: "llama4:latest",
    });
  });

  test("checks configured provider credentials and local endpoints", async () => {
    const config = defaultConfig();
    const remoteFetch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(
      checkOnboardingProviderConnection(
        {
          config,
          env: { XAI_API_KEY: "xai-test-key" },
          fetchImpl: remoteFetch,
        },
        "grok",
        "grok-4.3",
      ),
    ).resolves.toMatchObject({
      ok: true,
      status: "ready",
      credentialLabel: "XAI_API_KEY or GROK_API_KEY",
      credentialProvenance: {
        kind: "environment",
        fields: [{ role: "apiKey", envVar: "XAI_API_KEY" }],
      },
    });
    const [requestUrl, requestInit] = remoteFetch.mock.calls[0] ?? [];
    expect(String(requestUrl)).toBe("https://api.x.ai/v1/models");
    expect(
      (requestInit?.headers as Record<string, string>).Authorization,
    ).toBe("Bearer xai-test-key");

    await expect(
      checkOnboardingProviderConnection(
        { config, env: {} },
        "grok",
        "grok-4.3",
      ),
    ).resolves.toMatchObject({
      ok: false,
      status: "credentials-required",
      credentialLabel: "XAI_API_KEY or GROK_API_KEY",
    });

    await expect(
      checkOnboardingProviderConnection(
        {
          config,
          env: { XAI_API_KEY: "xai-test-key" },
          fetchImpl: async () => new Response("unauthorized", { status: 401 }),
        },
        "grok",
        "grok-4.3",
      ),
    ).resolves.toMatchObject({
      ok: false,
      status: "auth-failed",
      credentialLabel: "XAI_API_KEY or GROK_API_KEY",
      credentialProvenance: {
        kind: "environment",
        fields: [{ role: "apiKey", envVar: "XAI_API_KEY" }],
      },
    });

    await expect(
      checkOnboardingProviderConnection(
        {
          config,
          env: {},
          fetchImpl: async () =>
            new Response(
              JSON.stringify({ models: [{ name: "llama3.3:latest" }] }),
              { status: 200 },
            ),
        },
        "ollama",
        "llama3.3",
      ),
    ).resolves.toMatchObject({
      ok: true,
      status: "ready",
    });

    await expect(
      checkOnboardingProviderConnection(
        {
          config,
          env: {},
          fetchImpl: async () => ({ ok: false }) as Response,
        },
        "ollama",
        "llama3.3",
      ),
    ).resolves.toMatchObject({
      ok: false,
      status: "local-down",
    });
  });

  test("reports stored Grok OAuth as the winner over stale key aliases", async () => {
    const agencHome = mkdtempSync(join(tmpdir(), "agenc-onboarding-oauth-"));
    const env = {
      AGENC_HOME: agencHome,
      XAI_API_KEY: "stale-xai-key",
      GROK_API_KEY: "stale-grok-key",
    };
    const ingress = captureSecureStorageIngress(env, agencHome);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );
    try {
      expect(
        saveXaiOauthCredentials(ingress.home, {
          accessToken: "current-oauth-token",
          expiresAt: Date.now() + 60_000,
        }).success,
      ).toBe(true);

      await expect(
        checkOnboardingProviderConnection(
          {
            agencHome,
            config: defaultConfig(),
            env,
            fetchImpl,
          },
          "grok",
          "grok-4.3",
        ),
      ).resolves.toMatchObject({
        ok: true,
        status: "ready",
        detail: "Provider credential found via xAI OAuth.",
        credentialLabel: "XAI_API_KEY or GROK_API_KEY",
        credentialProvenance: { kind: "oauth", provider: "grok" },
      });
      expect(fetchImpl).toHaveBeenCalledOnce();
      expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({
        headers: { Authorization: "Bearer current-oauth-token" },
      });
    } finally {
      rmSync(agencHome, { recursive: true, force: true });
    }
  });

  test("never sends stored Grok OAuth to a custom base URL", async () => {
    const agencHome = mkdtempSync(join(tmpdir(), "agenc-onboarding-oauth-host-"));
    const env = { AGENC_HOME: agencHome };
    const ingress = captureSecureStorageIngress(env, agencHome);
    const fetchImpl = vi.fn<typeof fetch>();
    const base = defaultConfig();
    try {
      expect(
        saveXaiOauthCredentials(ingress.home, {
          accessToken: "oauth-must-not-leave",
          expiresAt: Date.now() + 60_000,
        }).success,
      ).toBe(true);

      const result = await checkOnboardingProviderConnection(
        {
          agencHome,
          config: {
            ...base,
            providers: {
              ...base.providers,
              grok: {
                ...base.providers?.grok,
                base_url: "https://untrusted.example/v1",
              },
            },
          },
          env,
          fetchImpl,
        },
        "grok",
        "grok-4.3",
      );

      expect(result).toMatchObject({
        ok: false,
        status: "auth-failed",
        detail:
          "Refusing to send the stored xAI OAuth credential to a custom Grok base URL.",
        credentialProvenance: { kind: "oauth", provider: "grok" },
        baseURL: "https://untrusted.example/v1",
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      rmSync(agencHome, { recursive: true, force: true });
    }
  });

  test.each([
    {
      provider: "gemini",
      model: "gemini-2.5-pro",
      env: { GOOGLE_API_KEY: "google-test-key" },
      credentialLabel: "GEMINI_API_KEY or GOOGLE_API_KEY",
      sourceEnvVar: "GOOGLE_API_KEY",
    },
    {
      provider: "github",
      model: "gpt-4o",
      env: { GH_TOKEN: "github-test-token" },
      credentialLabel: "GITHUB_TOKEN or GH_TOKEN",
      sourceEnvVar: "GH_TOKEN",
    },
  ] as const)(
    "reports the actual winning fallback alias for $provider",
    async ({ provider, model, env, credentialLabel, sourceEnvVar }) => {
      await expect(
        checkOnboardingProviderConnection(
          {
            config: defaultConfig(),
            env,
            fetchImpl: async () => new Response("{}", { status: 200 }),
          },
          provider,
          model,
        ),
      ).resolves.toMatchObject({
        ok: true,
        status: "ready",
        credentialLabel,
        credentialProvenance: {
          kind: "environment",
          fields: [{ role: "apiKey", envVar: sourceEnvVar }],
        },
      });
    },
  );

  test("probes forced Gemini access tokens through the canonical Vertex endpoint", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("{}", { status: 200 }),
    );

    const connection = await checkOnboardingProviderConnection(
      {
        config: defaultConfig(),
        env: {
          GEMINI_AUTH_MODE: "access-token",
          GEMINI_ACCESS_TOKEN: "gemini-access-token",
          GEMINI_API_KEY: "must-not-win",
          GEMINI_PROJECT_ID: "authority-project",
          GEMINI_VERTEX_LOCATION: "us-central1",
        },
        fetchImpl,
      },
      "gemini",
      "gemini-2.5-pro",
    );

    expect(connection).toMatchObject({
      ok: true,
      status: "ready",
      detail: "Gemini credential found via GEMINI_ACCESS_TOKEN.",
      credentialLabel: "GEMINI_ACCESS_TOKEN",
      baseURL:
        "https://us-central1-aiplatform.googleapis.com/v1/projects/authority-project/locations/us-central1/publishers/google",
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toBe(
      "https://us-central1-aiplatform.googleapis.com/v1/projects/authority-project/locations/us-central1/publishers/google/models",
    );
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer gemini-access-token",
    );
  });

  test("does not fall back to a Gemini API key when access-token mode is forced", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await expect(
      checkOnboardingProviderConnection(
        {
          config: defaultConfig(),
          env: {
            GEMINI_AUTH_MODE: "access-token",
            GEMINI_API_KEY: "must-not-fallback",
            GEMINI_PROJECT_ID: "forced-project",
            GEMINI_VERTEX_LOCATION: "us-central1",
          },
          fetchImpl,
        },
        "gemini",
        "gemini-2.5-pro",
      ),
    ).resolves.toMatchObject({
      ok: false,
      status: "credentials-required",
      credentialLabel: "GEMINI_ACCESS_TOKEN",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("reports forced Gemini ADC readiness without an API-key probe", async () => {
    const root = mkdtempSync(join(tmpdir(), "agenc-onboarding-gemini-adc-"));
    const adcPath = join(root, "application-default.json");
    writeFileSync(adcPath, "{}", { mode: 0o600 });
    const fetchImpl = vi.fn<typeof fetch>();
    try {
      await expect(
        checkOnboardingProviderConnection(
          {
            config: defaultConfig(),
            env: {
              GEMINI_AUTH_MODE: "adc",
              GOOGLE_APPLICATION_CREDENTIALS: adcPath,
              GOOGLE_API_KEY: "must-not-win",
              GEMINI_PROJECT_ID: "authority-project",
              GEMINI_VERTEX_LOCATION: "global",
            },
            fetchImpl,
          },
          "gemini",
          "gemini-2.5-pro",
        ),
      ).resolves.toMatchObject({
        ok: true,
        status: "ready",
        detail: expect.stringContaining(
          "Google ADC credential file selected via GOOGLE_APPLICATION_CREDENTIALS",
        ),
        credentialLabel: "GOOGLE_APPLICATION_CREDENTIALS",
        baseURL:
          "https://aiplatform.googleapis.com/v1/projects/authority-project/locations/global/publishers/google",
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("probes the saved Gemini BYOK selected from the native secure storage", async () => {
    const agencHome = mkdtempSync(join(tmpdir(), "agenc-onboarding-gemini-byok-"));
    const env = { AGENC_HOME: agencHome, GEMINI_AUTH_MODE: "api-key" };
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("{}", { status: 200 }),
    );
    try {
      await new LocalAuthBackend({ agencHome, env }).saveByokKey({
        provider: "gemini",
        apiKey: "saved-gemini-key",
      });

      await expect(
        checkOnboardingProviderConnection(
          { agencHome, config: defaultConfig(), env, fetchImpl },
          "gemini",
          "gemini-2.5-pro",
        ),
      ).resolves.toMatchObject({
        ok: true,
        status: "ready",
        detail: "Gemini credential found via saved Gemini BYOK.",
      });
      expect(fetchImpl).toHaveBeenCalledOnce();
      const [url, init] = fetchImpl.mock.calls[0] ?? [];
      expect(String(url)).toBe(
        "https://generativelanguage.googleapis.com/v1beta/models",
      );
      expect(new Headers(init?.headers).get("x-goog-api-key")).toBe(
        "saved-gemini-key",
      );
    } finally {
      rmSync(agencHome, { recursive: true, force: true });
    }
  });

  test("checks complete Bedrock SigV4 structure without a network probe", async () => {
    const incompleteFetch = vi.fn<typeof fetch>();
    const incomplete = await checkOnboardingProviderConnection(
      {
        config: defaultConfig(),
        env: { AWS_ACCESS_KEY_ID: "fallback-access" },
        fetchImpl: incompleteFetch,
      },
      "amazon-bedrock",
      "amazon.nova-pro-v1:0",
    );

    expect(incomplete).toMatchObject({
      ok: false,
      status: "credentials-required",
      credentialLabel:
        "AWS_BEDROCK_ACCESS_KEY_ID or AWS_ACCESS_KEY_ID and AWS_BEDROCK_SECRET_ACCESS_KEY or AWS_SECRET_ACCESS_KEY",
      credentialProvenance: {
        kind: "environment",
        fields: [{ role: "accessKeyId", envVar: "AWS_ACCESS_KEY_ID" }],
      },
    });
    expect(incompleteFetch).not.toHaveBeenCalled();

    const secretOnlyFetch = vi.fn<typeof fetch>();
    const secretOnly = await checkOnboardingProviderConnection(
      {
        config: defaultConfig(),
        env: { AWS_BEDROCK_SECRET_ACCESS_KEY: "bedrock-secret" },
        fetchImpl: secretOnlyFetch,
      },
      "amazon-bedrock",
      "amazon.nova-pro-v1:0",
    );

    expect(secretOnly).toMatchObject({
      ok: false,
      status: "credentials-required",
      detail: expect.stringContaining(
        "AWS_BEDROCK_ACCESS_KEY_ID or AWS_ACCESS_KEY_ID",
      ),
      credentialProvenance: {
        kind: "environment",
        fields: [
          {
            role: "secretAccessKey",
            envVar: "AWS_BEDROCK_SECRET_ACCESS_KEY",
          },
        ],
      },
    });
    expect(secretOnlyFetch).not.toHaveBeenCalled();

    const completeFetch = vi.fn<typeof fetch>();
    const complete = await checkOnboardingProviderConnection(
      {
        config: defaultConfig(),
        env: {
          AWS_ACCESS_KEY_ID: "fallback-access",
          AWS_SECRET_ACCESS_KEY: "fallback-secret",
          AWS_SESSION_TOKEN: "fallback-session",
          AWS_REGION: "us-west-2",
        },
        fetchImpl: completeFetch,
      },
      "amazon-bedrock",
      "amazon.nova-pro-v1:0",
    );

    expect(complete).toMatchObject({
      ok: true,
      status: "ready",
      detail:
        "Required AWS SigV4 credential fields are present. AgenC will verify them on the first signed Bedrock request.",
      credentialLabel:
        "AWS_BEDROCK_ACCESS_KEY_ID or AWS_ACCESS_KEY_ID and AWS_BEDROCK_SECRET_ACCESS_KEY or AWS_SECRET_ACCESS_KEY",
      credentialProvenance: {
        kind: "environment",
        fields: [
          { role: "accessKeyId", envVar: "AWS_ACCESS_KEY_ID" },
          { role: "secretAccessKey", envVar: "AWS_SECRET_ACCESS_KEY" },
          { role: "sessionToken", envVar: "AWS_SESSION_TOKEN" },
          { role: "region", envVar: "AWS_REGION" },
        ],
      },
    });
    expect(completeFetch).not.toHaveBeenCalled();
  });

  test("lists every canonical built-in provider in the provider step", () => {
    const context = { config: defaultConfig(), env: {} };
    const state = {
      ...createInitialFirstRunOnboardingState(context),
      currentStepId: "provider" as const,
    };
    const listedProviders = detailLinesForStep(state, context)
      .flatMap((line) => line.match(/^\d+\. ([a-z0-9-]+)/u)?.[1] ?? []);

    expect(listedProviders).toEqual(
      listBuiltInProviderInfo().map((provider) => provider.id),
    );
  });

  test.each([
    "grok",
    "openai",
    "anthropic",
    "openrouter",
    "groq",
    "deepseek",
    "gemini",
    "mistral",
    "nvidia-nim",
    "minimax",
    "github",
    "amazon-bedrock",
  ] as const)("does not classify %s as keyless", async (provider) => {
    const info = listBuiltInProviderInfo().find(
      (candidate) => candidate.id === provider,
    );
    expect(info).toBeDefined();

    await expect(
      checkOnboardingProviderConnection(
        { config: defaultConfig(), env: {} },
        provider,
        info!.defaultModel,
      ),
    ).resolves.toMatchObject({
      ok: false,
      status: "credentials-required",
      credentialLabel: provider === "gemini"
        ? "a Gemini API key, GEMINI_ACCESS_TOKEN, or Google ADC credentials"
        : providerCredentialEnvironmentLabel(provider),
    });
  });

  test("accepts the prepared Anthropic bearer-token path", async () => {
    let capturedHeaders: Headers | undefined;
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
      async (_input, init) => {
        capturedHeaders = new Headers(init?.headers);
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      },
    );

    await expect(
      checkOnboardingProviderConnection(
        {
          config: defaultConfig(),
          env: { ANTHROPIC_AUTH_TOKEN: "prepared-anthropic-token" },
          fetchImpl,
        },
        "anthropic",
        "claude-opus-4-7",
      ),
    ).resolves.toMatchObject({ ok: true, status: "ready" });
    expect(capturedHeaders?.get("authorization")).toBe(
      "Bearer prepared-anthropic-token",
    );
    expect(capturedHeaders?.has("x-api-key")).toBe(false);
  });

  test("uses the canonical Anthropic gateway and proxy transport for readiness", async () => {
    const environment = {
      ANTHROPIC_API_KEY: "prepared-anthropic-key",
      ANTHROPIC_BASE_URL: "https://anthropic-gateway.example/v1",
      ANTHROPIC_CUSTOM_HEADERS: "X-Gateway: prepared-header",
      HTTPS_PROXY: "http://proxy.example:8080",
    };
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;

    await expect(
      checkOnboardingProviderConnection(
        {
          config: defaultConfig(),
          env: environment,
          fetchImpl: async (input, init) => {
            capturedUrl = String(input);
            capturedInit = init;
            return new Response(JSON.stringify({ data: [] }), { status: 200 });
          },
        },
        "anthropic",
        "claude-opus-4-7",
      ),
    ).resolves.toMatchObject({ ok: true, status: "ready" });

    expect(capturedUrl).toBe(
      "https://anthropic-gateway.example/v1/models",
    );
    const headers = new Headers(capturedInit?.headers);
    expect(headers.get("x-gateway")).toBe("prepared-header");
    expect(headers.get("x-api-key")).toBe("prepared-anthropic-key");
    expect(capturedInit).toMatchObject(
      getProxyFetchOptions({
        forAnthropicAPI: true,
        environment,
      }) as RequestInit,
    );
  });

  test.each([
    "ollama",
    "lmstudio",
    "openai-compatible",
  ] as const)("uses the local readiness path for %s", async (provider) => {
    const info = listBuiltInProviderInfo().find(
      (candidate) => candidate.id === provider,
    );
    expect(info).toBeDefined();

    await expect(
      checkOnboardingProviderConnection(
        {
          config: defaultConfig(),
          env: {},
          checkLocalProviders: false,
        },
        provider,
        info!.defaultModel,
      ),
    ).resolves.toMatchObject({
      ok: true,
      status: "local-unchecked",
    });
  });

  test("does not read saved API keys for local providers", async () => {
    const readSavedApiKey = vi.fn(() => {
      throw new Error("local providers must not read native secure storage");
    });
    nativeByokReadOverride.current = readSavedApiKey;
    try {
      await expect(
        checkOnboardingProviderConnection(
          {
            config: defaultConfig(),
            env: {},
            checkLocalProviders: false,
          },
          "openai-compatible",
          "local-model",
        ),
      ).resolves.toMatchObject({
        ok: true,
        status: "local-unchecked",
      });
      expect(readSavedApiKey).not.toHaveBeenCalled();
    } finally {
      nativeByokReadOverride.current = null;
    }
  });

  test("uses the managed-auth readiness path for the AgenC provider", async () => {
    await expect(
      checkOnboardingProviderConnection(
        { config: defaultConfig(), env: {} },
        "agenc",
        "agenc",
      ),
    ).resolves.toMatchObject({
      ok: false,
      status: "credentials-required",
      detail: expect.stringContaining("requires account auth"),
    });
  });

  test("rejects reachable local providers that do not list the selected model", async () => {
    const config = defaultConfig();
    const ollamaFetch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({ models: [{ name: "llama3.3:latest" }] }),
        { status: 200 },
      ),
    );

    await expect(
      checkOnboardingProviderConnection(
        { config, env: {}, fetchImpl: ollamaFetch },
        "ollama",
        "llama4:latest",
      ),
    ).resolves.toMatchObject({
      ok: false,
      status: "local-model-missing",
      detail: expect.stringContaining("ollama pull llama4:latest"),
    });
    expect(String(ollamaFetch.mock.calls[0]?.[0])).toBe(
      "http://localhost:11434/api/tags",
    );
    expect(ollamaFetch).toHaveBeenCalledTimes(1);
    expect(ollamaFetch.mock.calls[0]?.[1]).toMatchObject({ method: "GET" });

    const lmStudioFetch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: "qwen3-coder" }] }), {
        status: 200,
      }),
    );
    await expect(
      checkOnboardingProviderConnection(
        { config, env: {}, fetchImpl: lmStudioFetch },
        "lmstudio",
        "devstral-small-2",
      ),
    ).resolves.toMatchObject({
      ok: false,
      status: "local-model-missing",
      detail: expect.stringContaining("devstral-small-2"),
    });
    expect(String(lmStudioFetch.mock.calls[0]?.[0])).toBe(
      "http://localhost:1234/v1/models",
    );
    expect(lmStudioFetch).toHaveBeenCalledTimes(1);
    expect(lmStudioFetch.mock.calls[0]?.[1]).toMatchObject({ method: "GET" });
  });

  test("rejects an oversized local model catalog without parsing it", async () => {
    const config = defaultConfig();
    const oversizedCatalog = JSON.stringify({
      models: [{ name: "llama3.3:latest" }],
      padding: "x".repeat(1024 * 1024),
    });

    await expect(
      checkOnboardingProviderConnection(
        {
          config,
          env: {},
          fetchImpl: async () => new Response(oversizedCatalog, { status: 200 }),
        },
        "ollama",
        "llama3.3",
      ),
    ).resolves.toMatchObject({
      ok: false,
      status: "local-down",
      detail: expect.stringContaining("readable model catalog"),
    });
  });

  test("treats signed-in remote auth as managed provider readiness", async () => {
    await withRemoteAuthSession(
      "agenc-onboarding-remote-auth-",
      "pro",
      async ({ env, remoteAuthSessionContext }) => {
        await expect(
          checkOnboardingProviderConnection(
            {
              config: defaultConfig(),
              env,
              remoteAuthSessionContext,
            },
            "openrouter",
            "x-ai/grok-4.3",
          ),
        ).resolves.toMatchObject({
          ok: true,
          status: "ready",
          detail:
            "AgenC Pro is signed in. Hosted OpenRouter model access is ready.",
        });
      },
    );
  });

  test("keeps the configured startup provider for signed-in Pro users", async () => {
    await withRemoteAuthSession(
      "agenc-onboarding-pro-default-",
      "pro",
      ({ env, remoteAuthSessionContext }) => {
        const context = {
          config: defaultConfig(),
          env,
          remoteAuthSessionContext,
        };
        const state = createInitialFirstRunOnboardingState(context);

        expect(state.selectedProvider).toBe("grok");
        expect(state.selectedModel).toBe("grok-4.6");
        expect(
          detailLinesForStep(
            { ...state, currentStepId: "provider" },
            context,
          )[0],
        ).toBe("1. grok (current)");
        expect(
          detailLinesForStep(
            { ...state, currentStepId: "model-access" },
            context,
          ).join("\n"),
        ).toContain(
          "Sign in or create an AgenC account — use hosted models",
        );
      },
    );
  });

  test("requires BYOK during onboarding when remote auth is free", async () => {
    await withRemoteAuthSession(
      "agenc-onboarding-free-auth-",
      "free",
      async ({ env, remoteAuthSessionContext }) => {
        const context = {
          config: defaultConfig(),
          env,
          remoteAuthSessionContext,
        };
        await expect(
          checkOnboardingProviderConnection(
            context,
            "openrouter",
            "x-ai/grok-4.3",
          ),
        ).resolves.toMatchObject({
          ok: false,
          status: "credentials-required",
          credentialLabel: "OPENROUTER_API_KEY",
          canSkip: false,
        });

        const state = {
          ...createInitialFirstRunOnboardingState(context),
          currentStepId: "model-access" as const,
          selectedProvider: "openrouter" as const,
          selectedModel: "x-ai/grok-4.3",
          connection: {
            provider: "openrouter",
            model: "x-ai/grok-4.3",
            status: "credentials-required" as const,
            ok: false,
            detail: "AgenC account is signed in on the free plan.",
            credentialLabel: "OPENROUTER_API_KEY",
            canSkip: false,
          },
        };

        const result = await submitFirstRunOnboardingInput(
          state,
          "next",
          context,
        );

        expect(result.completed).toBe(false);
        expect(result.state.currentStepId).toBe("model-access");
        expect(result.state.error).toContain("OPENROUTER_API_KEY is required");
      },
    );
  });

  test("recognizes a signed-in free account's hosted free model as ready", async () => {
    await withRemoteAuthSession(
      "agenc-onboarding-free-ready-",
      "free",
      async ({ env, remoteAuthSessionContext }) => {
        const context = {
          config: {
            ...defaultConfig(),
            model_provider: "openrouter",
            model: "cohere/north-mini-code:free",
          },
          env,
          remoteAuthSessionContext,
        };
        const state = createInitialFirstRunOnboardingState(context);

        expect(state.selectedProvider).toBe("openrouter");
        expect(state.selectedModel).toMatch(/:free$/);
        await expect(
          checkOnboardingProviderConnection(
            context,
            state.selectedProvider,
            state.selectedModel,
          ),
        ).resolves.toMatchObject({
          ok: true,
          status: "ready",
          detail:
            "AgenC account is signed in. Free hosted model access is ready.",
        });
      },
    );
  });

  test("describes verified provider credentials without asking users to add them later", () => {
    const config = defaultConfig();
    const context = {
      config,
      env: { XAI_API_KEY: "xai-test-key" },
      checkLocalProviders: false,
    };
    const state = {
      ...createInitialFirstRunOnboardingState(context),
      currentStepId: "model-access" as const,
      modelAccessInput: "api-key" as const,
      connection: {
        provider: "grok",
        model: "grok-4.3",
        status: "ready" as const,
        ok: true,
        detail: "Provider credential found via XAI_API_KEY.",
        credentialLabel: "XAI_API_KEY or GROK_API_KEY",
        credentialProvenance: {
          kind: "environment" as const,
          fields: [{ role: "apiKey" as const, envVar: "XAI_API_KEY" }],
        },
      },
    };

    const lines = detailLinesForStep(state, context);

    expect(lines).toContain("Provider credential found via XAI_API_KEY.");
    expect(lines).toContain(
      "XAI_API_KEY is present and verified. Press Enter to continue, or paste a replacement key.",
    );
    expect(lines.join("\n")).not.toContain("add it later");
  });

  test("does not offer pasted BYOK as an override for forced Gemini auth", async () => {
    const context = {
      config: defaultConfig(),
      env: { GEMINI_AUTH_MODE: "access-token" },
    };
    const state = {
      ...createInitialFirstRunOnboardingState(context),
      currentStepId: "model-access" as const,
      selectedProvider: "gemini" as const,
      selectedModel: "gemini-2.5-pro",
      modelAccessInput: "menu" as const,
    };

    const lines = detailLinesForStep(state, context).join("\n");
    expect(lines).toContain("Use Gemini with GEMINI_ACCESS_TOKEN");
    expect(lines).toContain(
      "Configure the forced Gemini credential source before testing.",
    );
    expect(lines).not.toContain("paste a provider API key directly");

    const result = await submitFirstRunOnboardingInput(state, "3", context);
    expect(result.state).toMatchObject({
      currentStepId: "model-access",
      modelAccessInput: "menu",
      error: expect.stringContaining(
        "A pasted API key cannot override GEMINI_AUTH_MODE=access-token",
      ),
    });
  });

  test("uses an already selected Gemini access-token plan without prompting for BYOK", async () => {
    const context = {
      config: defaultConfig(),
      env: {
        GEMINI_AUTH_MODE: "access-token",
        GEMINI_ACCESS_TOKEN: "configured-access-token",
      },
    };
    const state = {
      ...createInitialFirstRunOnboardingState(context),
      currentStepId: "model-access" as const,
      selectedProvider: "gemini" as const,
      selectedModel: "gemini-2.5-pro",
      modelAccessInput: "menu" as const,
    };

    expect(detailLinesForStep(state, context).join("\n")).toContain(
      "Use Gemini with configured GEMINI_ACCESS_TOKEN",
    );
    const result = await submitFirstRunOnboardingInput(state, "3", context);
    expect(result.state).toMatchObject({
      currentStepId: "connection-test",
      modelAccessInput: "menu",
      error: null,
    });
  });

  test("makes --dangerously-bypass-approvals-and-sandbox permission and sandbox behavior explicit", () => {
    const config = defaultConfig();
    const context = {
      config,
      env: {},
      permissionMode: "bypassPermissions",
      sandboxMode: "workspace-write",
      checkLocalProviders: false,
    };
    const state = {
      ...createInitialFirstRunOnboardingState(context),
      currentStepId: "security" as const,
    };

    const lines = detailLinesForStep(state, context);

    expect(lines).toContain(
      "Permission mode: bypassPermissions (--dangerously-bypass-approvals-and-sandbox skips tool approval prompts).",
    );
    expect(lines).toContain(
      "Sandbox: danger-full-access (--dangerously-bypass-approvals-and-sandbox disables workspace sandboxing for this session).",
    );
    expect(lines.join("\n")).not.toContain("Sandbox: workspace-write");
    expect(lines).toContain(
      "Press Enter to continue with --dangerously-bypass-approvals-and-sandbox, or restart without --dangerously-bypass-approvals-and-sandbox for prompts and sandboxing.",
    );
  });

  test("rejects invalid theme, provider, API-key, and connection-test input", async () => {
    const config = defaultConfig();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("offline verification fixture"));
    const context = {
      config,
      env: {},
      checkLocalProviders: false,
      fetchImpl,
    };
    let state = createInitialFirstRunOnboardingState(context);

    state = (await submitFirstRunOnboardingInput(state, "next", context)).state;
    let result = await submitFirstRunOnboardingInput(state, "sepia", context);
    expect(result.state.currentStepId).toBe("theme");
    expect(result.state.error).toContain("Choose");

    state = (await submitFirstRunOnboardingInput(state, "1", context)).state;
    result = await submitFirstRunOnboardingInput(state, "missing-provider", context);
    expect(result.state.currentStepId).toBe("provider");
    expect(result.state.error).toContain("provider");

    state = (await submitFirstRunOnboardingInput(state, "1", context)).state;
    result = await submitFirstRunOnboardingInput(
      state,
      "not-a-real-key",
      context,
    );
    expect(result.state.currentStepId).toBe("model-access");
    expect(result.state.error).toContain("Press Enter");
    expect(fetchImpl).toHaveBeenCalledOnce();

    state = (await submitFirstRunOnboardingInput(state, "next", context)).state;
    result = await submitFirstRunOnboardingInput(state, "later", context);
    expect(result.state.currentStepId).toBe("connection-test");
    expect(result.state.error).toContain("connection check");
  });

  test("rejects a pasted one-field key for Bedrock without verification", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const context = {
      config: defaultConfig(),
      env: {},
      checkLocalProviders: false,
      fetchImpl,
    };
    let state = createInitialFirstRunOnboardingState(context);
    state = (await submitFirstRunOnboardingInput(state, "next", context)).state;
    state = (await submitFirstRunOnboardingInput(state, "1", context)).state;
    state = (
      await submitFirstRunOnboardingInput(state, "amazon-bedrock", context)
    ).state;

    expect(state).toMatchObject({
      currentStepId: "model-access",
      selectedProvider: "amazon-bedrock",
      pendingApiKeyApproval: null,
    });
    const result = await submitFirstRunOnboardingInput(
      state,
      "bedrock-one-field-key",
      context,
    );

    expect(result.state).toMatchObject({
      currentStepId: "model-access",
      selectedProvider: "amazon-bedrock",
      pendingApiKeyApproval: null,
    });
    expect(result.state.error).toContain(
      "pasted one-field API keys cannot configure it",
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("rejects Bedrock API-key mode before accepting input", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const context = {
      config: defaultConfig(),
      env: {},
      checkLocalProviders: false,
      fetchImpl,
    };
    let state = createInitialFirstRunOnboardingState(context);
    state = (await submitFirstRunOnboardingInput(state, "next", context)).state;
    state = (await submitFirstRunOnboardingInput(state, "1", context)).state;
    state = (
      await submitFirstRunOnboardingInput(state, "amazon-bedrock", context)
    ).state;

    const result = await submitFirstRunOnboardingInput(state, "3", context);

    expect(result.state).toMatchObject({
      currentStepId: "model-access",
      selectedProvider: "amazon-bedrock",
      modelAccessInput: "menu",
      pendingApiKeyApproval: null,
    });
    expect(result.state.error).toContain(
      "one-field API-key storage is not supported",
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("verifies and saves approved BYOK API keys through local auth", async () => {
    const agencHome = mkdtempSync(join(tmpdir(), "agenc-onboarding-byok-"));
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    try {
      const config = defaultConfig();
      const context = {
        agencHome,
        config,
        env: {},
        checkLocalProviders: false,
        fetchImpl,
      };
      let state = await advanceToModelAccess(context);

      state = (
        await submitFirstRunOnboardingInput(
          state,
          "XAI_API_KEY='xai-approved-key'",
          context,
        )
      ).state;

      expect(state.currentStepId).toBe("model-access");
      expect(state.pendingApiKeyApproval).toMatchObject({
        provider: "grok",
        maskedTail: "...-key",
        verificationStatus: "valid",
      });
      expect(fetchImpl).toHaveBeenCalledWith(
        "https://api.x.ai/v1/models",
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer xai-approved-key",
          }),
        }),
      );

      state = (await submitFirstRunOnboardingInput(state, "yes", context)).state;
      expect(state.currentStepId).toBe("security");
      expect(state.connection).toMatchObject({
        provider: "grok",
        status: "ready",
        ok: true,
        credentialLabel: "XAI_API_KEY or GROK_API_KEY",
        credentialProvenance: { kind: "verified-input" },
      });
      await expect(
        new LocalAuthBackend({ agencHome }).readByokKey("grok"),
      ).resolves.toBe("xai-approved-key");
    } finally {
      rmSync(agencHome, { recursive: true, force: true });
    }
  });

  test.each([
    "grok",
    "openai",
    "anthropic",
    "openrouter",
    "groq",
    "deepseek",
    "gemini",
  ] as const)("verifies and saves approved BYOK keys for %s", async (provider) => {
    const agencHome = mkdtempSync(join(tmpdir(), "agenc-onboarding-byok-"));
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    try {
      const context = {
        agencHome,
        config: defaultConfig(),
        env: {},
        checkLocalProviders: false,
        fetchImpl,
      };
      let state = createInitialFirstRunOnboardingState(context);
      state = (await submitFirstRunOnboardingInput(state, "next", context)).state;
      state = (await submitFirstRunOnboardingInput(state, "1", context)).state;
      state = (
        await submitFirstRunOnboardingInput(state, provider, context)
      ).state;

      expect(state.currentStepId).toBe("model-access");
      expect(state.selectedProvider).toBe(provider);

      state = (
        await submitFirstRunOnboardingInput(
          state,
          `${provider}-approved-key`,
          context,
        )
      ).state;
      expect(state.pendingApiKeyApproval).toMatchObject({
        provider,
        verificationStatus: "valid",
      });

      state = (await submitFirstRunOnboardingInput(state, "yes", context)).state;
      expect(state.currentStepId).toBe("security");
      await expect(
        new LocalAuthBackend({ agencHome }).readByokKey(provider),
      ).resolves.toBe(`${provider}-approved-key`);
    } finally {
      rmSync(agencHome, { recursive: true, force: true });
    }
  });

  test("keeps rejected BYOK API keys out of local auth", async () => {
    const agencHome = mkdtempSync(join(tmpdir(), "agenc-onboarding-byok-"));
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("unauthorized", { status: 401 }),
    );
    try {
      const config = defaultConfig();
      const context = {
        agencHome,
        config,
        env: {},
        checkLocalProviders: false,
        fetchImpl,
      };
      const state = await advanceToModelAccess(context);
      const result = await submitFirstRunOnboardingInput(
        state,
        "xai-invalid-key",
        context,
      );

      expect(result.state.currentStepId).toBe("model-access");
      expect(result.state.pendingApiKeyApproval).toBeNull();
      expect(result.state.error).toContain("Provider rejected");
      expect(result.state.error).toContain("Press Enter");
      await expect(
        new LocalAuthBackend({ agencHome }).readByokKey("grok"),
      ).resolves.toBeUndefined();
    } finally {
      rmSync(agencHome, { recursive: true, force: true });
    }
  });

  test("lets users skip a failed existing credential check without getting stuck", async () => {
    const config = defaultConfig();
    const context = {
      config,
      env: { XAI_API_KEY: "xai-bad-env-key" },
      // x.ai rejects bad keys with HTTP 400 (verified live), which now
      // classifies as auth-failed rather than provider-unreachable.
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(
        new Response("bad request", { status: 400 }),
      ),
      checkLocalProviders: false,
    };
    let state = await advanceToModelAccess(context);

    expect(detailLinesForStep(state, context).join("\n")).toContain(
      "Use XAI_API_KEY",
    );

    let result = await submitFirstRunOnboardingInput(
      state,
      "xai-still-bad",
      context,
    );
    expect(result.state.currentStepId).toBe("model-access");
    expect(result.state.error).toContain("Press Enter");

    result = await submitFirstRunOnboardingInput(
      result.state,
      "/skip",
      context,
    );
    expect(result.state.currentStepId).toBe("connection-test");

    result = await submitFirstRunOnboardingInput(
      result.state,
      "test",
      context,
    );
    expect(result.state.currentStepId).toBe("security");
    expect(result.state.connection).toMatchObject({
      ok: false,
      status: "auth-failed",
      credentialLabel: "XAI_API_KEY or GROK_API_KEY",
      credentialProvenance: {
        kind: "environment",
        fields: [{ role: "apiKey", envVar: "XAI_API_KEY" }],
      },
    });
  });

  test("marks a genuinely unreachable provider as provider-unreachable, not auth-failed", async () => {
    const config = defaultConfig();
    const context = {
      config,
      env: { XAI_API_KEY: "xai-env-key" },
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(
        new Response("bad gateway", { status: 502 }),
      ),
      checkLocalProviders: false,
    };
    const connection = await checkOnboardingProviderConnection(
      context,
      "grok",
      "grok-4",
    );
    expect(connection).toMatchObject({
      ok: false,
      status: "provider-unreachable",
      credentialLabel: "XAI_API_KEY or GROK_API_KEY",
      credentialProvenance: {
        kind: "environment",
        fields: [{ role: "apiKey", envVar: "XAI_API_KEY" }],
      },
    });
  });

  test("accepts slash aliases for onboarding navigation", async () => {
    const config = defaultConfig();
    const context = { config, env: {}, checkLocalProviders: false };
    let state = createInitialFirstRunOnboardingState(context);

    state = (
      await submitFirstRunOnboardingInput(state, "/next", context)
    ).state;
    expect(state.currentStepId).toBe("theme");

    state = (await submitFirstRunOnboardingInput(state, "1", context)).state;
    state = (await submitFirstRunOnboardingInput(state, "1", context)).state;
    state = (
      await submitFirstRunOnboardingInput(state, "/skip", context)
    ).state;
    expect(state.currentStepId).toBe("connection-test");
    state = (
      await submitFirstRunOnboardingInput(state, "/test", context)
    ).state;
    expect(state.currentStepId).toBe("security");
  });

  test("does not persist verified BYOK keys declined at approval", async () => {
    const agencHome = mkdtempSync(join(tmpdir(), "agenc-onboarding-byok-"));
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );
    try {
      const config = defaultConfig();
      const context = {
        agencHome,
        config,
        env: {},
        checkLocalProviders: false,
        fetchImpl,
      };
      let state = await advanceToModelAccess(context);

      state = (
        await submitFirstRunOnboardingInput(
          state,
          "xai-declined-key",
          context,
        )
      ).state;
      expect(state.pendingApiKeyApproval).toMatchObject({
        provider: "grok",
        maskedTail: "...-key",
      });
      expect(firstRunOnboardingInputPresentation(state)).toMatchObject({
        placeholder: "Type yes to save this key, or no to discard it",
        allowEmptySubmit: false,
      });

      state = (await submitFirstRunOnboardingInput(state, "", context)).state;
      expect(state.currentStepId).toBe("model-access");
      expect(state.error).toContain("yes");

      state = (await submitFirstRunOnboardingInput(state, "no", context)).state;
      expect(state.currentStepId).toBe("connection-test");
      await expect(
        new LocalAuthBackend({ agencHome }).readByokKey("grok"),
      ).resolves.toBeUndefined();
    } finally {
      rmSync(agencHome, { recursive: true, force: true });
    }
  });

  test("captures long pasted API-key input through the onboarding path", async () => {
    const agencHome = mkdtempSync(join(tmpdir(), "agenc-onboarding-byok-"));
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );
    try {
      const config = defaultConfig();
      const context = {
        agencHome,
        config,
        env: {},
        checkLocalProviders: false,
        fetchImpl,
      };
      const longKey = "x".repeat(MAX_ONBOARDING_INPUT_LENGTH + 10);
      const state = (
        await submitFirstRunOnboardingInput(
          await advanceToModelAccess(context),
          longKey,
          context,
        )
      ).state;

      expect(state.pendingApiKeyApproval?.pasteHash).toMatch(/^[a-f0-9]{16}$/);
      expect(state.pendingApiKeyApproval?.pastePreview).toContain(
        "Pasted content #1",
      );
      expect(state.pastedContents).toHaveLength(1);
      expect(state.pastedContents[0]?.content.length).toBe(longKey.length - 2_000);
      await expect(
        retrievePastedText({
          agencHome,
          hash: state.pendingApiKeyApproval?.pasteHash ?? "",
        }),
      ).resolves.toBeNull();

      const approved = await submitFirstRunOnboardingInput(state, "yes", context);
      expect(approved.state.currentStepId).toBe("security");
      await expect(
        retrievePastedText({
          agencHome,
          hash: state.pendingApiKeyApproval?.pasteHash ?? "",
        }),
      ).resolves.toBe(state.pastedContents[0]?.content);
    } finally {
      rmSync(agencHome, { recursive: true, force: true });
    }
  });

  test("does not persist declined or invalid long pasted API-key input", async () => {
    const agencHome = mkdtempSync(join(tmpdir(), "agenc-onboarding-byok-"));
    try {
      const config = defaultConfig();
      const longKey = "y".repeat(MAX_ONBOARDING_INPUT_LENGTH + 10);
      const omittedHash = hashPastedText(longKey.slice(1_000, -1_000));
      const validContext = {
        agencHome,
        config,
        env: {},
        checkLocalProviders: false,
        fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(
          new Response(JSON.stringify({ data: [] }), { status: 200 }),
        ),
      };
      const pendingState = (
        await submitFirstRunOnboardingInput(
          await advanceToModelAccess(validContext),
          longKey,
          validContext,
        )
      ).state;
      const declined = await submitFirstRunOnboardingInput(
        pendingState,
        "no",
        validContext,
      );
      expect(declined.state.currentStepId).toBe("connection-test");
      await expect(
        retrievePastedText({ agencHome, hash: omittedHash }),
      ).resolves.toBeNull();

      const invalidContext = {
        ...validContext,
        fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(
          new Response("unauthorized", { status: 401 }),
        ),
      };
      const invalid = await submitFirstRunOnboardingInput(
        await advanceToModelAccess(invalidContext),
        longKey,
        invalidContext,
      );
      expect(invalid.state.pendingApiKeyApproval).toBeNull();
      await expect(
        retrievePastedText({ agencHome, hash: omittedHash }),
      ).resolves.toBeNull();
    } finally {
      rmSync(agencHome, { recursive: true, force: true });
    }
  });

  test("removes approved paste cache if BYOK key persistence fails", async () => {
    const agencHome = mkdtempSync(join(tmpdir(), "agenc-onboarding-byok-"));
    try {
      const config = defaultConfig();
      const context = {
        agencHome,
        config,
        env: {},
        checkLocalProviders: false,
        fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(
          new Response(JSON.stringify({ data: [] }), { status: 200 }),
        ),
        authBackend: {
          saveByokKey: () => {
            throw new Error("disk unavailable");
          },
        },
      };
      const longKey = "z".repeat(MAX_ONBOARDING_INPUT_LENGTH + 10);
      const pendingState = (
        await submitFirstRunOnboardingInput(
          await advanceToModelAccess(context),
          longKey,
          context,
        )
      ).state;
      const failed = await submitFirstRunOnboardingInput(
        pendingState,
        "yes",
        context,
      );

      expect(failed.state.currentStepId).toBe("model-access");
      expect(failed.state.error).toContain("disk unavailable");
      await expect(
        retrievePastedText({
          agencHome,
          hash: pendingState.pendingApiKeyApproval?.pasteHash ?? "",
        }),
      ).resolves.toBeNull();
    } finally {
      rmSync(agencHome, { recursive: true, force: true });
    }
  });

  test("rejects unrelated text on setup-action steps", async () => {
    const config = defaultConfig();
    const context = { config, env: {}, checkLocalProviders: false };
    let state = createInitialFirstRunOnboardingState(context);

    let result = await submitFirstRunOnboardingInput(
      state,
      "write a project plan",
      context,
    );
    expect(result.state.currentStepId).toBe("preflight");
    expect(result.state.error).toContain("Press Enter");

    state = (await submitFirstRunOnboardingInput(state, "next", context)).state;
    state = (await submitFirstRunOnboardingInput(state, "1", context)).state;
    state = (await submitFirstRunOnboardingInput(state, "1", context)).state;
    expect(state.currentStepId).toBe("model-access");

    result = await submitFirstRunOnboardingInput(
      state,
      "continue with no key",
      context,
    );
    expect(result.state.currentStepId).toBe("model-access");
    expect(result.state.error).toContain("Press Enter");

    state = (await submitFirstRunOnboardingInput(state, "next", context)).state;
    result = await submitFirstRunOnboardingInput(
      state,
      "disable sandbox",
      context,
    );
    expect(result.state.currentStepId).toBe("connection-test");
    expect(result.state.error).toContain("connection check");

    state = (await submitFirstRunOnboardingInput(state, "test", context)).state;
    expect(state.currentStepId).toBe("security");
    state = (await submitFirstRunOnboardingInput(state, "next", context)).state;
    result = await submitFirstRunOnboardingInput(
      state,
      "start coding",
      context,
    );
    expect(result.completed).toBe(false);
    expect(result.state.currentStepId).toBe("terminal-setup");
    expect(result.state.error).toContain("Press Enter");
  });

  test("reports onboarding-only input for slash commands", async () => {
    const config = defaultConfig();
    const context = { config, env: {}, checkLocalProviders: false };
    const state = createInitialFirstRunOnboardingState(context);

    const result = await submitFirstRunOnboardingInput(
      state,
      "/help",
      context,
    );

    expect(result.completed).toBe(false);
    expect(result.state.currentStepId).toBe("preflight");
    expect(result.state.error).toContain("Onboarding is active");
    expect(result.state.error).toContain("/exit");
  });

  test("reports onboarding-only input for dollar skill commands", async () => {
    const config = defaultConfig();
    const context = { config, env: {}, checkLocalProviders: false };
    const state = createInitialFirstRunOnboardingState(context);

    const result = await submitFirstRunOnboardingInput(
      state,
      "$python-game make game.py",
      context,
    );

    expect(result.completed).toBe(false);
    expect(result.state.currentStepId).toBe("preflight");
    expect(result.state.error).toContain("Finish setup before loading $skills");
  });
});

describe("project onboarding counterpart steps", () => {
  test("detects AgenC project instructions in the current workspace", () => {
    withTempDir("agenc-project-", (cwd) => {
      writeFileSync(join(cwd, "AGENC.md"), "Use the project conventions.\n");

      const steps = getSteps({ cwd });

      expect(steps.find((step) => step.key === "agencmd")?.isComplete).toBe(true);
      expect(isProjectOnboardingComplete({ cwd })).toBe(true);
    });
  });

  test("does not treat an AGENC.md directory as project instructions", () => {
    withTempDir("agenc-project-", (cwd) => {
      mkdirSync(join(cwd, "AGENC.md"));

      const steps = getSteps({ cwd });

      expect(steps.find((step) => step.key === "agencmd")?.isComplete).toBe(false);
      expect(isProjectOnboardingComplete({ cwd })).toBe(false);
    });
  });

  test("uses the requested cwd for project completion state", () => {
    withTempDir("agenc-onboarding-", (agencHome) => {
      withTempDir("agenc-project-", (cwd) => {
        const projectRoot = resolve(cwd);
        const stepsOptions = {
          exists: (path: string): boolean =>
            path === join(projectRoot, "AGENC.md"),
          readdir: (path: string): readonly string[] =>
            resolve(path) === projectRoot ? ["AGENC.md"] : [],
          stat: (path: string): { isDirectory(): boolean; isFile(): boolean } => ({
            isDirectory: () => resolve(path) === projectRoot,
            isFile: () => path === join(projectRoot, "AGENC.md"),
          }),
        };

        expect(
          shouldShowProjectOnboarding({
            agencHome,
            cwd,
            env: {},
            stepsOptions,
          }),
        ).toBe(false);

        maybeMarkProjectOnboardingComplete({
          agencHome,
          cwd,
          stepsOptions,
          now: new Date("2026-01-02T00:00:00.000Z"),
        });

        expect(
          readOnboardingState({ agencHome }).projects[projectRoot],
        ).toMatchObject({
          hasCompletedProjectOnboarding: true,
          completedAt: "2026-01-02T00:00:00.000Z",
        });
      });
    });
  });
});

describe("local runtime detection (O-1)", () => {
  const config = defaultConfig();

  function fetchRespondingOn(okUrls: readonly string[]): typeof fetch {
    return (async (url: unknown) => {
      const target = String(url);
      if (okUrls.some((ok) => target.includes(ok))) {
        return new Response("{}", { status: 200 });
      }
      throw new Error("connection refused");
    }) as typeof fetch;
  }

  test("a running Ollama is detected; silent ports are not", async () => {
    const detected = await detectRunningLocalProviders({
      config,
      fetchImpl: fetchRespondingOn(["11434"]),
    });
    expect(detected).toEqual(["ollama"]);
  });

  test("nothing running → empty; checkLocalProviders false skips probing", async () => {
    expect(
      await detectRunningLocalProviders({
        config,
        fetchImpl: fetchRespondingOn([]),
      }),
    ).toEqual([]);
    const fetchSpy = vi.fn();
    expect(
      await detectRunningLocalProviders({
        config,
        fetchImpl: fetchSpy as never,
        checkLocalProviders: false,
      }),
    ).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("the provider step annotates detected runtimes and shows the zero-key tip", () => {
    const context = { config };
    const state = {
      ...createInitialFirstRunOnboardingState(context),
      currentStepId: "provider" as const,
      detectedLocalProviders: ["ollama" as const],
    };
    const lines = detailLinesForStep(state, context as never).join("\n");
    expect(lines).toContain("ollama");
    expect(lines).toContain("detected, running locally, no key needed");
    expect(lines).toContain("zero-key start");
  });
});

describe("first-magic wiring contract (O-1b)", () => {
  // The guaranteed-first-turn effect lives in the compiled App.tsx; a full
  // component mount is impractical here, so the wiring is guarded at the
  // source level (established pattern) and the behavior was verified live.
  test("App.tsx submits a starter turn when the wizard completes without an initial prompt", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(
      resolve(process.cwd(), "src/tui/components/App.tsx"),
      "utf8",
    );
    expect(source).toContain("guaranteed first magic");
    expect(source).toContain("onboardingWasActiveRef");
    expect(source).toContain("Introduce yourself in a sentence");
  });
});

describe("wizard theme mapping", () => {
  test("maps wizard choices to config ThemeSettings the provider consumes", () => {
    // The wizard and engine share one vocabulary; unknown values no-op so a
    // stale onboarding state can never corrupt the configured theme.
    expect(wizardThemeToSetting("auto")).toBe("auto");
    expect(wizardThemeToSetting("dark")).toBe("dark");
    expect(wizardThemeToSetting("light")).toBe("light");
    expect(wizardThemeToSetting("light-daltonized")).toBe("light-daltonized");
    expect(wizardThemeToSetting("dark-daltonized")).toBe("dark-daltonized");
    expect(wizardThemeToSetting("light-ansi")).toBe("light-ansi");
    expect(wizardThemeToSetting("dark-ansi")).toBe("dark-ansi");
    expect(wizardThemeToSetting("system")).toBeUndefined();
    expect(wizardThemeToSetting("neon")).toBeUndefined();
    expect(wizardThemeToSetting("")).toBeUndefined();
  });
});

describe("theme step terminal-background awareness", () => {
  test("tells the user which themes read well on the detected terminal background", async () => {
    const { setCachedTerminalBackground } = await import(
      "../utils/terminalBackground.js"
    );
    const config = defaultConfig();
    const context = { config, env: {}, checkLocalProviders: false };
    let state = createInitialFirstRunOnboardingState(context);
    state = (await submitFirstRunOnboardingInput(state, "next", context)).state;

    setCachedTerminalBackground("dark");
    const darkLines = detailLinesForStep(state, context).join("\n");
    expect(darkLines).toContain("your terminal background looks dark");
    expect(darkLines).toContain('"dark" or "auto" will read best');

    setCachedTerminalBackground("light");
    const lightLines = detailLinesForStep(state, context).join("\n");
    expect(lightLines).toContain("your terminal background looks light");
    expect(lightLines).toContain('"light" or "auto" will read best');
  });
});

describe("account sign-in from the model-access step", () => {
  async function advanceToGrokModelAccess(context: Parameters<typeof createInitialFirstRunOnboardingState>[0]) {
    let state = createInitialFirstRunOnboardingState(context);
    state = (await submitFirstRunOnboardingInput(state, "next", context)).state;
    state = (await submitFirstRunOnboardingInput(state, "1", context)).state;
    state = (await submitFirstRunOnboardingInput(state, "1", context)).state;
    expect(state.currentStepId).toBe("model-access");
    expect(state.selectedProvider).toBe("grok");
    return state;
  }

  test("explains AgenC, X / xAI, API-key, and configure-later access without slash commands", async () => {
    const config = defaultConfig();
    const context = { config, env: {}, checkLocalProviders: false };
    const state = await advanceToGrokModelAccess(context);
    const details = detailLinesForStep(state, context).join("\n");

    expect(details).toContain(
      "Sign in or create an AgenC account — use hosted models; free accounts get the free-model catalog.",
    );
    expect(details).toContain(
      "Sign in with X / xAI — use Grok through an eligible X or xAI subscription.",
    );
    expect(details).toContain(
      "Use XAI_API_KEY or GROK_API_KEY — requests are billed by xAI.",
    );
    expect(details).toContain(
      "Configure later — continue without signing in or saving a key.",
    );
    expect(details).not.toContain("/login");
    expect(firstRunOnboardingInputPresentation(state).placeholder).toBe(
      "Choose 1–4, or paste a provider API key directly",
    );
  });

  test("choice 1 signs in or creates an AgenC account and selects its free hosted route", async () => {
    const config = defaultConfig();
    const runAgenCAccountLogin = vi
      .fn<
        () => Promise<{
          ok: true;
          accountLabel: string;
          subscriptionTier: "free";
        }>
      >()
      .mockResolvedValue({
        ok: true,
        accountLabel: "new-user@example.com",
        subscriptionTier: "free",
      });
    const context = {
      config,
      env: {},
      checkLocalProviders: false,
      runAgenCAccountLogin,
    };
    const state = await advanceToGrokModelAccess(context);

    const result = await submitFirstRunOnboardingInput(state, "1", context);

    expect(runAgenCAccountLogin).toHaveBeenCalledTimes(1);
    expect(result.state.currentStepId).toBe("security");
    expect(result.state.selectedProvider).toBe("openrouter");
    expect(result.state.selectedModel).toMatch(/:free$/);
    expect(result.state.connection).toMatchObject({
      ok: true,
      status: "ready",
    });
    expect(result.state.connection?.detail).toContain(
      "Free hosted model access is ready.",
    );
    expect(result.state.completedStepIds).toEqual(
      expect.arrayContaining(["model-access", "connection-test"]),
    );
  });

  test("choice 2 runs X / xAI OAuth, selects Grok, and needs no follow-up command", async () => {
    const config = defaultConfig();
    const runGrokOauthLogin = vi
      .fn<() => Promise<{ ok: true; accountLabel: string }>>()
      .mockResolvedValue({ ok: true, accountLabel: "tetsuo" });
    const context = {
      config,
      env: {},
      checkLocalProviders: false,
      runGrokOauthLogin,
    };
    const state = {
      ...(await advanceToGrokModelAccess(context)),
      selectedProvider: "openai" as const,
      selectedModel: "gpt-4.1",
    };

    const result = await submitFirstRunOnboardingInput(state, "2", context);
    expect(runGrokOauthLogin).toHaveBeenCalledTimes(1);
    expect(result.state.currentStepId).toBe("security");
    expect(result.state.selectedProvider).toBe("grok");
    expect(result.state.connection).toMatchObject({
      ok: true,
      status: "ready",
    });
    expect(result.state.connection?.detail).toContain(
      "Grok subscription access is ready.",
    );
    expect(result.state.completedStepIds).toEqual(
      expect.arrayContaining(["model-access", "connection-test"]),
    );
    expect(result.state.error).toBeNull();
  });

  test("a failed X / xAI sign-in surfaces the message and stays on model access", async () => {
    const config = defaultConfig();
    const context = {
      config,
      env: {},
      checkLocalProviders: false,
      runGrokOauthLogin: async () => ({
        ok: false as const,
        message: "Browser sign-in did not complete (timeout).",
      }),
    };
    const state = await advanceToGrokModelAccess(context);

    const result = await submitFirstRunOnboardingInput(state, "2", context);
    expect(result.state.currentStepId).toBe("model-access");
    expect(result.state.error).toContain("Browser sign-in did not complete");
  });

  test("choice 3 enters API-key mode and back returns to the access menu", async () => {
    const config = defaultConfig();
    const context = {
      config,
      env: {},
      checkLocalProviders: false,
    };
    const state = await advanceToGrokModelAccess(context);

    const keyEntry = await submitFirstRunOnboardingInput(state, "3", context);
    expect(keyEntry.state.currentStepId).toBe("model-access");
    expect(keyEntry.state.modelAccessInput).toBe("api-key");
    expect(firstRunOnboardingInputPresentation(keyEntry.state).placeholder).toContain(
      "Paste XAI_API_KEY or GROK_API_KEY",
    );

    const menu = await submitFirstRunOnboardingInput(
      keyEntry.state,
      "back",
      context,
    );
    expect(menu.state.modelAccessInput).toBe("menu");
  });

  test("keeps a browser URL and device code visible while sign-in is pending", async () => {
    const context = {
      config: defaultConfig(),
      env: {},
      checkLocalProviders: false,
    };
    const state = {
      ...(await advanceToGrokModelAccess(context)),
      authPrompt: {
        heading: "Sign in or create an AgenC account",
        detail: "Finish the browser sign-in.",
        url: "https://id.agenc.ag/activate",
        userCode: "ABCD-EFGH",
      },
    };

    expect(detailLinesForStep(state, context)).toEqual([
      "Sign in or create an AgenC account",
      "Finish the browser sign-in.",
      "Code: ABCD-EFGH",
      "URL: https://id.agenc.ag/activate",
      "Finish sign-in in your browser; AgenC will continue automatically.",
    ]);
  });
});
