import { describe, expect, it, vi } from "vitest";
import modelCommand, {
  applyModelSwitch,
  checkModelHistoryCompat,
} from "./model.js";
import type { Session } from "../session/session.js";
import type { SlashCommandContext } from "./types.js";
import { createProvider } from "../llm/provider.js";
import type { LLMProvider } from "../llm/types.js";

interface StubSessionOpts {
  provider?: string;
  model?: string;
  reasoningEffort?: string;
  history?: unknown[];
  activeTurn?: unknown;
  abortTerminal?: ReturnType<typeof vi.fn>;
  pendingProviderSwitch?: unknown;
  providerInstance?: LLMProvider;
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
    services: {
      provider: LLMProvider | { config: { apiKey: string; baseURL: string } };
      registry: { toLLMTools: () => [] };
    };
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
      provider: opts.providerInstance ?? {
        config: {
          apiKey: "test-key",
          baseURL: "https://api.x.ai/v1",
        },
      },
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

async function withEnv<T>(
  overrides: Record<string, string | undefined>,
  run: () => Promise<T> | T,
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function mkctx(session: Session, argsRaw = ""): SlashCommandContext {
  return { session, argsRaw, cwd: "/ws", home: "/home/test" };
}

describe("checkModelHistoryCompat", () => {
  it("returns compatible when the target model can satisfy current session requirements", () => {
    const session = stubSession();
    const result = checkModelHistoryCompat(session, "grok-4-fast");
    expect(result.compatible).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("blocks a switch when the session requests reasoning effort the target model cannot honor", () => {
    const session = stubSession({
      provider: "openai",
      model: "gpt-5",
      reasoningEffort: "high",
    });
    const result = checkModelHistoryCompat(session, "gpt-4.1");
    expect(result.compatible).toBe(false);
    expect(result.missingCapabilities).toContain("reasoning effort");
    expect(result.reason).toMatch(/reasoning effort/);
  });

  it("blocks a switch when the session contains thinking history and the target model family lacks it", () => {
    const session = stubSession({
      provider: "openai",
      model: "gpt-5",
      history: [
        {
          role: "assistant",
          content: [
            { type: "thinking", text: "hidden chain of thought summary" },
          ],
        },
      ],
    });
    const result = checkModelHistoryCompat(session, "gpt-4.1");
    expect(result.compatible).toBe(false);
    expect(result.missingCapabilities).toContain("thinking history");
    expect(result.reason).toMatch(/thinking history/);
  });
});

describe("modelCommand", () => {
  it("is userInvocable and immediate", () => {
    expect(modelCommand.userInvocable).toBe(true);
    expect(modelCommand.immediate).toBe(true);
    expect(modelCommand.name).toBe("model");
  });

  it("returns a usage error when args are empty", async () => {
    const session = stubSession();
    const res = await modelCommand.execute(mkctx(session, ""));
    expect(res.kind).toBe("error");
    if (res.kind === "error") {
      expect(res.message).toMatch(/Usage: \/model/);
    }
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
      expect(res.text).toMatch(/was "grok-4"/);
    }
    // Pending switch must be populated with provider + target model.
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
    expect(pending).toEqual({ provider: "grok", model: "grok-4-fast" });
  });

  it("applyModelSwitch does not invoke abortTerminal when no turn is active", async () => {
    const abortTerminal = vi.fn();
    const session = stubSession({ abortTerminal });
    await applyModelSwitch(session, "grok-4-fast");
    expect(abortTerminal).not.toHaveBeenCalled();
  });

  it("does not stage a switch when the target model is incompatible", async () => {
    const abortTerminal = vi.fn();
    const session = stubSession({
      provider: "openai",
      model: "gpt-5",
      reasoningEffort: "high",
      abortTerminal,
    });
    const summary = await applyModelSwitch(session, "gpt-4.1");
    expect(summary).toMatch(/blocked/);
    expect(summary).toMatch(/reasoning effort/);
    expect(abortTerminal).not.toHaveBeenCalled();
    expect(
      (session as unknown as { pendingProviderSwitch: unknown }).pendingProviderSwitch,
    ).toBeNull();
  });

  it("blocks switching away from OpenAI reasoning models when thinking history is already present", async () => {
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
    const summary = await applyModelSwitch(session, "gpt-4.1");
    expect(summary).toMatch(/blocked/);
    expect(summary).toMatch(/thinking history/);
    expect(
      (session as unknown as { pendingProviderSwitch: unknown }).pendingProviderSwitch,
    ).toBeNull();
  });

  it("blocks model switches when the current provider slug cannot be rebuilt", async () => {
    const session = stubSession({
      provider: "some-provider",
      model: "grok-4",
    });
    const summary = await applyModelSwitch(session, "grok-4-fast");
    expect(summary).toMatch(/blocked/);
    expect(summary).toMatch(/unknown provider/i);
    expect(
      (session as unknown as { pendingProviderSwitch: unknown }).pendingProviderSwitch,
    ).toBeNull();
  });

  it("prefers the live provider snapshot over stale session provider state", async () => {
    await withEnv(
      {
        OPENAI_API_KEY: undefined,
        OPENAI_BASE_URL: "https://wrong.openai.example/v1",
        OPENAI_MODEL: "wrong-openai-model",
      },
      async () => {
        const session = stubSession({
          provider: "openai",
          model: "openai/gpt-5-mini",
          activeTurn: { turnId: "t1" },
          providerInstance: createProvider("openrouter", {
            apiKey: "or-test",
            baseURL: "https://router.example/api/v1",
            model: "openai/gpt-5-mini",
          }),
        });

        const summary = await applyModelSwitch(session, "openai/gpt-5");

        expect(summary).toMatch(/staged/);
        expect(
          (session as unknown as {
            pendingProviderSwitch: { provider: string; model: string } | null;
          }).pendingProviderSwitch,
        ).toEqual({
          provider: "openrouter",
          model: "openai/gpt-5",
        });
      },
    );
  });

  it("whitespace-only args are treated as empty", async () => {
    const res = await modelCommand.execute(mkctx(stubSession(), "   "));
    expect(res.kind).toBe("error");
  });

  it("does not mention provider-specific brands in output strings", async () => {
    const session = stubSession();
    const res = await modelCommand.execute(mkctx(session, "some-model"));
    expect(res.kind).toBe("text");
    if (res.kind === "text") {
      expect(res.text.toLowerCase()).not.toContain("claude");
      expect(res.text.toLowerCase()).not.toContain("anthropic");
      expect(res.text.toLowerCase()).not.toContain("openclaude");
    }
  });
});
