import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test, vi } from "vitest";

import { defaultConfig } from "../config/schema.js";
import { LocalAuthBackend } from "../auth/backends/local.js";
import { MAX_ONBOARDING_INPUT_LENGTH } from "./inputPaste.js";
import { hashPastedText, retrievePastedText } from "./pasteStore.js";

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
  async function advanceToApiKey(
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
    expect(state.selectedTheme).toBe("dark");
    expect(state.currentStepId).toBe("provider");

    state = (await submitFirstRunOnboardingInput(state, "1", context)).state;
    expect(state.selectedProvider).toBe("grok");
    expect(state.currentStepId).toBe("api-key");

    state = (await submitFirstRunOnboardingInput(state, "next", context)).state;
    expect(state.currentStepId).toBe("connection-test");

    state = (await submitFirstRunOnboardingInput(state, "test", context)).state;
    expect(state.currentStepId).toBe("security");
    expect(state.connection?.status).toBe("needs-key");
    expect(state.connection?.keyEnvVar).toBe("XAI_API_KEY");

    state = (await submitFirstRunOnboardingInput(state, "next", context)).state;
    expect(state.currentStepId).toBe("terminal-setup");
    const result = await submitFirstRunOnboardingInput(state, "done", context);
    expect(result.completed).toBe(true);
    expect(result.state.completedStepIds).toContain("terminal-setup");
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
      keyEnvVar: "XAI_API_KEY",
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
      status: "needs-key",
      keyEnvVar: "XAI_API_KEY",
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
      keyEnvVar: "XAI_API_KEY",
    });

    await expect(
      checkOnboardingProviderConnection(
        {
          config,
          env: {},
          fetchImpl: async () => ({ ok: true }) as Response,
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

  test("treats signed-in remote auth as managed provider readiness", async () => {
    const agencHome = mkdtempSync(join(tmpdir(), "agenc-onboarding-remote-auth-"));
    try {
      writeFileSync(
        join(agencHome, "auth.json"),
        JSON.stringify({
          version: 1,
          provider: "remote",
          token: "remote-session-token",
          subscriptionTier: "pro",
          createdAt: "2026-01-01T00:00:00.000Z",
        }),
      );

      await expect(
        checkOnboardingProviderConnection(
          {
            config: defaultConfig(),
            env: { AGENC_HOME: agencHome },
          },
          "openrouter",
          "x-ai/grok-4.3",
        ),
      ).resolves.toMatchObject({
        ok: true,
        status: "ready",
        detail: "AgenC Pro is signed in. Hosted OpenRouter model access is ready.",
      });
    } finally {
      rmSync(agencHome, { recursive: true, force: true });
    }
  });

  test("starts Pro signed-in users on hosted OpenRouter instead of direct Grok", () => {
    const agencHome = mkdtempSync(join(tmpdir(), "agenc-onboarding-pro-default-"));
    try {
      writeFileSync(
        join(agencHome, "auth.json"),
        JSON.stringify({
          version: 1,
          provider: "remote",
          token: "remote-session-token",
          subscriptionTier: "pro",
          createdAt: "2026-01-01T00:00:00.000Z",
        }),
      );

      const context = {
        config: defaultConfig(),
        env: { AGENC_HOME: agencHome },
      };
      const state = createInitialFirstRunOnboardingState(context);

      expect(state.selectedProvider).toBe("openrouter");
      expect(state.selectedModel).toBe("x-ai/grok-4.5");
      expect(detailLinesForStep({ ...state, currentStepId: "provider" }, context)[0]).toBe(
        "1. openrouter (current)",
      );
      expect(detailLinesForStep({ ...state, currentStepId: "api-key" }, context)).toContain(
        "Your Pro account can use hosted model access here. Type next to verify it.",
      );
    } finally {
      rmSync(agencHome, { recursive: true, force: true });
    }
  });

  test("requires BYOK during onboarding when remote auth is free", async () => {
    const agencHome = mkdtempSync(join(tmpdir(), "agenc-onboarding-free-auth-"));
    try {
      writeFileSync(
        join(agencHome, "auth.json"),
        JSON.stringify({
          version: 1,
          provider: "remote",
          token: "remote-session-token",
          subscriptionTier: "free",
          createdAt: "2026-01-01T00:00:00.000Z",
        }),
      );

      const context = {
        config: defaultConfig(),
        env: { AGENC_HOME: agencHome },
      };
      await expect(
        checkOnboardingProviderConnection(
          context,
          "openrouter",
          "x-ai/grok-4.3",
        ),
      ).resolves.toMatchObject({
        ok: false,
        status: "needs-key",
        keyEnvVar: "OPENROUTER_API_KEY",
        canSkip: false,
      });

      const state = {
        ...createInitialFirstRunOnboardingState(context),
        currentStepId: "api-key" as const,
        selectedProvider: "openrouter" as const,
        selectedModel: "x-ai/grok-4.3",
        connection: {
          provider: "openrouter",
          model: "x-ai/grok-4.3",
          status: "needs-key" as const,
          ok: false,
          detail: "AgenC account is signed in on the free plan.",
          keyEnvVar: "OPENROUTER_API_KEY",
          canSkip: false,
        },
      };

      const result = await submitFirstRunOnboardingInput(state, "next", context);

      expect(result.completed).toBe(false);
      expect(result.state.currentStepId).toBe("api-key");
      expect(result.state.error).toContain("OPENROUTER_API_KEY is required");
    } finally {
      rmSync(agencHome, { recursive: true, force: true });
    }
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
      currentStepId: "api-key" as const,
      connection: {
        provider: "grok",
        model: "grok-4.3",
        status: "ready" as const,
        ok: true,
        detail: "Provider credential found via XAI_API_KEY.",
        keyEnvVar: "XAI_API_KEY",
      },
    };

    const lines = detailLinesForStep(state, context);

    expect(lines).toContain("Provider credential found via XAI_API_KEY.");
    expect(lines).toContain(
      "XAI_API_KEY is present and verified. Type next to continue, or paste a replacement key.",
    );
    expect(lines.join("\n")).not.toContain("add it later");
  });

  test("makes --yolo permission and sandbox behavior explicit", () => {
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
      "Permission mode: bypassPermissions (--yolo skips tool approval prompts).",
    );
    expect(lines).toContain(
      "Sandbox: danger-full-access (--yolo disables workspace sandboxing for this session).",
    );
    expect(lines.join("\n")).not.toContain("Sandbox: workspace-write");
    expect(lines).toContain(
      "Type next to continue with --yolo, or restart without --yolo for prompts and sandboxing.",
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
    result = await submitFirstRunOnboardingInput(state, "later", context);
    expect(result.state.currentStepId).toBe("api-key");
    expect(result.state.error).toContain("next or skip");
    expect(fetchImpl).toHaveBeenCalledOnce();

    state = (await submitFirstRunOnboardingInput(state, "next", context)).state;
    result = await submitFirstRunOnboardingInput(state, "later", context);
    expect(result.state.currentStepId).toBe("connection-test");
    expect(result.state.error).toContain("connection check");
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
      let state = await advanceToApiKey(context);

      state = (
        await submitFirstRunOnboardingInput(
          state,
          "XAI_API_KEY='xai-approved-key'",
          context,
        )
      ).state;

      expect(state.currentStepId).toBe("api-key");
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

      expect(state.currentStepId).toBe("api-key");
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
      const state = await advanceToApiKey(context);
      const result = await submitFirstRunOnboardingInput(
        state,
        "xai-invalid-key",
        context,
      );

      expect(result.state.currentStepId).toBe("api-key");
      expect(result.state.pendingApiKeyApproval).toBeNull();
      expect(result.state.error).toContain("Provider rejected");
      expect(result.state.error).toContain("next or skip");
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
    let state = await advanceToApiKey(context);

    expect(detailLinesForStep(state, context).join("\n")).toContain(
      "Paste XAI_API_KEY",
    );

    let result = await submitFirstRunOnboardingInput(
      state,
      "xai-still-bad",
      context,
    );
    expect(result.state.currentStepId).toBe("api-key");
    expect(result.state.error).toContain("next or skip");

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
      keyEnvVar: "XAI_API_KEY",
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
      keyEnvVar: "XAI_API_KEY",
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
      let state = await advanceToApiKey(context);

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
          await advanceToApiKey(context),
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
          await advanceToApiKey(validContext),
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
        await advanceToApiKey(invalidContext),
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
          await advanceToApiKey(context),
          longKey,
          context,
        )
      ).state;
      const failed = await submitFirstRunOnboardingInput(
        pendingState,
        "yes",
        context,
      );

      expect(failed.state.currentStepId).toBe("api-key");
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

  test("requires explicit commands for command-only steps", async () => {
    const config = defaultConfig();
    const context = { config, env: {}, checkLocalProviders: false };
    let state = createInitialFirstRunOnboardingState(context);

    let result = await submitFirstRunOnboardingInput(
      state,
      "write a project plan",
      context,
    );
    expect(result.state.currentStepId).toBe("preflight");
    expect(result.state.error).toContain("Type next");

    state = (await submitFirstRunOnboardingInput(state, "next", context)).state;
    state = (await submitFirstRunOnboardingInput(state, "1", context)).state;
    state = (await submitFirstRunOnboardingInput(state, "1", context)).state;
    expect(state.currentStepId).toBe("api-key");

    result = await submitFirstRunOnboardingInput(
      state,
      "continue with no key",
      context,
    );
    expect(result.state.currentStepId).toBe("api-key");
    expect(result.state.error).toContain("Type next");

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
    expect(result.state.error).toContain("Type done");
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
        return { ok: true, status: 200, json: async () => ({}) } as Response;
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
    // The theme step's choice must reach the live theme engine: "system" is
    // the wizard's word for the engine's "auto"; unknown values no-op so a
    // stale onboarding state can never corrupt the configured theme.
    expect(wizardThemeToSetting("dark")).toBe("dark");
    expect(wizardThemeToSetting("light")).toBe("light");
    expect(wizardThemeToSetting("system")).toBe("auto");
    expect(wizardThemeToSetting("neon")).toBeUndefined();
    expect(wizardThemeToSetting("")).toBeUndefined();
  });
});

