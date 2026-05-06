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
  submitFirstRunOnboardingInput,
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
        selectedModel: "grok-4-fast",
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
    state = (await submitFirstRunOnboardingInput(state, "test", context)).state;
    return state;
  }

  test("advances through provider selection, connection check, and completion", async () => {
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
    expect(state.currentStepId).toBe("connection-test");

    state = (await submitFirstRunOnboardingInput(state, "test", context)).state;
    expect(state.currentStepId).toBe("api-key");
    expect(state.connection?.status).toBe("needs-key");
    expect(state.connection?.keyEnvVar).toBe("XAI_API_KEY");

    state = (await submitFirstRunOnboardingInput(state, "next", context)).state;
    expect(state.currentStepId).toBe("security");
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
        "grok-4-fast",
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
        "grok-4-fast",
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
        "grok-4-fast",
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

  test("rejects invalid theme, provider, and connection-test input", async () => {
    const config = defaultConfig();
    const context = { config, env: {}, checkLocalProviders: false };
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
      await expect(
        new LocalAuthBackend({ agencHome }).readByokKey("grok"),
      ).resolves.toBeUndefined();
    } finally {
      rmSync(agencHome, { recursive: true, force: true });
    }
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
      expect(state.currentStepId).toBe("security");
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
      expect(declined.state.currentStepId).toBe("security");
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
    state = (await submitFirstRunOnboardingInput(state, "test", context)).state;
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
    expect(result.state.currentStepId).toBe("security");
    expect(result.state.error).toContain("Type next");

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
