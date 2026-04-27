import { describe, expect, it, vi } from "vitest";
import providerCommand, {
  applyProviderSwitch,
  checkModelHistoryCompat,
} from "./provider.js";
import type { Session } from "../session/session.js";
import type { SlashCommandContext } from "./types.js";
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

function mkctx(session: Session, argsRaw = ""): SlashCommandContext {
  return { session, argsRaw, cwd: "/ws", home: "/home/test" };
}

describe("providerCommand", () => {
  it("is userInvocable and immediate", () => {
    expect(providerCommand.userInvocable).toBe(true);
    expect(providerCommand.immediate).toBe(true);
    expect(providerCommand.name).toBe("model-provider");
    expect(providerCommand.aliases).toEqual(["provider"]);
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

  it("returns a usage error when args are empty", async () => {
    const session = stubSession();
    const res = await providerCommand.execute(mkctx(session, ""));
    expect(res.kind).toBe("error");
    if (res.kind === "error") {
      expect(res.message).toMatch(/Usage: \/model-provider/);
    }
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
    expect(res.kind).toBe("error");
  });

  it("does not mention branded references in output strings", async () => {
    const session = stubSession();
    const res = await providerCommand.execute(
      mkctx(session, "some-provider"),
    );
    expect(res.kind).toBe("text");
    if (res.kind === "text") {
      expect(res.text.toLowerCase()).not.toContain("claude");
      expect(res.text.toLowerCase()).not.toContain("anthropic");
      expect(res.text.toLowerCase()).not.toContain("AgenC");
    }
  });
});
