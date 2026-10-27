import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";
import {
  modelCommand,
  applyModelSwitch,
  checkModelHistoryCompat,
} from "./model.js";
import { modelMenuFallback, readModelMenuSnapshot } from "./model-menu-snapshot.js";
import {
  recordOpenRouterZdrEndpoints,
  resetOpenRouterZdrEndpointsForTesting,
} from "../llm/registry/openrouter-zdr-endpoints.js";
import { applyProviderSwitch, switchProviderModel } from "./provider.js";
import type { EnvSnapshot } from "../config/env.js";
import { resolveHomeContext, type HomeContext } from "../config/home.js";
import type { ConfigStore } from "../config/store.js";
import type { Session } from "../session/session.js";
import { getSecureStorage } from "../utils/secureStorage/index.js";
import { saveXaiOauthCredentials } from "../utils/xaiOauthCredentials.js";
import type {
  SlashCommandAppStateBridge,
  SlashCommandContext,
} from "./types.js";

const TEST_ENVIRONMENT: EnvSnapshot = Object.freeze({
  AGENC_HOME: "/tmp/agenc-model-command-test",
});
const TEST_HOME = resolveHomeContext(TEST_ENVIRONMENT, {
  platformHome: "/tmp",
});

type CommandConfigStore = Pick<ConfigStore, "current" | "homeContext">;

interface CommandAuthority {
  readonly configStore: CommandConfigStore;
  readonly environment: EnvSnapshot;
}

function commandConfigStore(
  homeContext: HomeContext = TEST_HOME,
  config: unknown = {},
): CommandConfigStore {
  return {
    homeContext,
    current: () => config as ReturnType<ConfigStore["current"]>,
  };
}

interface StubSessionOpts {
  provider?: string;
  model?: string;
  activeTurn?: unknown;
  abortTerminal?: ReturnType<typeof vi.fn>;
  pendingProviderSwitch?: unknown;
  history?: unknown[];
  reasoningEffort?: string;
  configStore?: CommandConfigStore;
  environment?: EnvSnapshot;
  providerServiceSelection?: {
    readonly provider?: unknown;
    readonly model?: unknown;
  };
}

function stubSession(opts: StubSessionOpts = {}): Session {
  const sessionConfiguration = {
    provider: { slug: opts.provider ?? "grok" },
    collaborationMode: {
      model: opts.model ?? "grok-4.6",
      ...(opts.reasoningEffort !== undefined
        ? { reasoningEffort: opts.reasoningEffort }
        : {}),
    },
  };
  const abortTerminal = opts.abortTerminal ?? vi.fn();
  const s: {
    state: { unsafePeek: () => unknown };
    activeTurn: { unsafePeek: () => unknown };
    abortTerminal: ReturnType<typeof vi.fn>;
    pendingProviderSwitch: unknown;
    services: {
      configStore: CommandConfigStore;
      providerEnvironment: EnvSnapshot;
      providerService?: {
        current: () => {
          readonly provider?: unknown;
          readonly model?: unknown;
        };
      };
    };
    setPendingProviderSwitch(next: unknown): void;
  } = {
    state: {
      unsafePeek: () => ({
        sessionConfiguration,
        history: opts.history ?? [],
      }),
    },
    activeTurn: { unsafePeek: () => opts.activeTurn ?? null },
    abortTerminal,
    pendingProviderSwitch: opts.pendingProviderSwitch ?? null,
    services: {
      configStore: opts.configStore ?? commandConfigStore(),
      providerEnvironment: opts.environment ?? TEST_ENVIRONMENT,
      ...(opts.providerServiceSelection !== undefined
        ? {
            providerService: {
              current: () => opts.providerServiceSelection!,
            },
          }
        : {}),
    },
    setPendingProviderSwitch(next) {
      this.pendingProviderSwitch = next;
    },
  };
  return s as unknown as Session;
}

function mkctx(
  session: Session,
  argsRaw = "",
  appState?: SlashCommandAppStateBridge,
): SlashCommandContext {
  return {
    session,
    argsRaw,
    cwd: "/ws",
    home: "/home/test",
    ...(appState ? { appState } : {}),
  };
}

async function withProAuthSession<T>(
  fn: (authority: CommandAuthority) => T | Promise<T>,
): Promise<T> {
  const agencHome = mkdtempSync(join(tmpdir(), "agenc-model-pro-"));
  const environment: EnvSnapshot = Object.freeze({ AGENC_HOME: agencHome });
  const homeContext = resolveHomeContext(environment, {
    platformHome: tmpdir(),
  });
  const createdAt = "2026-08-24T00:00:00.000Z";
  const storage = getSecureStorage(homeContext);
  const update = storage.update({
    remoteAuth: { bearerToken: "test-token", createdAt },
  });
  if (!update.success) {
    throw new Error(update.warning ?? "failed to create native auth fixture");
  }
  writeFileSync(
    join(agencHome, "auth.json"),
    JSON.stringify({
      version: 1,
      provider: "remote",
      createdAt,
      expiresAt: "2099-01-01T00:00:00.000Z",
      subscriptionTier: "pro",
    }),
  );
  try {
    return await fn({
      environment,
      configStore: commandConfigStore(homeContext, {
        auth: { managedKeys: { enabled: true } },
      }),
    });
  } finally {
    storage.delete();
    rmSync(agencHome, { recursive: true, force: true });
  }
}

