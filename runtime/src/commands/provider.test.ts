import { describe, expect, it, vi } from "vitest";
import providerCommand, {
  applyProviderSwitch,
  checkModelHistoryCompat,
} from "./provider.js";
import type { Session } from "../session/session.js";
import type { SlashCommandContext } from "./types.js";

interface StubSessionOpts {
  provider?: string;
  model?: string;
  reasoningEffort?: string;
  history?: unknown[];
  activeTurn?: unknown;
  abortTerminal?: ReturnType<typeof vi.fn>;
  pendingProviderSwitch?: unknown;
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
    services: { registry: { toLLMTools: () => [] } };
    abortTerminal: ReturnType<typeof vi.fn>;
    pendingProviderSwitch: unknown;
    setPendingProviderSwitch(next: unknown): void;
    consumePendingProviderSwitch(): Promise<{
      applied: boolean;
      provider?: string;
      model?: string;
      reason?: string;
    }>;
  } = {
    state: {
      unsafePeek: () => ({
        sessionConfiguration,
        history: opts.history ?? [],
      }),
    },
    activeTurn: { unsafePeek: () => opts.activeTurn ?? null },
    services: {
      registry: {
        toLLMTools: () => [],
      },
    },
    abortTerminal,
    pendingProviderSwitch: opts.pendingProviderSwitch ?? null,
    setPendingProviderSwitch(next) {
      this.pendingProviderSwitch = next;
    },
    async consumePendingProviderSwitch() {
      const pending = this.pendingProviderSwitch as
        | { provider: string; model: string }
        | null;
      if (!pending) {
        return { applied: false, reason: "no pending provider switch" };
      }
      sessionConfiguration.provider = { slug: pending.provider };
      sessionConfiguration.collaborationMode.model = pending.model;
      this.pendingProviderSwitch = null;
      return {
        applied: true,
        provider: pending.provider,
        model: pending.model,
      };
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
    expect(providerCommand.aliases).toContain("provider");
  });

  it("re-exports the I-57 stub so callers can reach it without model.js", () => {
    const session = stubSession();
    const compat = checkModelHistoryCompat(session, "grok-4");
    expect(compat.compatible).toBe(true);
  });

  it("blocks provider switches that would strand image-bearing history", async () => {
    const session = stubSession({
      provider: "xai",
      model: "grok-4",
      history: [
        {
          role: "user",
          content: [
            { type: "text", text: "look at this" },
            { type: "image_url", image_url: { url: "file:///tmp/example.png" } },
          ],
        },
      ],
    });
    const summary = await applyProviderSwitch(session, "ollama");
    expect(summary).toMatch(/blocked/);
    expect(summary).toMatch(/image history/);
    expect(
      (session as unknown as { pendingProviderSwitch: unknown }).pendingProviderSwitch,
    ).toBeNull();
  });

  it("allows image-bearing history when switching to openai", async () => {
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-test";
    try {
      const session = stubSession({
        provider: "xai",
        model: "gpt-5",
        history: [
          {
            role: "user",
            content: [
              { type: "text", text: "look at this" },
              { type: "image_url", image_url: { url: "file:///tmp/example.png" } },
            ],
          },
        ],
      });
      const summary = await applyProviderSwitch(session, "openai");
      expect(summary).toMatch(/switched to "openai"/);
      expect(summary).toMatch(/model "gpt-5"/);
      expect(
        (session as unknown as {
          pendingProviderSwitch: { provider: string; model: string } | null;
        }).pendingProviderSwitch,
      ).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
  });

  it("allows image-bearing history when switching to anthropic", async () => {
    const previous = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "anthropic-test";
    try {
      const session = stubSession({
        provider: "xai",
        model: "grok-4",
        history: [
          {
            role: "user",
            content: [
              { type: "text", text: "look at this" },
              { type: "image_url", image_url: { url: "file:///tmp/example.png" } },
            ],
          },
        ],
      });
      const summary = await applyProviderSwitch(session, "anthropic");
      expect(summary).toMatch(/switched to "anthropic"/);
      expect(summary).toMatch(/claude-opus-4-7/);
      expect(
        (session as unknown as {
          pendingProviderSwitch: { provider: string; model: string } | null;
        }).pendingProviderSwitch,
      ).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previous;
    }
  });

  it("allows thinking-bearing history when switching to the documented DeepSeek reasoner default", async () => {
    const previous = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = "deepseek-test";
    try {
      const session = stubSession({
        provider: "openai",
        model: "gpt-5",
        history: [
          {
            role: "assistant",
            content: [{ type: "thinking", text: "internal summary" }],
          },
        ],
      });
      const summary = await applyProviderSwitch(session, "deepseek");
      expect(summary).toMatch(/switched to "deepseek"/);
      expect(summary).toMatch(/deepseek-reasoner/);
      expect(
        (session as unknown as {
          pendingProviderSwitch: { provider: string; model: string } | null;
        }).pendingProviderSwitch,
      ).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = previous;
    }
  });

  it("blocks audio-bearing history when switching to gemini until replay serialization supports it", async () => {
    const previous = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = "gemini-test";
    try {
      const session = stubSession({
        provider: "openai",
        model: "gpt-5",
        history: [
          {
            role: "user",
            content: [{ type: "input_audio", audio_url: { url: "file:///tmp/example.wav" } }],
          },
        ],
      });
      const summary = await applyProviderSwitch(session, "gemini");
      expect(summary).toMatch(/blocked/);
      expect(summary).toMatch(/audio history/);
      expect(
        (session as unknown as {
          pendingProviderSwitch: { provider: string; model: string } | null;
        }).pendingProviderSwitch,
      ).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = previous;
    }
  });

  it("allows switching to gemini when persisted audio history is replayable as inline data", async () => {
    const previous = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = "gemini-test";
    try {
      const session = stubSession({
        provider: "openai",
        model: "gpt-audio",
        history: [
          {
            role: "user",
            content: [
              {
                type: "input_audio",
                audio_url: {
                  url: "data:audio/wav;base64,UklGRiQAAABXQVZFZm10",
                },
              },
            ],
          },
        ],
      });
      const summary = await applyProviderSwitch(session, "gemini");
      expect(summary).toMatch(/switched to "gemini"/);
      expect(summary).toMatch(/gemini-2\.5-pro/);
      expect(
        (session as unknown as {
          pendingProviderSwitch: { provider: string; model: string } | null;
        }).pendingProviderSwitch,
      ).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = previous;
    }
  });

  it("returns a usage error when args are empty", async () => {
    const session = stubSession();
    const res = await providerCommand.execute(mkctx(session, ""));
    expect(res.kind).toBe("error");
    if (res.kind === "error") {
      expect(res.message).toMatch(/Usage: \/model-provider/);
    }
  });

  it("accepts an optional model argument when switching providers", async () => {
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-test";
    try {
      const session = stubSession({
        provider: "xai",
        model: "grok-4",
        activeTurn: null,
      });
      const res = await providerCommand.execute(
        mkctx(session, "openai gpt-5"),
      );
      expect(res.kind).toBe("text");
      if (res.kind === "text") {
        expect(res.text).toMatch(/switched to "openai"/);
        expect(res.text).toMatch(/model "gpt-5"/);
      }
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
  });

  it("applies the switch immediately when no turn is active", async () => {
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
      expect(res.text).toMatch(/llama3\.3/);
      expect(res.text).toMatch(/was "grok" \/ "grok-4"/);
    }
    const pending = (session as unknown as {
      pendingProviderSwitch: { provider: string; model: string } | null;
    }).pendingProviderSwitch;
    expect(pending).toBeNull();
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
      expect(res.text).toMatch(/ollama\/llama3\.3/);
    }
    expect(abortTerminal).toHaveBeenCalledWith("provider_switched");
    const pending = (session as unknown as {
      pendingProviderSwitch: { provider: string; model: string } | null;
    }).pendingProviderSwitch;
    expect(pending).toEqual({ provider: "ollama", model: "llama3.3" });
  });

  it("applyProviderSwitch does not invoke abortTerminal when no turn is active", async () => {
    const abortTerminal = vi.fn();
    const session = stubSession({ abortTerminal });
    await applyProviderSwitch(session, "ollama");
    expect(abortTerminal).not.toHaveBeenCalled();
  });

  it("blocks provider switches to unknown providers before mutating session state", async () => {
    const session = stubSession();
    const summary = await applyProviderSwitch(session, "some-provider");
    expect(summary).toMatch(/blocked/);
    expect(summary).toMatch(/unknown provider/i);
    expect(
      (session as unknown as { pendingProviderSwitch: unknown }).pendingProviderSwitch,
    ).toBeNull();
  });

  it("does not carry the current model into providers that require their own configured model", async () => {
    const previousApiKey = process.env.OPENROUTER_API_KEY;
    const previousModel = process.env.OPENROUTER_MODEL;
    process.env.OPENROUTER_API_KEY = "or-test";
    delete process.env.OPENROUTER_MODEL;
    try {
      const session = stubSession({
        provider: "xai",
        model: "grok-4",
      });
      const summary = await applyProviderSwitch(session, "openrouter");
      expect(summary).toMatch(/blocked/);
      expect(summary).toMatch(/OPENROUTER_MODEL|model/i);
      expect(
        (session as unknown as { pendingProviderSwitch: unknown }).pendingProviderSwitch,
      ).toBeNull();
    } finally {
      if (previousApiKey === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = previousApiKey;
      if (previousModel === undefined) delete process.env.OPENROUTER_MODEL;
      else process.env.OPENROUTER_MODEL = previousModel;
    }
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
      expect(res.text.toLowerCase()).not.toContain("openclaude");
    }
  });
});
