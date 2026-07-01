import { describe, expect, it, vi } from "vitest";
import {
  modelCommand,
  applyModelSwitch,
  checkModelHistoryCompat,
} from "./model.js";
import { modelMenuFallback, readModelMenuSnapshot } from "./model-menu.js";
import type { Session } from "../session/session.js";
import type { SlashCommandAppStateBridge, SlashCommandContext } from "./types.js";

interface StubSessionOpts {
  provider?: string;
  model?: string;
  activeTurn?: unknown;
  abortTerminal?: ReturnType<typeof vi.fn>;
  pendingProviderSwitch?: unknown;
  history?: unknown[];
  reasoningEffort?: string;
  configStore?: { current: () => unknown };
}

function stubSession(opts: StubSessionOpts = {}): Session {
  const sessionConfiguration = {
    provider: { slug: opts.provider ?? "xai" },
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
    services: { configStore?: { current: () => unknown } };
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
      ...(opts.configStore !== undefined ? { configStore: opts.configStore } : {}),
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

describe("checkModelHistoryCompat", () => {
  it("allows switching when the target model can satisfy current history requirements", () => {
    const session = stubSession({
      provider: "xai",
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
      configStore: {
        current: () => ({
          providers: {
            grok: {
              capability_overrides: {
                "grok-4-fast": { acceptsReasoningEffort: false },
              },
            },
          },
        }),
      },
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

  it("applies the switch immediately when no turn is active", async () => {
    const session = stubSession({
      provider: "xai",
      model: "grok-4",
      activeTurn: null,
    });
    const res = await modelCommand.execute(
      mkctx(session, "grok-4-fast"),
    );
    expect(res.kind).toBe("text");
    if (res.kind === "text") {
      expect(res.text).toMatch(/grok-4-fast/);
      expect(res.text).toMatch(/was "xai\/grok-4"/);
    }
    const pending = (session as unknown as {
      pendingProviderSwitch: { provider: string; model: string } | null;
    }).pendingProviderSwitch;
    expect(pending).toEqual({ provider: "xai", model: "grok-4-fast" });
  });

  it("can switch provider and model from provider-qualified input", async () => {
    const session = stubSession({
      provider: "xai",
      model: "grok-4",
      activeTurn: null,
    });

    const res = await modelCommand.execute(
      mkctx(session, "openai:gpt-5"),
    );

    expect(res.kind).toBe("text");
    if (res.kind === "text") {
      expect(res.text).toMatch(/openai/);
      expect(res.text).toMatch(/gpt-5/);
    }
    const pending = (session as unknown as {
      pendingProviderSwitch: { provider: string; model: string } | null;
    }).pendingProviderSwitch;
    expect(pending).toEqual({ provider: "openai", model: "gpt-5" });
  });

  it("does not let provider-qualified model chrome overwrite pending provider", async () => {
    const session = stubSession({
      provider: "xai",
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
    const pending = (session as unknown as {
      pendingProviderSwitch: { provider: string; model: string } | null;
    }).pendingProviderSwitch;
    expect(pending).toEqual({ provider: "openai", model: "gpt-5" });
  });

  it("stages pending switch + aborts current turn when I-13 applies", async () => {
    const abortTerminal = vi.fn();
    const session = stubSession({
      provider: "xai",
      model: "grok-4",
      activeTurn: { turnId: "t1" },
      abortTerminal,
    });
    const res = await modelCommand.execute(
      mkctx(session, "grok-4-fast"),
    );
    expect(res.kind).toBe("text");
    if (res.kind === "text") {
      expect(res.text).toMatch(/staged/);
      expect(res.text).toMatch(/aborted/);
    }
    expect(abortTerminal).toHaveBeenCalledWith("provider_switched");
    const pending = (session as unknown as {
      pendingProviderSwitch: { provider: string; model: string } | null;
    }).pendingProviderSwitch;
    expect(pending).toEqual({ provider: "xai", model: "grok-4-fast" });
  });

  it("blocks the switch when the target model is incompatible with current history", async () => {
    const session = stubSession({
      provider: "openrouter",
      model: "gpt-5",
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
    const pending = (session as unknown as {
      pendingProviderSwitch: { provider: string; model: string } | null;
    }).pendingProviderSwitch;
    expect(pending).toBeNull();
  });

  it("does not update TUI model chrome when compatibility blocks the switch", async () => {
    const session = stubSession({
      provider: "openrouter",
      model: "gpt-5",
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

    expect(snapshot.rows.some(row => row.provider === "grok")).toBe(true);
    expect(snapshot.rows.some(row => row.provider === "openai")).toBe(true);
    expect(snapshot.rows[snapshot.activeIndex]?.status).toBe("current");
    expect(snapshot.providerCounts.openai).toBeGreaterThan(0);
  });

  it("model menu snapshot reports managed key mode from config", () => {
    const snapshot = readModelMenuSnapshot({
      ...mkctx(stubSession(), ""),
      configStore: {
        current: () => ({
          auth: { managedKeys: { enabled: true } },
        }),
      } as SlashCommandContext["configStore"],
    });

    expect(snapshot.managedKeysEnabled).toBe(true);
    expect(modelMenuFallback(snapshot)).toContain("Managed keys: on");
  });

  it("model menu limits subscription-managed OpenRouter to live models", () => {
    const snapshot = readModelMenuSnapshot({
      ...mkctx(stubSession({ provider: "openrouter", model: "x-ai/grok-4.3" }), ""),
      configStore: {
        current: () => ({
          auth: { managedKeys: { enabled: true } },
        }),
      } as SlashCommandContext["configStore"],
    });
    const openrouterModels = snapshot.rows
      .filter(row => row.provider === "openrouter")
      .map(row => row.model);

    expect(openrouterModels).toEqual([
      "x-ai/grok-4.3",
      "x-ai/grok-build-0.1",
      "openai/gpt-4o-mini",
      "anthropic/claude-haiku-4.5",
      "google/gemini-2.5-flash",
      "deepseek/deepseek-chat",
    ]);
    expect(snapshot.rows.map(row => row.provider)).toEqual([
      "openrouter",
      "openrouter",
      "openrouter",
      "openrouter",
      "openrouter",
      "openrouter",
    ]);
  });

  it("blocks direct model switches to unavailable subscription-managed OpenRouter models", async () => {
    const previous = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      const res = await modelCommand.execute({
        ...mkctx(
          stubSession({ provider: "openrouter", model: "x-ai/grok-4.3" }),
          "openrouter:x-ai/grok-4.20",
        ),
        configStore: {
          current: () => ({
            auth: { managedKeys: { enabled: true } },
          }),
        } as SlashCommandContext["configStore"],
      });

      expect(res).toEqual({
        kind: "text",
        text: expect.stringContaining("not enabled for subscription-managed openrouter"),
      });
    } finally {
      if (previous === undefined) {
        delete process.env.OPENROUTER_API_KEY;
      } else {
        process.env.OPENROUTER_API_KEY = previous;
      }
    }
  });

  it("allows direct switches to subscription-managed OpenRouter models outside the base catalog", async () => {
    const previous = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      const session = stubSession({
        provider: "openrouter",
        model: "x-ai/grok-4.3",
        activeTurn: null,
      });
      const res = await modelCommand.execute({
        ...mkctx(session, "openrouter:deepseek/deepseek-chat"),
        configStore: {
          current: () => ({
            auth: { managedKeys: { enabled: true } },
          }),
        } as SlashCommandContext["configStore"],
      });

      expect(res.kind).toBe("text");
      const pending = (session as unknown as {
        pendingProviderSwitch: { provider: string; model: string } | null;
      }).pendingProviderSwitch;
      expect(pending).toEqual({
        provider: "openrouter",
        model: "deepseek/deepseek-chat",
      });
    } finally {
      if (previous === undefined) {
        delete process.env.OPENROUTER_API_KEY;
      } else {
        process.env.OPENROUTER_API_KEY = previous;
      }
    }
  });

  it("blocks direct model switches to unavailable managed routes without BYOK", async () => {
    const previous = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const res = await modelCommand.execute({
        ...mkctx(stubSession({ provider: "grok", model: "grok-4.3" }), "openai:gpt-5"),
        configStore: {
          current: () => ({
            auth: { managedKeys: { enabled: true } },
          }),
        } as SlashCommandContext["configStore"],
      });

      expect(res).toEqual({
        kind: "text",
        text: expect.stringContaining("/model openrouter:x-ai/grok-4.3"),
      });
    } finally {
      if (previous === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previous;
      }
    }
  });
});
