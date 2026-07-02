import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";
import {
  providerCommand,
  applyProviderSwitch,
  checkModelHistoryCompat,
} from "./provider.js";
import { readProviderMenuSnapshot } from "./provider-menu.js";
import type { Session } from "../session/session.js";
import type { SlashCommandAppStateBridge, SlashCommandContext } from "./types.js";
import type { ConfigStore } from "../config/store.js";

interface StubSessionOpts {
  provider?: string;
  model?: string;
  activeTurn?: unknown;
  abortTerminal?: ReturnType<typeof vi.fn>;
  pendingProviderSwitch?: unknown;
  history?: unknown[];
  configModelByProvider?: Record<string, string>;
}

function stubSession(opts: StubSessionOpts = {}): Session {
  const sessionConfiguration = {
    provider: { slug: opts.provider ?? "xai" },
    collaborationMode: { model: opts.model ?? "grok-4" },
  };
  const abortTerminal = opts.abortTerminal ?? vi.fn();
  const s: {
    state: { unsafePeek: () => unknown };
    activeTurn: { unsafePeek: () => unknown };
    abortTerminal: ReturnType<typeof vi.fn>;
    pendingProviderSwitch: unknown;
    services: {
      configStore?: Pick<ConfigStore, "current">;
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
    services: opts.configModelByProvider
      ? {
          configStore: {
            current: () => ({
              providers: Object.fromEntries(
                Object.entries(opts.configModelByProvider ?? {}).map(
                  ([provider, model]) => [provider, { default_model: model }],
                ),
              ),
            }),
          } satisfies Pick<ConfigStore, "current">,
        }
      : {},
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

function withProAuthSession<T>(fn: () => T): T {
  const agencHome = mkdtempSync(join(tmpdir(), "agenc-provider-pro-"));
  writeFileSync(
    join(agencHome, "auth.json"),
    JSON.stringify({
      provider: "remote",
      token: "test-token",
      expiresAt: "2099-01-01T00:00:00.000Z",
      subscriptionTier: "pro",
    }),
  );
  const previousHome = process.env.AGENC_HOME;
  process.env.AGENC_HOME = agencHome;
  try {
    return fn();
  } finally {
    if (previousHome === undefined) {
      delete process.env.AGENC_HOME;
    } else {
      process.env.AGENC_HOME = previousHome;
    }
  }
}

describe("providerCommand", () => {
  it("is userInvocable and immediate", () => {
    expect(providerCommand.userInvocable).toBe(true);
    expect(providerCommand.immediate).toBe(true);
    expect(providerCommand.name).toBe("provider");
    expect(providerCommand.aliases).toBeUndefined();
  });

  it("re-exports the live I-57 implementation", () => {
    const session = stubSession({
      provider: "openai",
      model: "gpt-5",
      history: [
        {
          role: "assistant",
          content: [{ type: "reasoning", summary: [] }],
        },
      ],
    });
    const compat = checkModelHistoryCompat(session, "gpt-5", "ollama");
    expect(compat.compatible).toBe(false);
    expect(compat.missingCapabilities).toEqual(["thinking history"]);
  });

  it("returns a provider list when args are empty outside the TUI", async () => {
    const session = stubSession();
    const res = await providerCommand.execute(mkctx(session, ""));
    expect(res.kind).toBe("text");
    if (res.kind === "text") {
      expect(res.text).toContain("Provider selection");
      expect(res.text).toContain("Current: grok / grok-4");
      expect(res.text).toContain("ollama");
    }
  });

  it("opens the local provider menu when args are empty in the TUI", async () => {
    const session = stubSession();
    const setToolJSX = vi.fn();
    const res = await providerCommand.execute(
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

  it("applies the provider default model immediately when no turn is active", async () => {
    const session = stubSession({
      provider: "xai",
      model: "grok-4",
      activeTurn: null,
    });
    const res = await providerCommand.execute(
      mkctx(session, "ollama"),
    );
    expect(res.kind).toBe("text");
    if (res.kind === "text") {
      expect(res.text).toMatch(/ollama/);
      expect(res.text).toMatch(/model "llama3\.3"/);
    }
    const pending = (session as unknown as {
      pendingProviderSwitch: { provider: string; model: string } | null;
    }).pendingProviderSwitch;
    expect(pending).toEqual({ provider: "ollama", model: "llama3.3" });
  });

  it("updates TUI model chrome when provider switch selects a model", async () => {
    const session = stubSession({
      provider: "xai",
      model: "grok-4",
      activeTurn: null,
    });
    const setModel = vi.fn();
    const res = await providerCommand.execute(
      mkctx(session, "ollama", { setModel }),
    );
    expect(res.kind).toBe("text");
    expect(setModel).toHaveBeenCalledWith("llama3.3");
  });

  it("updates app state without overwriting the pending provider switch", async () => {
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

    const res = await providerCommand.execute(
      mkctx(session, "ollama", { setModel, setAppState }),
    );

    expect(res.kind).toBe("text");
    expect(setModel).not.toHaveBeenCalled();
    expect(appState).toMatchObject({
      mainLoopModel: "llama3.3",
      mainLoopModelForSession: "llama3.3",
    });
    const pending = (session as unknown as {
      pendingProviderSwitch: { provider: string; model: string } | null;
    }).pendingProviderSwitch;
    expect(pending).toEqual({ provider: "ollama", model: "llama3.3" });
  });

  it("uses an explicit model when the picker submits provider and model", async () => {
    const session = stubSession({
      provider: "xai",
      model: "grok-4",
    });
    const res = await providerCommand.execute(
      mkctx(session, "openai gpt-5"),
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

  it("prefers configured provider defaults when available", async () => {
    const session = stubSession({
      provider: "xai",
      model: "grok-4",
      configModelByProvider: {
        openai: "gpt-5-mini",
      },
    });
    await providerCommand.execute(mkctx(session, "openai"));
    const pending = (session as unknown as {
      pendingProviderSwitch: { provider: string; model: string } | null;
    }).pendingProviderSwitch;
    expect(pending).toEqual({ provider: "openai", model: "gpt-5-mini" });
  });

  it("stages pending switch + aborts current turn when I-13 applies", async () => {
    const abortTerminal = vi.fn();
    const session = stubSession({
      provider: "xai",
      model: "grok-4",
      activeTurn: { turnId: "t1" },
      abortTerminal,
    });
    const res = await providerCommand.execute(
      mkctx(session, "ollama"),
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
    expect(pending).toEqual({ provider: "ollama", model: "llama3.3" });
  });

  it("blocks the switch when the target provider cannot satisfy current history", async () => {
    const session = stubSession({
      provider: "openai",
      model: "gpt-5",
      history: [
        {
          role: "assistant",
          content: [{ type: "reasoning", summary: [] }],
        },
      ],
    });

    const res = await providerCommand.execute(mkctx(session, "ollama"));
    expect(res.kind).toBe("text");
    if (res.kind === "text") {
      expect(res.text).toMatch(/blocked/);
      expect(res.text).toMatch(/thinking history/);
    }
    const pending = (session as unknown as {
      pendingProviderSwitch: { provider: string; model: string } | null;
    }).pendingProviderSwitch;
    expect(pending).toBeNull();
  });

  it("does not update TUI model chrome when provider compatibility blocks the switch", async () => {
    const session = stubSession({
      provider: "openai",
      model: "gpt-5",
      history: [
        {
          role: "assistant",
          content: [{ type: "reasoning", summary: [] }],
        },
      ],
    });
    const setModel = vi.fn();

    const res = await providerCommand.execute(
      mkctx(session, "ollama", { setModel }),
    );

    expect(res.kind).toBe("text");
    expect(setModel).not.toHaveBeenCalled();
  });

  it("applyProviderSwitch does not invoke abortTerminal when no turn is active", async () => {
    const abortTerminal = vi.fn();
    const session = stubSession({ abortTerminal });
    await applyProviderSwitch(session, "ollama");
    expect(abortTerminal).not.toHaveBeenCalled();
  });

  it("whitespace-only args are treated as empty", async () => {
    const res = await providerCommand.execute(
      mkctx(stubSession(), "   "),
    );
    expect(res.kind).toBe("text");
  });

  it("does not mention branded references in output strings", async () => {
    const session = stubSession();
    const res = await providerCommand.execute(
      mkctx(session, "some-provider"),
    );
    expect(res.kind).toBe("text");
    if (res.kind === "text") {
      expect(res.text.toLowerCase()).not.toContain(["cla", "ude"].join(""));
      expect(res.text.toLowerCase()).not.toContain("anthropic");
      expect(res.text.toLowerCase()).not.toContain("AgenC");
    }
  });

  it("provider menu snapshot exposes v2 auth and model availability state", () => {
    const snapshot = readProviderMenuSnapshot(mkctx(stubSession(), ""));
    const ollama = snapshot.rows.find(row => row.provider === "ollama");
    const openai = snapshot.rows.find(row => row.provider === "openai");

    expect(ollama).toMatchObject({
      runtimeState: "local",
      authState: "optional",
      model: "llama3.3",
    });
    expect(openai?.models.length).toBeGreaterThan(0);
    expect(openai?.credentialSource).toContain("OPENAI_API_KEY");
  });

  it("shows subscription-managed auth when managed keys are enabled and BYOK is absent", () => {
    withProAuthSession(() => {
    const previous = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      const snapshot = readProviderMenuSnapshot({
        ...mkctx(stubSession({ provider: "openrouter", model: "x-ai/grok-4.3" }), ""),
        configStore: {
          current: () => ({
            auth: { managedKeys: { enabled: true } },
          }),
        } as SlashCommandContext["configStore"],
      });
      const openrouter = snapshot.rows.find(row => row.provider === "openrouter");

      expect(openrouter).toMatchObject({
        authState: "managed",
        auth: "subscription",
      });
      expect(openrouter?.models.slice(0, 19)).toEqual([
        "x-ai/grok-4.3",
        "x-ai/grok-build-0.1",
        "openai/gpt-4o-mini",
        "openai/gpt-5-nano",
        "openai/gpt-4.1-nano",
        "openai/gpt-oss-120b",
        "anthropic/claude-haiku-4.5",
        "google/gemini-2.5-flash",
        "google/gemini-2.5-flash-lite",
        "deepseek/deepseek-chat",
        "deepseek/deepseek-v4-flash",
        "deepseek/deepseek-v3.2",
        "qwen/qwen3-coder-30b-a3b-instruct",
        "qwen/qwen3-235b-a22b-2507",
        "mistralai/mistral-small-3.2-24b-instruct",
        "meta-llama/llama-3.3-70b-instruct",
        "meta-llama/llama-4-scout",
        "minimax/minimax-m2.5",
        "z-ai/glm-4.7-flash",
      ]);
      expect(openrouter?.models).not.toContain("openrouter/free");
      expect(openrouter?.models).toContain("openai/gpt-oss-20b:free");
      expect(openrouter?.models.length).toBeGreaterThan(19);
      expect(openrouter?.credentialSource).toContain("subscription-managed key");
    } finally {
      if (previous === undefined) {
        delete process.env.OPENROUTER_API_KEY;
      } else {
        process.env.OPENROUTER_API_KEY = previous;
      }
    }
    });
  });

  it("prioritizes hosted OpenRouter for paid managed sessions", () => {
    withProAuthSession(() => {
      const previous = process.env.OPENROUTER_API_KEY;
      delete process.env.OPENROUTER_API_KEY;
      try {
        const snapshot = readProviderMenuSnapshot({
          ...mkctx(stubSession({ provider: "grok", model: "grok-4.3" }), ""),
          configStore: {
            current: () => ({
              auth: { managedKeys: { enabled: true } },
            }),
          } as SlashCommandContext["configStore"],
        });

        expect(snapshot.rows[0]).toMatchObject({
          provider: "openrouter",
          authState: "managed",
          auth: "subscription",
          model: "x-ai/grok-4.3",
        });
        expect(snapshot.rows[snapshot.activeIndex]?.provider).toBe("openrouter");
        expect(snapshot.currentProvider).toBe("grok");
      } finally {
        if (previous === undefined) {
          delete process.env.OPENROUTER_API_KEY;
        } else {
          process.env.OPENROUTER_API_KEY = previous;
        }
      }
    });
  });

  it("does not mark providers without live managed routes as subscription-managed", () => {
    const previous = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const snapshot = readProviderMenuSnapshot({
        ...mkctx(stubSession({ provider: "grok", model: "grok-4.3" }), ""),
        configStore: {
          current: () => ({
            auth: { managedKeys: { enabled: true } },
          }),
        } as SlashCommandContext["configStore"],
      });
      const openai = snapshot.rows.find(row => row.provider === "openai");

      expect(openai).toMatchObject({
        authState: "missing",
      });
      expect(openai?.auth).toContain("OPENAI_API_KEY");
      expect(openai?.credentialSource).toContain("OPENAI_API_KEY");
      expect(openai?.credentialSource).not.toContain("subscription-managed key");
    } finally {
      if (previous === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previous;
      }
    }
  });

  it("marks local providers as local-only under managed subscription mode", () => {
    const previous = process.env.LMSTUDIO_API_KEY;
    delete process.env.LMSTUDIO_API_KEY;
    try {
      const snapshot = readProviderMenuSnapshot({
        ...mkctx(stubSession({ provider: "grok", model: "grok-4.3" }), ""),
        configStore: {
          current: () => ({
            auth: { managedKeys: { enabled: true } },
          }),
        } as SlashCommandContext["configStore"],
      });
      const lmstudio = snapshot.rows.find(row => row.provider === "lmstudio");

      expect(lmstudio).toMatchObject({
        runtimeState: "local",
        authState: "optional",
        auth: "local only",
        detail: "local endpoint",
      });
      expect(lmstudio?.credentialSource).toContain("subscription is not used");
    } finally {
      if (previous === undefined) {
        delete process.env.LMSTUDIO_API_KEY;
      } else {
        process.env.LMSTUDIO_API_KEY = previous;
      }
    }
  });

  it("does not block direct switches to local providers under managed subscription mode", async () => {
    const previous = process.env.LMSTUDIO_API_KEY;
    delete process.env.LMSTUDIO_API_KEY;
    try {
      const session = stubSession({ provider: "grok", model: "grok-4.3" });
      const res = await providerCommand.execute({
        ...mkctx(session, "lmstudio"),
        configStore: {
          current: () => ({
            auth: { managedKeys: { enabled: true } },
          }),
        } as SlashCommandContext["configStore"],
      });

      expect(res.kind).toBe("text");
      if (res.kind === "text") {
        expect(res.text).toContain('Provider switched to "lmstudio"');
        expect(res.text).not.toContain("subscription-managed access");
      }
      const pending = (session as unknown as {
        pendingProviderSwitch: { provider: string; model: string } | null;
      }).pendingProviderSwitch;
      expect(pending).toEqual({ provider: "lmstudio", model: "gpt-4o-mini" });
    } finally {
      if (previous === undefined) {
        delete process.env.LMSTUDIO_API_KEY;
      } else {
        process.env.LMSTUDIO_API_KEY = previous;
      }
    }
  });

  it("blocks direct provider switches to providers without subscription-managed routes or BYOK", async () => {
    const previous = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const res = await providerCommand.execute({
        ...mkctx(stubSession({ provider: "grok", model: "grok-4.3" }), "openai"),
        configStore: {
          current: () => ({
            auth: { managedKeys: { enabled: true } },
          }),
        } as SlashCommandContext["configStore"],
      });

      expect(res).toEqual({
        kind: "text",
        text: expect.stringContaining(
          "hosted subscription access is available through OpenRouter",
        ),
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