describe("checkModelHistoryCompat", () => {
  it("allows switching when the target model can satisfy current history requirements", () => {
    const session = stubSession({
      provider: "grok",
      history: [
        {
          role: "user",
          content: [
            { type: "text", text: "look at this" },
            { type: "image_url", image_url: { url: "file:///tmp/image.png" } },
          ],
        },
      ],
    });

    const result = checkModelHistoryCompat(session, "grok-4.7");
    expect(result).toEqual({ compatible: true, missingCapabilities: [] });
  });

  it("blocks switching when the target model cannot accept image-bearing history", () => {
    const session = stubSession({
      provider: "openrouter",
      history: [
        {
          role: "user",
          content: [
            { type: "text", text: "look at this" },
            { type: "image_url", image_url: { url: "file:///tmp/image.png" } },
          ],
        },
      ],
    });

    const result = checkModelHistoryCompat(session, "openai/gpt-oss-120b");
    expect(result.compatible).toBe(false);
    expect(result.missingCapabilities).toEqual(["image history"]);
    expect(result.reason).toMatch(/openrouter \/ openai\/gpt-oss-120b/);
  });

  it("does not refuse a switch over reasoning effort", () => {
    const session = stubSession({
      provider: "grok",
      model: "grok-4.7",
      reasoningEffort: "high",
      configStore: commandConfigStore(TEST_HOME, {
        providers: { grok: { capability_overrides: { acceptsReasoningEffort: false } } },
      }),
    });

    // The switch drops a level the model rejects and says so
    // (tests/session/reasoning-effort-for-model.test.ts).
    expect(checkModelHistoryCompat(session, "grok-4.7")).toEqual({
      compatible: true,
      missingCapabilities: [],
    });
  });
});

describe("Bedrock profile switch compatibility", () => {
  it("checks a configured application profile as the Claude model it serves", () => {
    const profile =
      "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/a1b2c3d4e5f6";
    const session = (config: unknown) => stubSession({
      provider: "amazon-bedrock",
      model: "amazon.nova-pro-v1:0",
      reasoningEffort: "max",
      configStore: commandConfigStore(TEST_HOME, config),
    });
    expect(
      checkModelHistoryCompat(
        session({ modelOverrides: { "claude-opus-5-5": profile } }),
        profile,
        "amazon-bedrock",
      ),
    ).toEqual({ compatible: true, missingCapabilities: [] });
    // Unmapped, the profile cannot take the effort; the switch drops it
    // instead of refusing (tests/session/reasoning-effort-for-model.test.ts).
    expect(checkModelHistoryCompat(session({}), profile, "amazon-bedrock")).toEqual({
      compatible: true,
      missingCapabilities: [],
    });
  });
});

describe("Gemini effort switch compatibility", () => {
  it.each([
    ["grok", "grok-4.6", "xhigh", "gemini", "gemini-3.1-pro-preview"],
    ["gemini", "gemini-3.5-flash", "minimal", "gemini", "gemini-3.1-pro-preview"],
    ["gemini", "gemini-3.1-pro-preview", "medium", "gemini", "gemini-2.5-pro"],
    ["gemini", "gemini-3.5-flash", "minimal", "grok", "grok-4.6"],
    ["gemini", "gemini-3.1-pro-preview", "high", "gemini", "gemini-2.5-flash"],
    ["gemini", "gemini-3.5-flash", "medium", "gemini", "gemma-4-31b-it"],
  ] as const)("switches %s/%s at %s to %s/%s, which does not take it", async (provider, model, reasoningEffort, targetProvider, targetModel) => {
    const session = stubSession({ provider, model, reasoningEffort });
    expect(checkModelHistoryCompat(session, targetModel, targetProvider).compatible).toBe(true);
    const outcome = await applyModelSwitch(session, targetModel, targetProvider);
    expect(outcome).toMatchObject({ applied: true, provider: targetProvider, model: targetModel });
  });
});

