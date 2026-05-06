import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";

import { defaultConfig } from "../config/schema.js";

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
  markFirstRunOnboardingComplete,
  readOnboardingState,
  shouldShowFirstRunOnboarding,
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
    await expect(
      checkOnboardingProviderConnection(
        { config, env: { XAI_API_KEY: "xai-test-key" } },
        "grok",
        "grok-4-fast",
      ),
    ).resolves.toMatchObject({
      ok: true,
      status: "ready",
      keyEnvVar: "XAI_API_KEY",
    });

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
});
