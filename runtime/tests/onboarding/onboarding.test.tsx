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
  firstRunOnboardingChoiceCount,
  firstRunOnboardingHighlightedChoice,
  moveFirstRunOnboardingHighlight,
  detectRunningLocalProviders,
  detailLinesForStep,
  firstRunOnboardingInputPresentation,
  setFirstRunOnboardingListFilter,
  submitFirstRunOnboardingInput,
  wizardThemeToSetting,
  type FirstRunOnboardingState,
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
    state = (await submitFirstRunOnboardingInput(state, "1", context)).state;
    state = (await submitFirstRunOnboardingInput(state, "1", context)).state;
    return state;
  }

  test("advances through theme, provider, model access, and ready", async () => {
    const config = defaultConfig();
    const context = { config, env: {}, checkLocalProviders: false };
    let state = createInitialFirstRunOnboardingState(context);

    expect(state.currentStepId).toBe("theme");
    expect(state.selectedProvider).toBe("grok");

    state = (await submitFirstRunOnboardingInput(state, "1", context)).state;
    expect(state.selectedTheme).toBe("auto");
    expect(state.currentStepId).toBe("provider");

    state = (await submitFirstRunOnboardingInput(state, "1", context)).state;
    expect(state.selectedProvider).toBe("grok");
    expect(state.currentStepId).toBe("model-access");

    // The key option checks what is configured first; with no xAI key
    // anywhere it opens the paste field instead of a dead end.
    state = (await submitFirstRunOnboardingInput(state, "", context)).state;
    expect(state.currentStepId).toBe("model-access");
    expect(state.modelAccessInput).toBe("api-key");
    expect(state.connection?.status).toBe("credentials-required");
    expect(state.connection?.credentialLabel).toBe(
      "XAI_API_KEY or GROK_API_KEY",
    );

    // Enter in the paste field means set up later.
    state = (await submitFirstRunOnboardingInput(state, "", context)).state;
    expect(state.currentStepId).toBe("ready");
    expect(state.connection).toBeNull();

    const result = await submitFirstRunOnboardingInput(state, "done", context);
    expect(result.completed).toBe(true);
    expect(result.state.completedStepIds).toEqual(
      expect.arrayContaining(["theme", "provider", "model-access", "ready"]),
    );
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
      placeholder: "Enter keeps dark",
      allowEmptySubmit: true,
    });
    state = (await submitFirstRunOnboardingInput(state, "", context)).state;
    expect(state.currentStepId).toBe("provider");

    state = (await submitFirstRunOnboardingInput(state, "", context)).state;
    expect(state.currentStepId).toBe("model-access");

    state = (await submitFirstRunOnboardingInput(state, "", context)).state;
    expect(state.modelAccessInput).toBe("api-key");

    state = (await submitFirstRunOnboardingInput(state, "", context)).state;
    expect(state.currentStepId).toBe("ready");
    expect(firstRunOnboardingInputPresentation(state)).toMatchObject({
      placeholder: "Enter starts AgenC",
      allowEmptySubmit: true,
    });

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
        status: "credentials-required",
        detail:
          "xAI sign-in credentials are bound to the first-party xAI API endpoint. Select API-key mode to use a custom Grok base URL, or unset the base URL override.",
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

  test("reaches every canonical built-in provider, eight rows at a time around the highlight", () => {
    const context = { config: defaultConfig(), env: {} };
    let state: FirstRunOnboardingState = {
      ...createInitialFirstRunOnboardingState(context),
      currentStepId: "provider",
    };
    const all = listBuiltInProviderInfo().map((provider) => provider.name);
    const highlighted: string[] = [];
    for (let index = 0; index < all.length; index += 1) {
      const lines = detailLinesForStep(state, context);
      const rows = lines.filter((line) => /^[› ] \S/u.test(line));
      const more = lines.filter((line) => /^[↑↓] \d+ more$/u.test(line));
      expect(rows.length).toBeLessThanOrEqual(8);
      // Visible rows plus the collapsed counts always add up to every provider.
      expect(
        rows.length +
          more.reduce((sum, line) => sum + Number(line.split(" ")[1]), 0),
      ).toBe(all.length);
      const selected = rows.filter((line) => line.startsWith("› "));
      expect(selected).toHaveLength(1);
      // The name, then two spaces before the status.
      highlighted.push(selected[0]!.slice(2).split("  ")[0]!);
      state = moveFirstRunOnboardingHighlight(state, 1);
    }
    expect([...highlighted].sort()).toEqual([...all].sort());
  });

  test.each([
    "grok",
    "openai",
    "anthropic",
    "openrouter",
    "groq",
    "deepseek",
    "meta",
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
        // The configured provider stays highlighted; the paid account's
        // managed route (OpenRouter) lists as connected, above it.
        const providerLines = detailLinesForStep(
          { ...state, currentStepId: "provider" },
          context,
        );
        expect(providerLines).toContain("› xAI Grok  not set");
        expect(providerLines[1]).toBe("  OpenRouter  AgenC account");
        expect(
          detailLinesForStep(
            { ...state, currentStepId: "model-access" },
            context,
          ).join("\n"),
        ).toContain("AgenC account  sign in for hosted models, free plan");
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
      modelAccessInput: "result" as const,
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

    expect(lines).toContain("✓ grok answered. XAI_API_KEY works.");
    expect(lines.join("\n")).not.toContain("add it later");
    expect(lines.join("\n")).not.toContain("Paste");
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
    expect(lines).toContain("GEMINI_ACCESS_TOKEN  set GEMINI_ACCESS_TOKEN first");
    expect(lines).not.toContain("paste a key");

    // The key option checks first and shows why it cannot work, with no
    // paste follow-up: a pasted key cannot override the forced mode.
    const result = await submitFirstRunOnboardingInput(state, "1", context);
    expect(result.state).toMatchObject({
      currentStepId: "model-access",
      modelAccessInput: "result",
      canPasteKey: false,
      error: null,
    });
    expect(result.state.connection?.ok).toBe(false);
    const followUps = detailLinesForStep(result.state, context).join("\n");
    expect(followUps).toContain("Choose again");
    expect(followUps).not.toContain("Paste a key");

    const pasted = await submitFirstRunOnboardingInput(
      { ...state, modelAccessInput: "api-key" as const },
      "AIzaSyForcedModeCannotUseThis",
      context,
    );
    expect(pasted.state.error).toContain(
      "A pasted API key cannot override GEMINI_AUTH_MODE=access-token",
    );
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
      "GEMINI_ACCESS_TOKEN  configured, check it now",
    );
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
      currentStepId: "ready" as const,
    };

    const lines = detailLinesForStep(state, context);

    expect(lines).toContain("Mode: bypassPermissions, approvals off");
    expect(lines).toContain("Approvals are off for this run.");
    // The configured sandbox may not be the one in effect under a bypass
    // flag, so the card does not claim one.
    expect(lines.join("\n")).not.toContain("Sandbox:");
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

    let result = await submitFirstRunOnboardingInput(state, "sepia", context);
    expect(result.state.currentStepId).toBe("theme");
    expect(result.state.error).toContain("Choose");

    state = (await submitFirstRunOnboardingInput(state, "1", context)).state;
    result = await submitFirstRunOnboardingInput(state, "missing-provider", context);
    expect(result.state.currentStepId).toBe("provider");
    expect(result.state.error).toContain("provider");

    state = (await submitFirstRunOnboardingInput(state, "1", context)).state;
    // A short word on the menu is a mistyped choice, never sent as a key.
    result = await submitFirstRunOnboardingInput(state, "hello", context);
    expect(result.state.error).toBe("Choose 1 to 4, or paste a key.");
    expect(fetchImpl).not.toHaveBeenCalled();

    result = await submitFirstRunOnboardingInput(
      state,
      "not-a-real-key-0123456789",
      context,
    );
    expect(result.state.currentStepId).toBe("model-access");
    expect(result.state.error).toContain("press Enter to set up later");
    expect(fetchImpl).toHaveBeenCalledOnce();

    state = (await submitFirstRunOnboardingInput(state, "later", context)).state;
    expect(state.currentStepId).toBe("ready");
    result = await submitFirstRunOnboardingInput(state, "start coding", context);
    expect(result.completed).toBe(false);
    expect(result.state.error).toBe("Press Enter to start AgenC.");
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
    state = (await submitFirstRunOnboardingInput(state, "1", context)).state;
    state = (
      await submitFirstRunOnboardingInput(state, "amazon-bedrock", context)
    ).state;

    expect(state).toMatchObject({
      currentStepId: "model-access",
      selectedProvider: "amazon-bedrock",
    });
    const result = await submitFirstRunOnboardingInput(
      state,
      "bedrock-one-field-key",
      context,
    );

    expect(result.state).toMatchObject({
      currentStepId: "model-access",
      selectedProvider: "amazon-bedrock",
    });
    expect(result.state.error).toContain(
      "pasted one-field API keys cannot configure it",
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("checks Bedrock AWS credentials instead of asking for a pasted key", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const context = {
      config: defaultConfig(),
      env: {},
      checkLocalProviders: false,
      fetchImpl,
    };
    let state = createInitialFirstRunOnboardingState(context);
    state = (await submitFirstRunOnboardingInput(state, "1", context)).state;
    state = (
      await submitFirstRunOnboardingInput(state, "amazon-bedrock", context)
    ).state;

    expect(detailLinesForStep(state, context).join("\n")).toContain(
      "AWS credentials",
    );
    const result = await submitFirstRunOnboardingInput(state, "1", context);

    expect(result.state).toMatchObject({
      currentStepId: "model-access",
      selectedProvider: "amazon-bedrock",
      modelAccessInput: "result",
      canPasteKey: false,
      error: null,
    });
    expect(result.state.connection).toMatchObject({
      ok: false,
      status: "credentials-required",
    });
    expect(detailLinesForStep(result.state, context).join("\n")).not.toContain(
      "Paste a key",
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("verifies a pasted BYOK key, saves it through local auth, and lists the models", async () => {
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

      expect(fetchImpl).toHaveBeenCalledWith(
        "https://api.x.ai/v1/models",
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer xai-approved-key",
          }),
        }),
      );
      // A key the provider accepts is saved right away; the card moves on to
      // the provider's models with no separate yes or no.
      expect(state.currentStepId).toBe("model-access");
      expect(state.modelAccessInput).toBe("models");
      const card = detailLinesForStep(state, context);
      expect(card[0]).toBe("Which xAI Grok model should AgenC use?");
      expect(card).toContain("✓ grok accepted the key, and it is saved.");
      expect(card).toContain("› grok-4.6  default");
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
      state = (await submitFirstRunOnboardingInput(state, "", context)).state;
      expect(state.currentStepId).toBe("ready");
      expect(state.selectedModel).toBe("grok-4.6");
      expect(detailLinesForStep(state, context)).toContain(
        "Access: pasted key, saved",
      );
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
    "meta",
    "gemini",
  ] as const)("verifies and saves BYOK keys for %s once the provider accepts them", async (provider) => {
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
      expect(["models", "result"]).toContain(state.modelAccessInput);
      expect(state.connection?.ok).toBe(true);
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
        "xai-invalid-key-0000",
        context,
      );

      expect(result.state.currentStepId).toBe("model-access");
      expect(result.state.modelAccessInput).toBe("menu");
      expect(result.state.error).toContain("Provider rejected");
      expect(result.state.error).toContain("Paste another key");
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
    let state = createInitialFirstRunOnboardingState(context);
    state = (await submitFirstRunOnboardingInput(state, "1", context)).state;
    expect(detailLinesForStep(state, context)).toContain(
      "› xAI Grok  env XAI_API_KEY",
    );

    // Picking a provider whose key is already set checks it right away; the
    // provider rejects it and the card says so, with ways forward.
    let result = await submitFirstRunOnboardingInput(state, "", context);
    expect(result.state).toMatchObject({
      currentStepId: "model-access",
      modelAccessInput: "result",
      canPasteKey: true,
    });
    const card = detailLinesForStep(result.state, context);
    expect(card).toContain("✗ grok rejected XAI_API_KEY.");
    expect(card).toEqual(
      expect.arrayContaining(["› Paste a key", "  Choose again", "  Continue without a model"]),
    );

    result = await submitFirstRunOnboardingInput(
      result.state,
      "/skip",
      context,
    );
    expect(result.state.currentStepId).toBe("ready");
    expect(detailLinesForStep(result.state, context)).toContain(
      "Access: not working yet",
    );
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
    expect(state.currentStepId).toBe("provider");

    state = (await submitFirstRunOnboardingInput(state, "1", context)).state;
    // /test runs the readiness check, like choosing the key option.
    const tested = (
      await submitFirstRunOnboardingInput(state, "/test", context)
    ).state;
    expect(tested.modelAccessInput).toBe("api-key");
    state = (
      await submitFirstRunOnboardingInput(state, "/skip", context)
    ).state;
    expect(state.currentStepId).toBe("ready");
    const done = await submitFirstRunOnboardingInput(state, "/done", context);
    expect(done.completed).toBe(true);
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

      // The provider accepted it, so the key and its paste are saved at once.
      expect(state.error).toBeNull();
      expect(["models", "result"]).toContain(state.modelAccessInput);
      expect(state.pastedContents).toHaveLength(1);
      expect(state.pastedContents[0]?.content.length).toBe(longKey.length - 2_000);
      await expect(
        retrievePastedText({
          agencHome,
          hash: hashPastedText(state.pastedContents[0]?.content ?? ""),
        }),
      ).resolves.toBe(state.pastedContents[0]?.content);
    } finally {
      rmSync(agencHome, { recursive: true, force: true });
    }
  });

  test("does not persist an invalid long pasted API-key input", async () => {
    const agencHome = mkdtempSync(join(tmpdir(), "agenc-onboarding-byok-"));
    try {
      const config = defaultConfig();
      const longKey = "y".repeat(MAX_ONBOARDING_INPUT_LENGTH + 10);
      const omittedHash = hashPastedText(longKey.slice(1_000, -1_000));
      const invalidContext = {
        agencHome,
        config,
        env: {},
        checkLocalProviders: false,
        fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(
          new Response("unauthorized", { status: 401 }),
        ),
      };
      const invalid = await submitFirstRunOnboardingInput(
        await advanceToModelAccess(invalidContext),
        longKey,
        invalidContext,
      );
      expect(invalid.state.error).toContain("Paste another key");
      await expect(
        retrievePastedText({ agencHome, hash: omittedHash }),
      ).resolves.toBeNull();
    } finally {
      rmSync(agencHome, { recursive: true, force: true });
    }
  });

  test("removes the saved paste if BYOK key persistence fails", async () => {
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
      const failed = await submitFirstRunOnboardingInput(
        await advanceToModelAccess(context),
        longKey,
        context,
      );

      expect(failed.state.currentStepId).toBe("model-access");
      expect(failed.state.modelAccessInput).toBe("menu");
      expect(failed.state.error).toContain("disk unavailable");
      await expect(
        retrievePastedText({
          agencHome,
          hash: hashPastedText(longKey.slice(1_000, -1_000)),
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
    expect(result.state.currentStepId).toBe("theme");
    expect(result.state.error).toContain("Choose a theme");

    state = (await submitFirstRunOnboardingInput(state, "1", context)).state;
    state = (await submitFirstRunOnboardingInput(state, "1", context)).state;
    expect(state.currentStepId).toBe("model-access");

    result = await submitFirstRunOnboardingInput(
      state,
      "continue with no key",
      context,
    );
    expect(result.state.currentStepId).toBe("model-access");
    expect(result.state.error).toContain("press Enter to set up later");

    state = (await submitFirstRunOnboardingInput(state, "later", context)).state;
    result = await submitFirstRunOnboardingInput(
      state,
      "start coding",
      context,
    );
    expect(result.completed).toBe(false);
    expect(result.state.currentStepId).toBe("ready");
    expect(result.state.error).toBe("Press Enter to start AgenC.");
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
    expect(result.state.currentStepId).toBe("theme");
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
    expect(result.state.currentStepId).toBe("theme");
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
    const lines = detailLinesForStep(state, context as never);
    // A running runtime counts as connected, so it moves to the top.
    expect(lines[1]).toMatch(/^[› ] Ollama  running$/u);
    expect(lines).toContain(
      "Ollama is running on this machine. Pick it to start without a key.",
    );
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
    const state = createInitialFirstRunOnboardingState(context);

    setCachedTerminalBackground("dark");
    const darkLines = detailLinesForStep(state, context).join("\n");
    expect(darkLines).toContain("your terminal looks dark");
    expect(darkLines).toContain('"dark" or "auto" will read best');

    setCachedTerminalBackground("light");
    const lightLines = detailLinesForStep(state, context).join("\n");
    expect(lightLines).toContain("your terminal looks light");
    expect(lightLines).toContain('"light" or "auto" will read best');
  });
});

describe("account sign-in from the model-access step", () => {
  async function advanceToGrokModelAccess(context: Parameters<typeof createInitialFirstRunOnboardingState>[0]) {
    let state = createInitialFirstRunOnboardingState(context);
    state = (await submitFirstRunOnboardingInput(state, "1", context)).state;
    state = (await submitFirstRunOnboardingInput(state, "1", context)).state;
    expect(state.currentStepId).toBe("model-access");
    expect(state.selectedProvider).toBe("grok");
    return state;
  }

  test("lists the key, AgenC account, X / xAI and set-up-later options for Grok", async () => {
    const config = defaultConfig();
    const context = { config, env: {}, checkLocalProviders: false };
    const state = await advanceToGrokModelAccess(context);

    expect(detailLinesForStep(state, context)).toEqual([
      "How should AgenC reach grok / grok-4.6?",
      "› XAI_API_KEY  paste a key next",
      "  AgenC account  sign in for hosted models, free plan",
      "  X / xAI account  sign in to use Grok with your subscription",
      "  Set up later  AgenC can't answer until you do",
      "You can also paste a key here.",
    ]);
    expect(firstRunOnboardingInputPresentation(state).placeholder).toBe(
      "Choose an option, or paste a key",
    );
  });

  test("offers X / xAI sign-in only for Grok", async () => {
    const config = defaultConfig();
    const context = { config, env: {}, checkLocalProviders: false };
    const state = {
      ...(await advanceToGrokModelAccess(context)),
      selectedProvider: "deepseek" as const,
      selectedModel: "deepseek-flash",
    };

    const details = detailLinesForStep(state, context).join("\n");
    expect(details).toContain("DEEPSEEK_API_KEY  paste a key next");
    expect(details).not.toContain("X / xAI");
    expect(firstRunOnboardingChoiceCount(state)).toBe(3);

    const result = await submitFirstRunOnboardingInput(state, "xai", context);
    expect(result.state.error).toBe(
      "X / xAI sign-in is for Grok. Pick grok in the provider step to use it.",
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

    const result = await submitFirstRunOnboardingInput(state, "2", context);

    expect(runAgenCAccountLogin).toHaveBeenCalledTimes(1);
    expect(result.state.currentStepId).toBe("model-access");
    expect(result.state.modelAccessInput).toBe("result");
    expect(result.state.selectedProvider).toBe("openrouter");
    expect(result.state.selectedModel).toMatch(/:free$/);
    expect(result.state.connection).toMatchObject({
      ok: true,
      status: "ready",
    });
    expect(result.state.connection?.detail).toContain(
      "Free hosted model access is ready.",
    );
    const next = await submitFirstRunOnboardingInput(result.state, "", context);
    expect(next.state.currentStepId).toBe("ready");
    expect(detailLinesForStep(next.state, context)).toContain(
      "Access: AgenC account",
    );
  });

  test("choice 3 runs X / xAI sign-in, then lists Grok's models", async () => {
    const config = defaultConfig();
    const runProviderSignIn = vi
      .fn<(provider: "openai" | "grok") => Promise<{ ok: true; accountLabel: string }>>()
      .mockResolvedValue({ ok: true, accountLabel: "tetsuo" });
    const context = {
      config,
      env: {},
      checkLocalProviders: false,
      runProviderSignIn,
    };
    const state = await advanceToGrokModelAccess(context);

    const result = await submitFirstRunOnboardingInput(state, "3", context);
    expect(runProviderSignIn).toHaveBeenCalledExactlyOnceWith("grok");
    expect(result.state.currentStepId).toBe("model-access");
    expect(result.state.modelAccessInput).toBe("models");
    expect(result.state.selectedProvider).toBe("grok");
    expect(result.state.connection).toMatchObject({
      ok: true,
      status: "ready",
    });
    expect(result.state.connection?.detail).toContain(
      "Grok subscription access is ready.",
    );
    expect(result.state.error).toBeNull();
    expect(detailLinesForStep(result.state, context)).toContain(
      "✓ Signed in to X / xAI as tetsuo.",
    );

    const done = await submitFirstRunOnboardingInput(result.state, "", context);
    expect(done.state.currentStepId).toBe("ready");
    expect(detailLinesForStep(done.state, context)).toContain(
      "Access: X / xAI sign-in",
    );
  });

  test("OpenAI offers ChatGPT sign-in, and picking a model finishes the step", async () => {
    const runProviderSignIn = vi
      .fn<(provider: "openai" | "grok") => Promise<{ ok: true; accountLabel: string }>>()
      .mockResolvedValue({ ok: true, accountLabel: "paul@example.com" });
    const context = {
      config: defaultConfig(),
      env: {},
      checkLocalProviders: false,
      runProviderSignIn,
    };
    let state = createInitialFirstRunOnboardingState(context);
    state = (await submitFirstRunOnboardingInput(state, "1", context)).state;
    state = (await submitFirstRunOnboardingInput(state, "openai", context)).state;
    expect(detailLinesForStep(state, context)).toEqual([
      "How should AgenC reach openai / gpt-5?",
      "› OPENAI_API_KEY  paste a key next",
      "  AgenC account  sign in for hosted models, free plan",
      "  ChatGPT account  sign in to use OpenAI with your plan",
      "  Set up later  AgenC can't answer until you do",
      "You can also paste a key here.",
    ]);

    state = (await submitFirstRunOnboardingInput(state, "chatgpt", context)).state;
    expect(runProviderSignIn).toHaveBeenCalledExactlyOnceWith("openai");
    expect(state.modelAccessInput).toBe("models");
    const card = detailLinesForStep(state, context);
    expect(card[0]).toBe("Which OpenAI model should AgenC use?");
    expect(card).toContain("✓ Signed in to ChatGPT as paul@example.com.");
    expect(card).toContain("› gpt-5  default");

    // Typing narrows the list; Enter picks the highlighted match.
    const narrowed = setFirstRunOnboardingListFilter(state, "luna");
    expect(detailLinesForStep(narrowed, context).filter((line) => /^[› ] gpt/u.test(line)))
      .toEqual(["› gpt-5.6-luna", "  gpt-6-luna"]);
    const picked = await submitFirstRunOnboardingInput(narrowed, "luna", context);
    expect(picked.state).toMatchObject({
      currentStepId: "ready",
      selectedProvider: "openai",
      selectedModel: "gpt-5.6-luna",
    });
    expect(detailLinesForStep(picked.state, context)).toContain(
      "Access: ChatGPT sign-in",
    );
  });

  test("ChatGPT sign-in is refused for other providers", async () => {
    const context = { config: defaultConfig(), env: {}, checkLocalProviders: false };
    const state = await advanceToGrokModelAccess(context);
    const result = await submitFirstRunOnboardingInput(state, "chatgpt", context);
    expect(result.state.error).toBe(
      "ChatGPT sign-in is for OpenAI. Pick OpenAI in the provider step to use it.",
    );
  });

  test("a failed X / xAI sign-in surfaces the message and stays on model access", async () => {
    const config = defaultConfig();
    const context = {
      config,
      env: {},
      checkLocalProviders: false,
      runProviderSignIn: async () => ({
        ok: false as const,
        message: "Browser sign-in did not complete (timeout).",
      }),
    };
    const state = await advanceToGrokModelAccess(context);

    const result = await submitFirstRunOnboardingInput(state, "3", context);
    expect(result.state.currentStepId).toBe("model-access");
    expect(result.state.error).toContain("Browser sign-in did not complete");
  });

  test("the key option opens the paste field when no key is set, and back returns to the menu", async () => {
    const config = defaultConfig();
    const context = {
      config,
      env: {},
      checkLocalProviders: false,
    };
    const state = await advanceToGrokModelAccess(context);

    const keyEntry = await submitFirstRunOnboardingInput(state, "1", context);
    expect(keyEntry.state.currentStepId).toBe("model-access");
    expect(keyEntry.state.modelAccessInput).toBe("api-key");
    expect(firstRunOnboardingInputPresentation(keyEntry.state).placeholder).toBe(
      "Paste XAI_API_KEY",
    );
    expect(detailLinesForStep(keyEntry.state, context)).toEqual([
      "Paste your XAI_API_KEY.",
      "No XAI_API_KEY is set yet.",
      "AgenC checks the key with the provider, then saves it on this computer.",
    ]);

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
      "Finish sign-in in your browser. AgenC continues on its own.",
    ]);
  });
});