describe("modelCommand", () => {
  it("is userInvocable and immediate", () => {
    expect(modelCommand.userInvocable).toBe(true);
    expect(modelCommand.immediate).toBe(true);
    expect(modelCommand.name).toBe("model");
  });

  it("returns a model list when args are empty outside the TUI", async () => {
    const session = stubSession();
    const res = await modelCommand.execute(mkctx(session, ""));
    expect(res.kind).toBe("text");
    if (res.kind === "text") {
      expect(res.text).toContain("Model selection");
      expect(res.text).toContain("Provider: grok");
      expect(res.text).toContain("grok-4.6");
    }
  });

  it("opens the local model menu when args are empty in the TUI", async () => {
    const session = stubSession();
    const setToolJSX = vi.fn();
    const res = await modelCommand.execute(
      mkctx(session, "", {
        getAppState: () => ({ mainLoopModel: "grok-4.6" }),
        setToolJSX,
      }),
    );
    expect(res.kind).toBe("skip");
    expect(setToolJSX).toHaveBeenCalledTimes(1);
    expect(setToolJSX.mock.calls[0]?.[0]).toMatchObject({
      isLocalJSXCommand: true,
      shouldHidePromptInput: true,
    });
  });

  it("uses the ConfigStore home for xAI OAuth when the session environment has no home", async () => {
    const agencHome = mkdtempSync(join(tmpdir(), "agenc-model-xai-oauth-"));
    const home = resolveHomeContext(
      { AGENC_HOME: agencHome },
      { platformHome: tmpdir() },
    );
    try {
      expect(
        saveXaiOauthCredentials(home, {
          accessToken: "model-command-oauth-token",
          expiresAt: Date.now() + 60_000,
        }).success,
      ).toBe(true);
      const session = stubSession({
        provider: "grok",
        model: "grok-4.6",
        configStore: commandConfigStore(home, {
          auth: { managedKeys: { enabled: true } },
        }),
        environment: Object.freeze({}),
      });
      const setToolJSX = vi.fn();

      await modelCommand.execute(mkctx(session, "", { setToolJSX }));
      const payload = setToolJSX.mock.calls[0]?.[0] as {
        jsx?: { props?: { initialProvider?: string } };
      };
      expect(payload.jsx?.props?.initialProvider).toBe("grok");
      // The screen switches through the same path; the current pair is a no-op.
      await expect(
        switchProviderModel(mkctx(session, ""), "grok", "grok-4.6"),
      ).resolves.toMatchObject({
        applied: false,
        unchanged: true,
        message: "Provider unchanged: grok/grok-4.6.",
      });
      expect(
        (session as unknown as { pendingProviderSwitch: unknown })
          .pendingProviderSwitch,
      ).toBeNull();

      const result = await modelCommand.execute(
        mkctx(session, "grok:grok-4.5"),
      );
      expect(result).toEqual({
        kind: "text",
        text: expect.stringContaining('Model switched to "grok-4.5"'),
      });
      expect(
        (session as unknown as { pendingProviderSwitch: unknown })
          .pendingProviderSwitch,
      ).toEqual({ provider: "grok", model: "grok-4.5" });
    } finally {
      rmSync(agencHome, { recursive: true, force: true });
    }
  });

  it("opens the providers screen on the current provider and routes its choices through provider-model authority", async () => {
    const session = stubSession({ provider: "grok", model: "grok-4.6" });
    const setToolJSX = vi.fn();

    const res = await modelCommand.execute(
      mkctx(session, "", { setToolJSX }),
    );

    expect(res.kind).toBe("skip");
    const payload = setToolJSX.mock.calls[0]?.[0] as {
      jsx?: { props?: { initialProvider?: string } };
    };
    expect(payload.jsx?.props?.initialProvider).toBe("grok");
    await expect(
      switchProviderModel(mkctx(session, ""), "grok", "gpt-5"),
    ).resolves.toMatchObject({
      applied: false,
      message: expect.stringContaining(
        "belongs to provider 'openai', not explicitly selected provider 'grok'",
      ),
    });
    expect(
      (session as unknown as { pendingProviderSwitch: unknown })
        .pendingProviderSwitch,
    ).toBeNull();
  });

  it("applies the switch immediately when no turn is active", async () => {
    const session = stubSession({
      provider: "grok",
      model: "grok-4.6",
      activeTurn: null,
    });
    const res = await modelCommand.execute(mkctx(session, "grok-4.7"));
    expect(res.kind).toBe("text");
    if (res.kind === "text") {
      expect(res.text).toMatch(/grok-4.7/);
      expect(res.text).toMatch(/was "grok\/grok-4.6"/);
    }
    const pending = (
      session as unknown as {
        pendingProviderSwitch: { provider: string; model: string } | null;
      }
    ).pendingProviderSwitch;
    expect(pending).toEqual({ provider: "grok", model: "grok-4.7" });
  });

  it("refuses an OpenRouter model with no zero-retention endpoint while ZDR is on, with the way out", async () => {
    const environment = { ...TEST_ENVIRONMENT, OPENROUTER_API_KEY: "sk-or-test" } as EnvSnapshot;
    recordOpenRouterZdrEndpoints({ data: [{ model_id: "x-ai/grok-4.5" }] });
    try {
      const refused = stubSession({ provider: "grok", model: "grok-4.6", activeTurn: null, environment });
      const res = await modelCommand.execute(mkctx(refused, "openrouter:google/gemini-2.5-flash"));
      expect(res).toEqual({
        kind: "text",
        text: "No zero-retention endpoint serves openrouter/google/gemini-2.5-flash, so OpenRouter would refuse it. " +
          "To use it, set zero_data_retention = false under [providers.openrouter].",
      });
      expect((refused as unknown as { pendingProviderSwitch: unknown }).pendingProviderSwitch).toBeNull();

      // A model with an endpoint switches as usual.
      const allowed = stubSession({ provider: "grok", model: "grok-4.6", activeTurn: null, environment });
      await modelCommand.execute(mkctx(allowed, "openrouter:x-ai/grok-4.5"));
      expect((allowed as unknown as { pendingProviderSwitch: unknown }).pendingProviderSwitch)
        .toEqual({ provider: "openrouter", model: "x-ai/grok-4.5" });

      // With zero data retention turned off nothing is refused.
      const optedOut = stubSession({
        provider: "grok",
        model: "grok-4.6",
        activeTurn: null,
        environment,
        configStore: commandConfigStore(TEST_HOME, { providers: { openrouter: { zero_data_retention: false } } }),
      });
      await modelCommand.execute(mkctx(optedOut, "openrouter:google/gemini-2.5-flash"));
      expect((optedOut as unknown as { pendingProviderSwitch: unknown }).pendingProviderSwitch)
        .toEqual({ provider: "openrouter", model: "google/gemini-2.5-flash" });
    } finally {
      resetOpenRouterZdrEndpointsForTesting();
    }
  });

  it("can switch provider and model from provider-qualified input", async () => {
    const session = stubSession({
      provider: "grok",
      model: "grok-4.6",
      activeTurn: null,
    });

    const res = await modelCommand.execute(mkctx(session, "openai:gpt-5"));

    expect(res.kind).toBe("text");
    if (res.kind === "text") {
      expect(res.text).toMatch(/openai/);
      expect(res.text).toMatch(/gpt-5/);
    }
    const pending = (
      session as unknown as {
        pendingProviderSwitch: { provider: string; model: string } | null;
      }
    ).pendingProviderSwitch;
    expect(pending).toEqual({ provider: "openai", model: "gpt-5" });
  });

  it("stores provider-qualified Copilot input as one provider-local pair", async () => {
    const session = stubSession({ provider: "grok", model: "grok-4.6" });

    const res = await modelCommand.execute(
      mkctx(session, "github:gpt-5.3-codex"),
    );

    expect(res.kind).toBe("text");
    expect(
      (session as unknown as { pendingProviderSwitch: unknown })
        .pendingProviderSwitch,
    ).toEqual({ provider: "github", model: "gpt-5.3-codex" });
  });

  it("resolves a known bare model without inheriting the current provider", async () => {
    const session = stubSession({ provider: "grok", model: "grok-4.6" });

    const res = await modelCommand.execute(mkctx(session, "gpt-5"));

    expect(res.kind).toBe("text");
    expect(
      (session as unknown as { pendingProviderSwitch: unknown })
        .pendingProviderSwitch,
    ).toEqual({ provider: "openai", model: "gpt-5" });
  });

  it.each(["xyz", "deepseek-flsh", "deepseek:deepseek-flsh", "deepseek-flahs"])(
    "refuses %s without changing the pending model, effort, or chrome", async (input) => {
      const session = stubSession({
        provider: "deepseek", model: "deepseek-flash", reasoningEffort: "high",
        pendingProviderSwitch: { provider: "deepseek", model: "deepseek-v4-pro" },
        activeTurn: {},
      });
      const before = structuredClone(session.state.unsafePeek());
      const setAppState = vi.fn();
      const res = await modelCommand.execute(mkctx(session, input, { setAppState }));
      expect(res).toMatchObject({ kind: "text", text: expect.stringMatching(/blocked:.*[Dd]id you mean 'deepseek-flash'/u) });
      expect(session.pendingProviderSwitch).toEqual({ provider: "deepseek", model: "deepseek-v4-pro" });
      expect(session.state.unsafePeek()).toEqual(before);
      expect(setAppState).not.toHaveBeenCalled();
      expect(session.abortTerminal).not.toHaveBeenCalled();
    },
  );

  it.each(["deepseek-flahs", "private-deployment"])("labels %s as unverified on a custom endpoint", async (model) => {
    const session = stubSession({
      provider: "deepseek", model: "deepseek-flash",
      environment: { ...TEST_ENVIRONMENT, DEEPSEEK_BASE_URL: "http://127.0.0.1:8765/v1" },
    });
    const result = await modelCommand.execute(mkctx(session, model));
    expect(session.pendingProviderSwitch).toEqual({ provider: "deepseek", model });
    expect(result).toMatchObject({ kind: "text", text: expect.stringContaining("Unverified custom model") });
    expect(result).toMatchObject({ text: expect.stringContaining("/model") });
    const repeated = await modelCommand.execute(mkctx(session, model));
    expect(repeated).toMatchObject({ text: expect.stringContaining("Unverified custom model") });
    const restored = await modelCommand.execute(mkctx(session, "deepseek-flash"));
    expect(restored.kind === "text" && restored.text).not.toContain("Unverified");
  });

  it("accepts an explicitly qualified custom open-endpoint model", async () => {
    const session = stubSession({ provider: "grok", model: "grok-4.6" });
    const res = await modelCommand.execute(mkctx(session, "openai-compatible:private-model"));
    expect(res.kind).toBe("text");
    expect(session.pendingProviderSwitch).toEqual({ provider: "openai-compatible", model: "private-model" });
  });

  it("refuses a stale picker selection before staging", async () => {
    const session = stubSession({ provider: "deepseek", model: "deepseek-flash", reasoningEffort: "high" });
    const stage = vi.fn();
    expect(await applyModelSwitch(session, "deepseek-flsh", "deepseek", { stage }))
      .toMatchObject({ applied: false, model: "deepseek-flash", summary: expect.stringContaining("did you mean 'deepseek-flash'") });
    expect(stage).not.toHaveBeenCalled();
    expect(session.pendingProviderSwitch).toBeNull();
  });

  it("surfaces ambiguous configured models without staging a switch", async () => {
    const configStore = commandConfigStore(TEST_HOME, {
      providers: {
        grok: { default_model: "shared-private-model" },
        openai: { default_model: "shared-private-model" },
      },
    });
    const session = stubSession({ configStore });

    const res = await modelCommand.execute(
      mkctx(session, "shared-private-model"),
    );

    expect(res).toEqual({
      kind: "text",
      text: expect.stringMatching(/ambiguous.*provider:model/i),
    });
    expect(
      (session as unknown as { pendingProviderSwitch: unknown })
        .pendingProviderSwitch,
    ).toBeNull();
  });

  it("does not let provider-qualified model chrome overwrite pending provider", async () => {
    const session = stubSession({
      provider: "grok",
      model: "grok-4.6",
      activeTurn: null,
    });
    const setModel = vi.fn();
    let appState: unknown = {
      mainLoopModel: "grok-4.6",
      mainLoopModelForSession: "grok-4.6",
    };
    const setAppState = vi.fn((updater: (prev: unknown) => unknown) => {
      appState = updater(appState);
    });

    const res = await modelCommand.execute(
      mkctx(session, "openai:gpt-5", { setModel, setAppState }),
    );

    expect(res.kind).toBe("text");
    expect(setModel).not.toHaveBeenCalled();
    expect(appState).toMatchObject({
      mainLoopModel: "gpt-5",
      mainLoopModelForSession: "gpt-5",
    });
    const pending = (
      session as unknown as {
        pendingProviderSwitch: { provider: string; model: string } | null;
      }
    ).pendingProviderSwitch;
    expect(pending).toEqual({ provider: "openai", model: "gpt-5" });
  });

  it("stages a same-provider command once while updating cosmetic chrome", async () => {
    const session = stubSession({ provider: "grok", model: "grok-4.6" });
    const stage = vi.spyOn(session, "setPendingProviderSwitch");
    const setModel = vi.fn();

    const result = await modelCommand.execute(
      mkctx(session, "grok-4.7", { setModel }),
    );

    expect(result.kind).toBe("text");
    expect(stage).toHaveBeenCalledTimes(1);
    expect(stage).toHaveBeenCalledWith({
      provider: "grok",
      model: "grok-4.7",
    });
    expect(setModel).toHaveBeenCalledOnce();
    expect(setModel).toHaveBeenCalledWith("grok-4.7");
  });

  it.each([
    ["drops", undefined, undefined],
    ["keeps", "high", "high"],
  ] as const)("the status line %s the chosen effort as the daemon session does", async (_case, liveEffort, effortValue) => {
    // A daemon session mirrors the journaled settings the switch produced.
    const session = stubSession({ provider: "gemini", model: "gemini-3.5-flash" });
    const sessionConfiguration: { collaborationMode: Record<string, unknown> } = {
      collaborationMode: { model: "gemini-3.5-flash", reasoningEffort: "medium" },
    };
    Object.assign(session, {
      sessionConfiguration,
      applyProviderModelSelection: vi.fn(async () => {
        sessionConfiguration.collaborationMode = {
          model: "gemma-4-31b-it",
          ...(liveEffort !== undefined ? { reasoningEffort: liveEffort } : {}),
        };
        return { applied: true, provider: "gemini", model: "gemma-4-31b-it", summary: "switched" };
      }),
    });
    let appState: Record<string, unknown> = { mainLoopModel: "gemini-3.5-flash", effortValue: liveEffort ?? "medium" };
    const setAppState = vi.fn((updater: (prev: unknown) => unknown) => {
      appState = updater(appState) as Record<string, unknown>;
    });

    await modelCommand.execute(mkctx(session, "gemini:gemma-4-31b-it", { setAppState }));

    expect(appState.mainLoopModel).toBe("gemma-4-31b-it");
    expect(appState.effortValue).toBe(effortValue);
  });

  it("returns an authoritative daemon rejection without updating chrome", async () => {
    const session = stubSession({ provider: "grok", model: "grok-4.6" });
    const summary =
      'Model switch to "gpt-5" blocked: history incompatible with target model';
    Object.assign(session, {
      applyProviderModelSelection: vi.fn(async () => ({
        applied: false,
        provider: "grok",
        model: "grok-4.6",
        summary,
      })),
    });
    const setModel = vi.fn();
    const setAppState = vi.fn();

    const result = await modelCommand.execute(
      mkctx(session, "openai:gpt-5", { setModel, setAppState }),
    );

    expect(result).toEqual({ kind: "text", text: summary });
    expect(setModel).not.toHaveBeenCalled();
    expect(setAppState).not.toHaveBeenCalled();
  });

  it("stages pending switch + aborts current turn when I-13 applies", async () => {
    const abortTerminal = vi.fn();
    const session = stubSession({
      provider: "grok",
      model: "grok-4.6",
      activeTurn: { turnId: "t1" },
      abortTerminal,
    });
    const res = await modelCommand.execute(mkctx(session, "grok-4.7"));
    expect(res.kind).toBe("text");
    if (res.kind === "text") {
      expect(res.text).toMatch(/staged/);
      expect(res.text).toMatch(/aborted/);
    }
    expect(abortTerminal).toHaveBeenCalledWith("provider_switched");
    const pending = (
      session as unknown as {
        pendingProviderSwitch: { provider: string; model: string } | null;
      }
    ).pendingProviderSwitch;
    expect(pending).toEqual({ provider: "grok", model: "grok-4.7" });
  });

  it("blocks the switch when the target model is incompatible with current history", async () => {
    const session = stubSession({
      provider: "openrouter",
      model: "x-ai/grok-4.3",
      history: [
        {
          role: "user",
          content: [
            { type: "text", text: "look at this" },
            { type: "image_url", image_url: { url: "file:///tmp/image.png" } },
          ],
        },
      ],
    });

    const res = await modelCommand.execute(mkctx(session, "openrouter:openai/gpt-oss-120b"));
    expect(res.kind).toBe("text");
    if (res.kind === "text") {
      expect(res.text).toMatch(/blocked/);
      expect(res.text).toMatch(/image history/);
    }
    const pending = (
      session as unknown as {
        pendingProviderSwitch: { provider: string; model: string } | null;
      }
    ).pendingProviderSwitch;
    expect(pending).toBeNull();
  });

  it("does not update TUI model chrome when compatibility blocks the switch", async () => {
    const session = stubSession({
      provider: "openrouter",
      model: "x-ai/grok-4.3",
      history: [
        {
          role: "user",
          content: [
            { type: "text", text: "look at this" },
            { type: "image_url", image_url: { url: "file:///tmp/image.png" } },
          ],
        },
      ],
    });
    const setModel = vi.fn();

    const res = await modelCommand.execute(
      mkctx(session, "openrouter:openai/gpt-oss-120b", { setModel }),
    );

    expect(res.kind).toBe("text");
    expect(setModel).not.toHaveBeenCalled();
  });

  it("applyModelSwitch does not invoke abortTerminal when no turn is active", async () => {
    const abortTerminal = vi.fn();
    const session = stubSession({ abortTerminal });
    await applyModelSwitch(session, "grok-4.7");
    expect(abortTerminal).not.toHaveBeenCalled();
  });

  it.each(["model", "provider"] as const)("replaces an accepted pending model when switching back via %s before another turn", async (kind) => {
    const session = stubSession({
      provider: "grok", model: "grok-4.6",
      pendingProviderSwitch: { provider: "grok", model: "grok-4.7" },
    });
    const outcome = kind === "model"
      ? await applyModelSwitch(session, "grok-4.6", "grok")
      : await applyProviderSwitch(session, "grok", "grok-4.6");
    expect(outcome).toMatchObject({ applied: true, provider: "grok", model: "grok-4.6" });
    expect(session.pendingProviderSwitch).toEqual({ provider: "grok", model: "grok-4.6" });
  });

  it.each(["model", "provider"] as const)("does not restage an already accepted pending pair via %s", async (kind) => {
    const session = stubSession({
      provider: "grok", model: "grok-4.6",
      pendingProviderSwitch: { provider: "grok", model: "grok-4.7" },
    });
    const stage = vi.fn();
    const outcome = kind === "model"
      ? await applyModelSwitch(session, "grok-4.7", "grok", { stage })
      : await applyProviderSwitch(session, "grok", "grok-4.7", { stage });
    expect(outcome).toMatchObject({ applied: false, provider: "grok", model: "grok-4.7" });
    expect(stage).not.toHaveBeenCalled();
  });

  it("does not stage or abort an unchanged model pair", async () => {
    const abortTerminal = vi.fn();
    const beforeStage = vi.fn();
    const session = stubSession({
      provider: "grok",
      model: "grok-4.6",
      activeTurn: { turnId: "active" },
      abortTerminal,
    });
    const stage = vi.spyOn(session, "setPendingProviderSwitch");

    await expect(
      applyModelSwitch(session, "grok-4.6", "grok", { beforeStage }),
    ).resolves.toEqual({
      applied: false,
      provider: "grok",
      model: "grok-4.6",
      summary: "Model unchanged: grok/grok-4.6.",
    });
    expect(stage).not.toHaveBeenCalled();
    expect(abortTerminal).not.toHaveBeenCalled();
    expect(beforeStage).not.toHaveBeenCalled();
  });

  it("blocks an invalid explicit provider without staging", async () => {
    const session = stubSession();

    await expect(
      applyModelSwitch(session, "private-model", "not-a-provider"),
    ).resolves.toMatchObject({
      applied: false,
      summary: expect.stringContaining("unknown provider 'not-a-provider'"),
    });
    expect(
      (session as unknown as { pendingProviderSwitch: unknown })
        .pendingProviderSwitch,
    ).toBeNull();
  });

  it("blocks disallowed direct switches before staging, aborting, or callbacks", async () => {
    const abortTerminal = vi.fn();
    const beforeStage = vi.fn();
    const session = stubSession({
      provider: "grok",
      model: "grok-4.6",
      activeTurn: { turnId: "active" },
      abortTerminal,
      configStore: commandConfigStore(TEST_HOME, {
        availableModels: ["grok-4.6"],
      }),
    });
    const stage = vi.spyOn(session, "setPendingProviderSwitch");

    await expect(
      applyModelSwitch(session, "gpt-5", "openai", { beforeStage }),
    ).resolves.toMatchObject({
      applied: false,
      summary: expect.stringContaining("managed availableModels policy"),
    });
    expect(stage).not.toHaveBeenCalled();
    expect(abortTerminal).not.toHaveBeenCalled();
    expect(beforeStage).not.toHaveBeenCalled();
  });

  it("blocks typed provider-qualified models without updating TUI chrome", async () => {
    const session = stubSession({
      provider: "grok",
      model: "grok-4.6",
      configStore: commandConfigStore(TEST_HOME, {
        availableModels: ["grok-4.6"],
      }),
    });
    const setModel = vi.fn();
    const setAppState = vi.fn();

    const result = await modelCommand.execute(
      mkctx(session, "openai:gpt-5", { setModel, setAppState }),
    );

    expect(result).toEqual({
      kind: "text",
      text: expect.stringContaining("managed availableModels policy"),
    });
    expect(
      (session as unknown as { pendingProviderSwitch: unknown })
        .pendingProviderSwitch,
    ).toBeNull();
    expect(setModel).not.toHaveBeenCalled();
    expect(setAppState).not.toHaveBeenCalled();
  });

  it("treats an explicit empty model allowlist as deny-all", async () => {
    const session = stubSession({
      provider: "grok",
      model: "grok-4.6",
      configStore: commandConfigStore(TEST_HOME, { availableModels: [] }),
    });

    const result = await modelCommand.execute(mkctx(session, "grok-4.6"));

    expect(result).toEqual({
      kind: "text",
      text: expect.stringContaining("managed availableModels policy"),
    });
    expect(
      (session as unknown as { pendingProviderSwitch: unknown })
        .pendingProviderSwitch,
    ).toBeNull();
  });

  it("allows an explicitly admitted model", async () => {
    const session = stubSession({
      provider: "grok",
      model: "grok-4.6",
      configStore: commandConfigStore(TEST_HOME, {
        availableModels: ["gpt-5"],
      }),
    });

    const result = await modelCommand.execute(mkctx(session, "openai:gpt-5"));

    expect(result.kind).toBe("text");
    expect(
      (session as unknown as { pendingProviderSwitch: unknown })
        .pendingProviderSwitch,
    ).toEqual({ provider: "openai", model: "gpt-5" });
  });

  it("whitespace-only args are treated as empty", async () => {
    const res = await modelCommand.execute(mkctx(stubSession(), "   "));
    expect(res.kind).toBe("text");
  });

  it("does not mention provider-specific brands in output strings", async () => {
    const session = stubSession();
    const res = await modelCommand.execute(mkctx(session, "some-model"));
    expect(res.kind).toBe("text");
    if (res.kind === "text") {
      expect(res.text.toLowerCase()).not.toContain(["cla", "ude"].join(""));
      expect(res.text.toLowerCase()).not.toContain("anthropic");
      expect(res.text.toLowerCase()).not.toContain("AgenC");
    }
  });

  it("model menu snapshot is grouped across providers", () => {
    const snapshot = readModelMenuSnapshot(mkctx(stubSession(), ""));

    expect(snapshot.rows.some((row) => row.provider === "grok")).toBe(true);
    expect(snapshot.rows.some((row) => row.provider === "openai")).toBe(true);
    expect(snapshot.rows[snapshot.activeIndex]?.status).toBe("current");
    expect(snapshot.providerCounts.openai).toBeGreaterThan(0);
  });

  it("offers Copilot models without creating bare-slug collisions", () => {
    const snapshot = readModelMenuSnapshot(
      mkctx(stubSession({ provider: "github", model: "gpt-5-mini" }), ""),
    );
    const row = snapshot.rows.find(
      (candidate) =>
        candidate.provider === "github" &&
        candidate.displayModel === "gpt-5.3-codex",
    );

    expect(row).toMatchObject({
      provider: "github",
      model: "github:copilot:gpt-5.3-codex",
      displayModel: "gpt-5.3-codex",
      status: "default",
      selectable: true,
    });
    expect(modelMenuFallback(snapshot)).toContain("github:gpt-5.3-codex");
    expect(modelMenuFallback(snapshot)).not.toContain(
      "github:github:copilot:gpt-5.3-codex",
    );
  });

  it("applies a Copilot route as the same provider-local pair", async () => {
    const session = stubSession({ provider: "github", model: "gpt-5-mini" });

    await expect(
      switchProviderModel(
        mkctx(session, ""),
        "github",
        "github:copilot:gpt-5.3-codex",
      ),
    ).resolves.toMatchObject({ applied: true });
    expect(
      (session as unknown as { pendingProviderSwitch: unknown })
        .pendingProviderSwitch,
    ).toEqual({ provider: "github", model: "gpt-5.3-codex" });
  });

  it("focuses the first allowed row when the current model is forbidden", () => {
    const configStore = commandConfigStore(TEST_HOME, {
      availableModels: ["gpt-5"],
    });
    const snapshot = readModelMenuSnapshot(
      mkctx(
        stubSession({
          provider: "grok",
          model: "grok-4.6",
          configStore,
        }),
      ),
    );

    expect(snapshot.rows[snapshot.activeIndex]).toMatchObject({
      provider: "openai",
      model: "gpt-5",
      selectable: true,
    });
    expect(snapshot.providerCounts.grok).toBe(0);
  });

  it("uses the provider service pair instead of mixing stale projections", () => {
    const configStore = commandConfigStore(TEST_HOME, {
      model_provider: "ollama",
      model: "llama3.3",
    });
    const snapshot = readModelMenuSnapshot(
      mkctx(
        stubSession({
          provider: "grok",
          model: "grok-4.6",
          configStore,
          providerServiceSelection: {
            provider: "openai",
            model: "gpt-5",
          },
        }),
        "",
        {
          getAppState: () => ({ mainLoopModel: "stale-react-model" }),
        },
      ),
    );

    expect(snapshot.provider).toBe("openai");
    expect(snapshot.currentModel).toBe("gpt-5");
    expect(snapshot.rows[snapshot.activeIndex]).toMatchObject({
      provider: "openai",
      model: "gpt-5",
      status: "current",
    });
  });

  it("ignores an incomplete higher-priority pair instead of mixing sources", () => {
    const snapshot = readModelMenuSnapshot(
      mkctx(
        stubSession({
          provider: "grok",
          model: "grok-4.6",
          providerServiceSelection: { provider: "openai" },
        }),
        "",
        {
          getAppState: () => ({ mainLoopModel: "gpt-5" }),
        },
      ),
    );

    expect(snapshot.provider).toBe("grok");
    expect(snapshot.currentModel).toBe("grok-4.6");
  });

  it("shows the complete pair staged for the next turn", () => {
    const snapshot = readModelMenuSnapshot(
      mkctx(
        stubSession({
          provider: "grok",
          model: "grok-4.6",
          pendingProviderSwitch: { provider: "openai", model: "gpt-5" },
        }),
      ),
    );

    expect(snapshot.provider).toBe("openai");
    expect(snapshot.currentModel).toBe("gpt-5");
  });

  it("uses native xAI sign-in as direct authority for the full Grok catalog", () => {
    const agencHome = mkdtempSync(join(tmpdir(), "agenc-model-menu-xai-oauth-"));
    const home = resolveHomeContext(
      { AGENC_HOME: agencHome },
      { platformHome: tmpdir() },
    );
    try {
      expect(
        saveXaiOauthCredentials(home, {
          accessToken: "model-menu-oauth-token",
          expiresAt: Date.now() + 60_000,
        }).success,
      ).toBe(true);
      const snapshot = readModelMenuSnapshot(
        mkctx(
          stubSession({
            provider: "openai",
            model: "gpt-5",
            configStore: commandConfigStore(home, {
              auth: { managedKeys: { enabled: true } },
            }),
            environment: Object.freeze({}),
          }),
        ),
      );
      const grokModels = snapshot.rows
        .filter(row => row.provider === "grok" && row.selectable)
        .map(row => row.model);

      expect(grokModels).toEqual(expect.arrayContaining([
        "grok-4.6",
        "grok-4.5",
        "grok-composer-2.5-fast",
      ]));
      expect(JSON.stringify(snapshot)).not.toContain("model-menu-oauth-token");
    } finally {
      rmSync(agencHome, { recursive: true, force: true });
    }
  });

  it.each([
    {
      name: "access only",
      environment: { AWS_ACCESS_KEY_ID: "access" },
      missing: "AWS_BEDROCK_SECRET_ACCESS_KEY or AWS_SECRET_ACCESS_KEY",
    },
    {
      name: "secret only",
      environment: { AWS_SECRET_ACCESS_KEY: "secret" },
      missing: "AWS_BEDROCK_ACCESS_KEY_ID or AWS_ACCESS_KEY_ID",
    },
  ])(
    "blocks a direct Bedrock model switch with $name",
    async ({ environment, missing }) => {
      const configStore = commandConfigStore(TEST_HOME, {
        auth: { managedKeys: { enabled: true } },
      });
      const session = stubSession({
        provider: "grok",
        model: "grok-4.3",
        configStore,
        environment: Object.freeze({ ...TEST_ENVIRONMENT, ...environment }),
      });

      const result = await modelCommand.execute(
        mkctx(session, "amazon-bedrock:amazon.nova-pro-v1:0"),
      );

      expect(result).toEqual({
        kind: "text",
        text: expect.stringContaining(`set ${missing}`),
      });
      expect(
        (session as unknown as { pendingProviderSwitch: unknown })
          .pendingProviderSwitch,
      ).toBeNull();
    },
  );

  it.each([
    {
      name: "primary aliases",
      environment: {
        AWS_BEDROCK_ACCESS_KEY_ID: "access",
        AWS_BEDROCK_SECRET_ACCESS_KEY: "secret",
      },
    },
    {
      name: "mixed aliases",
      environment: {
        AWS_ACCESS_KEY_ID: "access",
        AWS_BEDROCK_SECRET_ACCESS_KEY: "secret",
      },
    },
  ])(
    "allows a direct Bedrock model switch with complete $name",
    async ({ environment }) => {
      const configStore = commandConfigStore(TEST_HOME, {
        auth: { managedKeys: { enabled: true } },
      });
      const session = stubSession({
        provider: "grok",
        model: "grok-4.3",
        configStore,
        environment: Object.freeze({ ...TEST_ENVIRONMENT, ...environment }),
      });

      const result = await modelCommand.execute(
        mkctx(session, "amazon-bedrock:amazon.nova-pro-v1:0"),
      );

      expect(result).toEqual({
        kind: "text",
        text: expect.stringContaining(
          'Model switched to "amazon.nova-pro-v1:0"',
        ),
      });
      expect(
        (session as unknown as { pendingProviderSwitch: unknown })
          .pendingProviderSwitch,
      ).toMatchObject({
        provider: "amazon-bedrock",
        model: "amazon.nova-pro-v1:0",
      });
    },
  );

  it("preserves a bare Bedrock model id that contains a colon", async () => {
    const configStore = commandConfigStore(TEST_HOME, {
      auth: { managedKeys: { enabled: true } },
    });
    const session = stubSession({
      provider: "grok",
      model: "grok-4.3",
      configStore,
      environment: Object.freeze({
        ...TEST_ENVIRONMENT,
        AWS_BEDROCK_ACCESS_KEY_ID: "access",
        AWS_BEDROCK_SECRET_ACCESS_KEY: "secret",
      }),
    });

    const result = await modelCommand.execute(
      mkctx(session, "amazon.nova-pro-v1:0"),
    );

    expect(result).toEqual({
      kind: "text",
      text: expect.stringContaining(
        'Model switched to "amazon.nova-pro-v1:0"',
      ),
    });
    expect(
      (session as unknown as { pendingProviderSwitch: unknown })
        .pendingProviderSwitch,
    ).toEqual({
      provider: "amazon-bedrock",
      model: "amazon.nova-pro-v1:0",
    });
  });
});
