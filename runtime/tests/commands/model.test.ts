import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";
import {
  modelCommand,
  applyModelSwitch,
  checkModelHistoryCompat,
} from "./model.js";
import { modelMenuFallback, readModelMenuSnapshot } from "./model-menu.js";
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
      model: opts.model ?? "grok-4",
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

    const result = checkModelHistoryCompat(session, "grok-4-fast");
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

    const result = checkModelHistoryCompat(session, "openai/gpt-4.1");
    expect(result.compatible).toBe(false);
    expect(result.missingCapabilities).toEqual(["image history"]);
    expect(result.reason).toMatch(/openrouter \/ openai\/gpt-4\.1/);
  });

  it("treats reasoning effort as a compatibility requirement", () => {
    const session = stubSession({
      provider: "grok",
      model: "grok-4-fast",
      reasoningEffort: "high",
      configStore: commandConfigStore(TEST_HOME, {
        providers: {
          grok: {
            capability_overrides: {
              "grok-4-fast": { acceptsReasoningEffort: false },
            },
          },
        },
      }),
    });

    const result = checkModelHistoryCompat(session, "grok-4-fast");
    expect(result.compatible).toBe(false);
    expect(result.missingCapabilities).toEqual(["reasoning effort"]);
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
      expect(res.text).toContain("grok-4");
    }
  });

  it("opens the local model menu when args are empty in the TUI", async () => {
    const session = stubSession();
    const setToolJSX = vi.fn();
    const res = await modelCommand.execute(
      mkctx(session, "", {
        getAppState: () => ({ mainLoopModel: "grok-4" }),
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
        jsx?: {
          props?: {
            onSelect?: (
              provider: "grok",
              model: string,
            ) => Promise<{ message: string; shouldClose: boolean }>;
          };
        };
      };
      await expect(
        payload.jsx?.props?.onSelect?.("grok", "grok-4.6"),
      ).resolves.toEqual({
        message: "Model unchanged: grok/grok-4.6.",
        shouldClose: true,
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

  it("routes picker selections through provider-model authority", async () => {
    const session = stubSession({ provider: "grok", model: "grok-4" });
    const setToolJSX = vi.fn();

    const res = await modelCommand.execute(
      mkctx(session, "", { setToolJSX }),
    );

    expect(res.kind).toBe("skip");
    const payload = setToolJSX.mock.calls[0]?.[0] as {
      jsx?: {
        props?: {
          onSelect?: (
            provider: "grok",
            model: string,
          ) => Promise<{ message: string; shouldClose: boolean }>;
        };
      };
    };
    const onSelect = payload.jsx?.props?.onSelect;
    expect(onSelect).toBeTypeOf("function");
    await expect(onSelect!("grok", "gpt-5")).resolves.toEqual({
      message: expect.stringContaining(
        "belongs to provider 'openai', not explicitly selected provider 'grok'",
      ),
      shouldClose: false,
    });
    expect(
      (session as unknown as { pendingProviderSwitch: unknown })
        .pendingProviderSwitch,
    ).toBeNull();
  });

  it("applies the switch immediately when no turn is active", async () => {
    const session = stubSession({
      provider: "grok",
      model: "grok-4",
      activeTurn: null,
    });
    const res = await modelCommand.execute(mkctx(session, "grok-4-fast"));
    expect(res.kind).toBe("text");
    if (res.kind === "text") {
      expect(res.text).toMatch(/grok-4-fast/);
      expect(res.text).toMatch(/was "grok\/grok-4"/);
    }
    const pending = (
      session as unknown as {
        pendingProviderSwitch: { provider: string; model: string } | null;
      }
    ).pendingProviderSwitch;
    expect(pending).toEqual({ provider: "grok", model: "grok-4-fast" });
  });

  it("can switch provider and model from provider-qualified input", async () => {
    const session = stubSession({
      provider: "grok",
      model: "grok-4",
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
    const session = stubSession({ provider: "grok", model: "grok-4" });

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
    const session = stubSession({ provider: "grok", model: "grok-4" });

    const res = await modelCommand.execute(mkctx(session, "gpt-5"));

    expect(res.kind).toBe("text");
    expect(
      (session as unknown as { pendingProviderSwitch: unknown })
        .pendingProviderSwitch,
    ).toEqual({ provider: "openai", model: "gpt-5" });
  });

  it("keeps an unknown bare model on the current provider", async () => {
    const session = stubSession({ provider: "grok", model: "grok-4" });

    const res = await modelCommand.execute(
      mkctx(session, "private-grok-model"),
    );

    expect(res.kind).toBe("text");
    expect(
      (session as unknown as { pendingProviderSwitch: unknown })
        .pendingProviderSwitch,
    ).toEqual({ provider: "grok", model: "private-grok-model" });
  });

  it("accepts an explicitly qualified private provider model", async () => {
    const session = stubSession({ provider: "grok", model: "grok-4" });

    const res = await modelCommand.execute(
      mkctx(session, "openai:private-openai-model"),
    );

    expect(res.kind).toBe("text");
    expect(
      (session as unknown as { pendingProviderSwitch: unknown })
        .pendingProviderSwitch,
    ).toEqual({ provider: "openai", model: "private-openai-model" });
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
      model: "grok-4",
      activeTurn: null,
    });
    const setModel = vi.fn();
    let appState: unknown = {
      mainLoopModel: "grok-4",
      mainLoopModelForSession: "grok-4",
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
    const session = stubSession({ provider: "grok", model: "grok-4" });
    const stage = vi.spyOn(session, "setPendingProviderSwitch");
    const setModel = vi.fn();

    const result = await modelCommand.execute(
      mkctx(session, "grok-4-fast", { setModel }),
    );

    expect(result.kind).toBe("text");
    expect(stage).toHaveBeenCalledTimes(1);
    expect(stage).toHaveBeenCalledWith({
      provider: "grok",
      model: "grok-4-fast",
    });
    expect(setModel).toHaveBeenCalledOnce();
    expect(setModel).toHaveBeenCalledWith("grok-4-fast");
  });

  it("returns an authoritative daemon rejection without updating chrome", async () => {
    const session = stubSession({ provider: "grok", model: "grok-4" });
    const summary =
      'Model switch to "gpt-5" blocked: history incompatible with target model';
    Object.assign(session, {
      applyProviderModelSelection: vi.fn(async () => ({
        applied: false,
        provider: "grok",
        model: "grok-4",
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
      model: "grok-4",
      activeTurn: { turnId: "t1" },
      abortTerminal,
    });
    const res = await modelCommand.execute(mkctx(session, "grok-4-fast"));
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
    expect(pending).toEqual({ provider: "grok", model: "grok-4-fast" });
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

    const res = await modelCommand.execute(mkctx(session, "openai/gpt-4.1"));
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
      mkctx(session, "openai/gpt-4.1", { setModel }),
    );

    expect(res.kind).toBe("text");
    expect(setModel).not.toHaveBeenCalled();
  });

  it("applyModelSwitch does not invoke abortTerminal when no turn is active", async () => {
    const abortTerminal = vi.fn();
    const session = stubSession({ abortTerminal });
    await applyModelSwitch(session, "grok-4-fast");
    expect(abortTerminal).not.toHaveBeenCalled();
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

  it("applies a Copilot menu route as the same provider-local pair", async () => {
    const session = stubSession({ provider: "github", model: "gpt-5-mini" });
    const setToolJSX = vi.fn();

    const result = await modelCommand.execute(
      mkctx(session, "", { setToolJSX }),
    );

    expect(result.kind).toBe("skip");
    const payload = setToolJSX.mock.calls[0]?.[0] as {
      jsx?: {
        props?: {
          onSelect?: (
            provider: "github",
            model: string,
          ) => Promise<{ message: string; shouldClose: boolean }>;
        };
      };
    };
    const onSelect = payload.jsx?.props?.onSelect;
    expect(onSelect).toBeTypeOf("function");
    await expect(
      onSelect!("github", "github:copilot:gpt-5.3-codex"),
    ).resolves.toMatchObject({ shouldClose: true });
    expect(
      (session as unknown as { pendingProviderSwitch: unknown })
        .pendingProviderSwitch,
    ).toEqual({ provider: "github", model: "gpt-5.3-codex" });
  });

  it("filters menu rows and counts through collision-safe managed policy", () => {
    const configStore = commandConfigStore(TEST_HOME, {
      availableModels: ["github:copilot:gpt-5.3-codex"],
    });
    const snapshot = readModelMenuSnapshot(
      mkctx(
        stubSession({
          provider: "github",
          model: "gpt-5-mini",
          configStore,
        }),
      ),
    );
    const selectable = snapshot.rows.filter(row => row.selectable);

    expect(selectable).toEqual([
      expect.objectContaining({
        provider: "github",
        model: "github:copilot:gpt-5.3-codex",
        displayModel: "gpt-5.3-codex",
      }),
    ]);
    expect(snapshot.providerCounts.github).toBe(1);
    expect(snapshot.providerCounts.openai).toBe(0);
    expect(snapshot.rows[snapshot.activeIndex]).toMatchObject({
      provider: "github",
      selectable: true,
    });
  });

  it("keeps bare managed IDs compatible across provider-local catalogs", () => {
    const configStore = commandConfigStore(TEST_HOME, {
      availableModels: ["gpt-5.3-codex"],
    });
    const snapshot = readModelMenuSnapshot(
      mkctx(stubSession({ configStore })),
    );
    const matching = snapshot.rows.filter(
      row => row.selectable && row.displayModel === "gpt-5.3-codex",
    );

    expect(matching.map(row => row.provider).sort()).toEqual([
      "github",
      "openai",
    ]);
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

  it("renders no selectable model rows for an empty managed allowlist", () => {
    const configStore = commandConfigStore(TEST_HOME, { availableModels: [] });
    const snapshot = readModelMenuSnapshot(
      mkctx(stubSession({ configStore })),
    );

    expect(snapshot.rows.length).toBeGreaterThan(0);
    expect(snapshot.rows.every(row => !row.selectable)).toBe(true);
    expect(Object.values(snapshot.providerCounts).every(count => count === 0))
      .toBe(true);
    expect(snapshot.rows[0]?.detail).toBe("no models allowed by managed policy");
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
          model: "grok-4",
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
          model: "grok-4",
          providerServiceSelection: { provider: "openai" },
        }),
        "",
        {
          getAppState: () => ({ mainLoopModel: "gpt-5" }),
        },
      ),
    );

    expect(snapshot.provider).toBe("grok");
    expect(snapshot.currentModel).toBe("grok-4");
  });

  it("shows the complete pair staged for the next turn", () => {
    const snapshot = readModelMenuSnapshot(
      mkctx(
        stubSession({
          provider: "grok",
          model: "grok-4",
          pendingProviderSwitch: { provider: "openai", model: "gpt-5" },
        }),
      ),
    );

    expect(snapshot.provider).toBe("openai");
    expect(snapshot.currentModel).toBe("gpt-5");
  });

  it("model menu snapshot reports managed key mode from config", () => {
    const configStore = commandConfigStore(TEST_HOME, {
      auth: { managedKeys: { enabled: true } },
    });
    const snapshot = readModelMenuSnapshot(
      mkctx(stubSession({ configStore }), ""),
    );

    expect(snapshot.managedKeysEnabled).toBe(true);
    expect(modelMenuFallback(snapshot)).toContain("Managed keys: on");
  });

  it("keeps the current, local, and no-key composer routes visible with managed keys on", () => {
    const configStore = commandConfigStore(TEST_HOME, {
      auth: { managedKeys: { enabled: true } },
    });
    const snapshot = readModelMenuSnapshot(
      mkctx(
        stubSession({
          provider: "openai",
          model: "gpt-5",
          configStore,
          environment: Object.freeze({}),
        }),
      ),
    );

    expect(snapshot.rows[snapshot.activeIndex]).toMatchObject({
      provider: "openai",
      model: "gpt-5",
      status: "current",
      selectable: true,
    });
    expect(snapshot.rows).toContainEqual(expect.objectContaining({
      provider: "ollama",
      model: "llama3.3",
      selectable: true,
    }));
    expect(snapshot.rows).toContainEqual(expect.objectContaining({
      provider: "grok",
      model: "grok-composer-2.5-fast",
      selectable: true,
    }));
    expect(snapshot.rows).not.toContainEqual(expect.objectContaining({
      provider: "grok",
      model: "grok-4.6",
    }));
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

  it("model menu limits subscription-managed OpenRouter to live models", async () => {
    await withProAuthSession(({ configStore, environment }) => {
      const snapshot = readModelMenuSnapshot(
        mkctx(
          stubSession({
            provider: "openrouter",
            model: "x-ai/grok-4.3",
            configStore,
            environment,
          }),
          "",
        ),
      );
      const openrouterModels = snapshot.rows
        .filter((row) => row.provider === "openrouter")
        .map((row) => row.model);

      // The session's active model (grok-4.3) is hoisted above the default
      // ordering, which now leads with grok-4.5.
      expect(openrouterModels.slice(0, 20)).toEqual([
        "x-ai/grok-4.3",
        "x-ai/grok-4.5",
        "x-ai/grok-build-0.1",
        "openai/gpt-4o-mini",
        "openai/gpt-5-nano",
        "openai/gpt-4.1-nano",
        "openai/gpt-oss-120b",
        "anthropic/claude-haiku-4.5",
        "google/gemini-2.5-flash",
        "google/gemini-2.5-flash-lite",
        "deepseek/deepseek-v4-flash",
        "deepseek/deepseek-v3.2",
        "qwen/qwen3-coder-30b-a3b-instruct",
        "qwen/qwen3-235b-a22b-2507",
        "mistralai/mistral-small-3.2-24b-instruct",
        "meta-llama/llama-3.3-70b-instruct",
        "meta-llama/llama-4-scout",
        "minimax/minimax-m2.5",
        "z-ai/glm-4.7-flash",
        "cohere/north-mini-code:free",
      ]);
      expect(openrouterModels).not.toContain("openrouter/free");
      expect(openrouterModels).toContain("openai/gpt-oss-20b:free");
      expect(openrouterModels.length).toBeGreaterThan(20);
      expect(snapshot.rows).toContainEqual(expect.objectContaining({
        provider: "ollama",
        model: "llama3.3",
        selectable: true,
      }));
      expect(snapshot.rows).toContainEqual(expect.objectContaining({
        provider: "grok",
        model: "grok-composer-2.5-fast",
        selectable: true,
      }));
    });
  });

  it("opens paid managed sessions on the current provider and model", async () => {
    await withProAuthSession(({ configStore, environment }) => {
      const snapshot = readModelMenuSnapshot(
        mkctx(
          stubSession({
            provider: "grok",
            model: "grok-4.3",
            configStore,
            environment,
          }),
          "",
        ),
      );

      expect(snapshot.rows[0]).toMatchObject({
        provider: "grok",
        model: "grok-4.3",
        status: "current",
      });
      expect(snapshot.rows[snapshot.activeIndex]).toMatchObject({
        provider: "grok",
        model: "grok-4.3",
        status: "current",
      });
      expect(snapshot.rows.some((row) => row.provider === "openrouter")).toBe(true);
    });
  });

  it("blocks direct model switches to unavailable subscription-managed OpenRouter models", async () => {
    await withProAuthSession(async ({ configStore, environment }) => {
      const res = await modelCommand.execute(
        mkctx(
          stubSession({
            provider: "openrouter",
            model: "x-ai/grok-4.3",
            configStore,
            environment,
          }),
          "openrouter:x-ai/grok-4.20",
        ),
      );

      expect(res).toEqual({
        kind: "text",
        text: expect.stringContaining(
          "not enabled for subscription-managed openrouter",
        ),
      });
      if (res.kind === "text") {
        expect(res.text).toContain("Try /model openrouter:x-ai/grok-4.5");
        expect(res.text).toContain("open /model to pick a hosted route");
        expect(res.text).not.toContain(
          " or /model openrouter:openai/gpt-4o-mini",
        );
      }
    });
  });

  it("allows direct switches to subscription-managed OpenRouter models outside the base catalog", async () => {
    await withProAuthSession(async ({ configStore, environment }) => {
      const session = stubSession({
        provider: "openrouter",
        model: "x-ai/grok-4.3",
        activeTurn: null,
        configStore,
        environment,
      });
      const res = await modelCommand.execute(
        mkctx(session, "openrouter:deepseek/deepseek-v4-flash"),
      );

      expect(res.kind).toBe("text");
      const pending = (
        session as unknown as {
          pendingProviderSwitch: { provider: string; model: string } | null;
        }
      ).pendingProviderSwitch;
      expect(pending).toEqual({
        provider: "openrouter",
        model: "deepseek/deepseek-v4-flash",
      });
    });
  });

  it("blocks direct model switches to unavailable managed routes without BYOK", async () => {
    const configStore = commandConfigStore(TEST_HOME, {
      auth: { managedKeys: { enabled: true } },
    });
    const res = await modelCommand.execute(
      mkctx(
        stubSession({
          provider: "grok",
          model: "grok-4.3",
          configStore,
        }),
        "openai:gpt-5",
      ),
    );

    expect(res).toEqual({
      kind: "text",
      text: expect.stringContaining(
        "hosted subscription access is available through OpenRouter",
      ),
    });
  });

  it.each([
    {
      name: "no credentials",
      environment: {},
      missing:
        "AWS_BEDROCK_ACCESS_KEY_ID or AWS_ACCESS_KEY_ID and AWS_BEDROCK_SECRET_ACCESS_KEY or AWS_SECRET_ACCESS_KEY",
    },
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