describe("theme step terminal-background awareness", () => {
  test("tells the user which themes read well on the detected terminal background", async () => {
    const { setCachedSystemTheme } = await import("../utils/systemTheme.js");
    const config = defaultConfig();
    const context = { config, env: {}, checkLocalProviders: false };
    let state = createInitialFirstRunOnboardingState(context);
    state = (await submitFirstRunOnboardingInput(state, "next", context)).state;

    setCachedSystemTheme("dark");
    const darkLines = detailLinesForStep(state, context).join("\n");
    expect(darkLines).toContain("your terminal background looks dark");
    expect(darkLines).toContain('"dark" or "system" will read best');

    setCachedSystemTheme("light");
    const lightLines = detailLinesForStep(state, context).join("\n");
    expect(lightLines).toContain("your terminal background looks light");
    expect(lightLines).toContain('"light" or "system" will read best');
  });
});

describe("grok OAuth sign-in from the api-key step", () => {
  async function advanceToGrokApiKey(context: Parameters<typeof createInitialFirstRunOnboardingState>[0]) {
    let state = createInitialFirstRunOnboardingState(context);
    state = (await submitFirstRunOnboardingInput(state, "next", context)).state;
    state = (await submitFirstRunOnboardingInput(state, "1", context)).state;
    state = (await submitFirstRunOnboardingInput(state, "1", context)).state;
    expect(state.currentStepId).toBe("api-key");
    expect(state.selectedProvider).toBe("grok");
    return state;
  }

  test("offers the keyless X / xAI sign-in for grok only", async () => {
    const config = defaultConfig();
    const context = { config, env: {}, checkLocalProviders: false };
    const grokState = await advanceToGrokApiKey(context);
    expect(detailLinesForStep(grokState, context).join("\n")).toContain(
      "Or type login to sign in with your X / xAI account",
    );

    const openaiState = {
      ...grokState,
      selectedProvider: "openai" as const,
      connection: null,
    };
    expect(detailLinesForStep(openaiState, context).join("\n")).not.toContain(
      "Or type login",
    );
  });

  test("login runs the injected OAuth flow and advances to the connection test", async () => {
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
    const state = await advanceToGrokApiKey(context);

    const result = await submitFirstRunOnboardingInput(state, "login", context);
    expect(runGrokOauthLogin).toHaveBeenCalledTimes(1);
    expect(result.state.currentStepId).toBe("connection-test");
    expect(result.state.completedStepIds).toContain("api-key");
    expect(result.state.error).toBeNull();
  });

  test("a failed sign-in surfaces the message and stays on the api-key step", async () => {
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
    const state = await advanceToGrokApiKey(context);

    const result = await submitFirstRunOnboardingInput(state, "login", context);
    expect(result.state.currentStepId).toBe("api-key");
    expect(result.state.error).toContain("Browser sign-in did not complete");
  });

  test("login on a non-grok provider is treated as a key attempt, not a sign-in", async () => {
    const config = defaultConfig();
    const runGrokOauthLogin = vi.fn();
    const context = {
      config,
      env: {},
      checkLocalProviders: false,
      runGrokOauthLogin,
      fetchImpl: (async () =>
        new Response("unauthorized", { status: 401 })) as typeof fetch,
    };
    let state = await advanceToGrokApiKey(context);
    state = { ...state, selectedProvider: "openai" as const };

    const result = await submitFirstRunOnboardingInput(state, "login", context);
    expect(runGrokOauthLogin).not.toHaveBeenCalled();
    expect(result.state.currentStepId).toBe("api-key");
    expect(result.state.error).not.toBeNull();
  });
});
