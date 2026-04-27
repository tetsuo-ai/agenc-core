import { describe, expect, it, vi } from "vitest";
import modelCommand, {
  applyModelSwitch,
  checkModelHistoryCompat,
} from "./model.js";
import type { Session } from "../session/session.js";
import type { SlashCommandContext } from "./types.js";

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

function mkctx(session: Session, argsRaw = ""): SlashCommandContext {
  return { session, argsRaw, cwd: "/ws", home: "/home/test" };
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
    const pending = (session as unknown as {
      pendingProviderSwitch: { provider: string; model: string } | null;
    }).pendingProviderSwitch;
    expect(pending).toEqual({ provider: "xai", model: "grok-4-fast" });
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

  it("applyModelSwitch does not invoke abortTerminal when no turn is active", async () => {
    const abortTerminal = vi.fn();
    const session = stubSession({ abortTerminal });
    await applyModelSwitch(session, "grok-4-fast");
    expect(abortTerminal).not.toHaveBeenCalled();
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
      expect(res.text.toLowerCase()).not.toContain("AgenC");
    }
  });
});