describe("model access checks in place", () => {
  const okFetch = () =>
    vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

  test("a provider whose key is already set is checked when picked, then lists its models", async () => {
    const fetchImpl = okFetch();
    const context = {
      config: defaultConfig(),
      env: { XAI_API_KEY: "xai-env-key-that-works" },
      checkLocalProviders: false,
      fetchImpl,
    };
    let state = createInitialFirstRunOnboardingState(context);
    state = (await submitFirstRunOnboardingInput(state, "", context)).state;
    expect(detailLinesForStep(state, context)[1]).toBe("› xAI Grok  env XAI_API_KEY");

    state = (await submitFirstRunOnboardingInput(state, "", context)).state;
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(state).toMatchObject({
      currentStepId: "model-access",
      modelAccessInput: "models",
    });
    const card = detailLinesForStep(state, context);
    expect(card.slice(0, 2)).toEqual([
      "Which xAI Grok model should AgenC use?",
      "✓ grok answered. XAI_API_KEY works.",
    ]);
    expect(card).toContain("› grok-4.6  default");
    expect(firstRunOnboardingChoiceCount(state)).toBe(state.modelChoices.length);
    expect(firstRunOnboardingInputPresentation(state).placeholder).toBe(
      "Enter picks grok-4.6, or type to filter",
    );

    // Down then Enter picks the next model.
    state = moveFirstRunOnboardingHighlight(state, 1);
    state = (await submitFirstRunOnboardingInput(state, "", context)).state;
    expect(state.currentStepId).toBe("ready");
    expect(state.selectedModel).toBe(state.modelChoices[1]);
    expect(detailLinesForStep(state, context)).toContain(
      "Access: XAI_API_KEY, checked",
    );
  });

  test("a local runtime that does not answer offers choose again or continue, never paste", async () => {
    const context = {
      config: {
        ...defaultConfig(),
        model_provider: "ollama" as const,
        model: "llama3.3",
      },
      env: {},
      fetchImpl: vi
        .fn<typeof fetch>()
        .mockRejectedValue(new Error("connection refused")),
    };
    let state: FirstRunOnboardingState = {
      ...createInitialFirstRunOnboardingState(context),
      currentStepId: "model-access",
    };
    expect(detailLinesForStep(state, context)).toContain(
      "› This machine  no key needed, check it is running",
    );
    expect(detailLinesForStep(state, context).join("\n")).not.toContain(
      "paste",
    );

    state = (await submitFirstRunOnboardingInput(state, "", context)).state;
    expect(state).toMatchObject({ modelAccessInput: "result", canPasteKey: false });
    expect(detailLinesForStep(state, context)).toEqual([
      "How should AgenC reach ollama / llama3.3?",
      "✗ Local provider endpoint did not respond; start it before the first model turn.",
      "› Choose again",
      "  Continue without a model",
    ]);

    const again = (await submitFirstRunOnboardingInput(state, "1", context)).state;
    expect(again).toMatchObject({ modelAccessInput: "menu", connection: null });

    const onward = (await submitFirstRunOnboardingInput(state, "2", context)).state;
    expect(onward.currentStepId).toBe("ready");
    expect(detailLinesForStep(onward, context)).toContain(
      "Access: not working yet",
    );
  });

  test("a running local server without the default model lists the models it has", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({ models: [{ name: "qwen3:8b" }, { name: "gemma3:4b" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const context = { config: defaultConfig(), env: {}, fetchImpl };
    const state: FirstRunOnboardingState = {
      ...createInitialFirstRunOnboardingState(context),
      currentStepId: "provider",
      detectedLocalProviders: ["ollama"],
    };
    const result = await submitFirstRunOnboardingInput(state, "ollama", context);
    expect(result.state).toMatchObject({
      currentStepId: "model-access",
      selectedProvider: "ollama",
      modelAccessInput: "models",
      modelChoices: ["qwen3:8b", "gemma3:4b"],
    });
    const picked = await submitFirstRunOnboardingInput(result.state, "2", context);
    expect(picked.state).toMatchObject({
      currentStepId: "ready",
      selectedModel: "gemma3:4b",
    });
  });

  test("typing narrows the provider list without echoing the text", async () => {
    const context = { config: defaultConfig(), env: {}, checkLocalProviders: false };
    let state: FirstRunOnboardingState = {
      ...createInitialFirstRunOnboardingState(context),
      currentStepId: "provider",
    };
    state = setFirstRunOnboardingListFilter(state, "deep");
    expect(detailLinesForStep(state, context)).toEqual([
      "Which provider should AgenC use?",
      "› DeepSeek  not set",
      "Enter picks the highlighted provider.",
    ]);
    expect(firstRunOnboardingChoiceCount(state)).toBe(1);

    const missing = setFirstRunOnboardingListFilter(state, "sk-not-a-provider");
    expect(detailLinesForStep(missing, context).join("\n")).not.toContain("sk-not");
    const refused = await submitFirstRunOnboardingInput(missing, "sk-not-a-provider", context);
    expect(refused.state.currentStepId).toBe("provider");
    expect(refused.state.error).not.toContain("sk-not");

    const picked = await submitFirstRunOnboardingInput(state, "deep", context);
    expect(picked.state).toMatchObject({
      currentStepId: "model-access",
      selectedProvider: "deepseek",
    });
  });

  test("back on the model-access menu returns to the provider list", async () => {
    const context = { config: defaultConfig(), env: {}, checkLocalProviders: false };
    let state = createInitialFirstRunOnboardingState(context);
    state = (await submitFirstRunOnboardingInput(state, "", context)).state;
    state = (await submitFirstRunOnboardingInput(state, "", context)).state;
    const result = await submitFirstRunOnboardingInput(state, "back", context);
    expect(result.state.currentStepId).toBe("provider");
    expect(result.state.error).toBeNull();
  });

  test("the Ready card summarizes the setup before AgenC starts", () => {
    const context = {
      config: defaultConfig(),
      env: {},
      cwd: "/work/shop",
      permissionMode: "default",
      sandboxMode: "workspace-write",
    };
    const state = {
      ...createInitialFirstRunOnboardingState(context),
      currentStepId: "ready" as const,
    };
    expect(detailLinesForStep(state, context)).toEqual([
      "AgenC is set up for this machine.",
      "Theme: dark",
      "Model: grok / grok-4.6",
      "Access: not set up yet",
      "Mode: default, asks before tools that need it",
      "Sandbox: workspace-write, limits writes to this workspace",
      "Workspace: /work/shop",
      "Change these later with /config, /model and Shift+Tab.",
    ]);
  });

  test("no setup card or prompt uses an em dash", async () => {
    const context = {
      config: defaultConfig(),
      env: {},
      checkLocalProviders: false,
      permissionMode: "bypassPermissions",
    };
    const base = createInitialFirstRunOnboardingState(context);
    const connection = {
      provider: "grok",
      model: "grok-4.6",
      status: "auth-failed" as const,
      ok: false,
      detail: "Provider rejected XAI_API_KEY.",
    };
    const states = [
      base,
      { ...base, currentStepId: "provider" as const, detectedLocalProviders: ["ollama" as const] },
      ...(["grok", "deepseek", "ollama", "amazon-bedrock", "gemini", "agenc"] as const).map(
        (selectedProvider) => ({
          ...base,
          currentStepId: "model-access" as const,
          selectedProvider,
        }),
      ),
      { ...base, currentStepId: "model-access" as const, modelAccessInput: "api-key" as const },
      { ...base, currentStepId: "model-access" as const, modelAccessInput: "result" as const, connection, canPasteKey: true },
      { ...base, currentStepId: "model-access" as const, modelAccessInput: "result" as const, connection: { ...connection, ok: true, status: "ready" as const } },
      { ...base, currentStepId: "ready" as const },
    ];
    for (const state of states) {
      const text = [
        ...detailLinesForStep(state, context),
        ...Object.values(firstRunOnboardingInputPresentation(state)).map(String),
      ].join("\n");
      expect(text).not.toContain("\u2014");
    }
  });
});

describe("first-run onboarding arrow-key selection", () => {
  const context = { config: defaultConfig(), env: {}, checkLocalProviders: false };

  async function atStep(step: "theme" | "provider" | "model-access") {
    let state = createInitialFirstRunOnboardingState(context);
    if (step === "theme") return state;
    state = (await submitFirstRunOnboardingInput(state, "", context)).state;
    if (step === "provider") return state;
    return (await submitFirstRunOnboardingInput(state, "", context)).state;
  }

  test("steps without a list ignore the arrows", () => {
    const state = {
      ...createInitialFirstRunOnboardingState(context),
      currentStepId: "ready" as const,
    };
    expect(firstRunOnboardingChoiceCount(state)).toBe(0);
    expect(moveFirstRunOnboardingHighlight(state, 1)).toBe(state);
  });

  test("the default highlight is the current theme, and Enter without a move keeps it", async () => {
    const state = await atStep("theme");
    const lines = detailLinesForStep(state, context);
    const current = firstRunOnboardingHighlightedChoice(state)!;
    // Line 0 is the question; choices follow in order.
    expect(lines[current]).toMatch(/^› \S+ .*\(current\)$/u);
    const next = (await submitFirstRunOnboardingInput(state, "", context)).state;
    expect(next.selectedTheme).toBe(state.selectedTheme);
    expect(next.currentStepId).toBe("provider");
  });

  test("down then Enter picks the next theme, wrapping at the end", async () => {
    let state = await atStep("theme");
    const count = firstRunOnboardingChoiceCount(state);
    const start = firstRunOnboardingHighlightedChoice(state)!;
    state = moveFirstRunOnboardingHighlight(state, 1);
    expect(state.highlightedChoice).toBe((start % count) + 1);
    expect(detailLinesForStep(state, context)[state.highlightedChoice!]).toMatch(/^› /u);
    for (let i = 0; i < count; i += 1) state = moveFirstRunOnboardingHighlight(state, 1);
    expect(state.highlightedChoice).toBe((start % count) + 1);
    const expectedTheme = detailLinesForStep(state, context)[state.highlightedChoice!]!
      .slice(2).split(" ")[0];
    const next = (await submitFirstRunOnboardingInput(state, "", context)).state;
    expect(next.selectedTheme).toBe(expectedTheme);
    expect(next.highlightedChoice).toBeNull();
  });

  test("up from the first provider wraps to the last and Enter selects it with its default model", async () => {
    let state = await atStep("provider");
    expect(firstRunOnboardingHighlightedChoice(state)).toBe(1);
    state = moveFirstRunOnboardingHighlight(state, -1);
    const count = firstRunOnboardingChoiceCount(state);
    expect(state.highlightedChoice).toBe(count);
    // Rows show the display name, then two spaces before the status.
    const lastName = detailLinesForStep(state, context)
      .find((line) => line.startsWith("› "))!
      .slice(2).split("  ")[0];
    const lastProvider = listBuiltInProviderInfo().find((info) => info.name === lastName)?.id;
    const next = (await submitFirstRunOnboardingInput(state, "", context)).state;
    expect(next.selectedProvider).toBe(lastProvider);
    expect(next.currentStepId).toBe("model-access");
  });

  test("the model-access menu defaults to the provider key and an arrow move changes what Enter does", async () => {
    let state = await atStep("model-access");
    expect(firstRunOnboardingChoiceCount(state)).toBe(4);
    expect(firstRunOnboardingHighlightedChoice(state)).toBe(1);
    state = moveFirstRunOnboardingHighlight(state, -1);
    expect(state.highlightedChoice).toBe(4);
    const next = (await submitFirstRunOnboardingInput(state, "", context)).state;
    expect(next.currentStepId).toBe("ready");
  });

  test("a typed number still wins over the highlight", async () => {
    let state = await atStep("theme");
    state = moveFirstRunOnboardingHighlight(state, 1);
    const next = (await submitFirstRunOnboardingInput(state, "1", context)).state;
    expect(next.selectedTheme).toBe(detailLinesForStep(await atStep("theme"), context)[1]!
      .slice(2).split(" ")[0]);
  });
});
