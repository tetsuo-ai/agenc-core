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
    abortTerminal: ReturnType<typeof vi.fn>;
    pendingProviderSwitch: unknown;
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
  it("returns compatible when the target model can satisfy current session requirements", () => {
    const session = stubSession();
    const result = checkModelHistoryCompat(session, "grok-4-fast");
    expect(result.compatible).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("blocks a switch when the session requests reasoning_effort the target model cannot honor", () => {
    const session = stubSession({
      provider: "xai",
      model: "grok-4.20-multi-agent-0309",
      reasoningEffort: "high",
    });
    const result = checkModelHistoryCompat(session, "grok-4-fast");
    expect(result.compatible).toBe(false);
    expect(result.missingCapabilities).toContain("reasoning_effort");
    expect(result.reason).toMatch(/reasoning_effort/);
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

  it("applyModelSwitch does not invoke abortTerminal when no turn is active", async () => {
    const abortTerminal = vi.fn();
    const session = stubSession({ abortTerminal });
    await applyModelSwitch(session, "grok-4-fast");
    expect(abortTerminal).not.toHaveBeenCalled();
  });

  it("does not stage a switch when the target model is incompatible", async () => {
    const abortTerminal = vi.fn();
    const session = stubSession({
      provider: "xai",
      model: "grok-4.20-multi-agent-0309",
      reasoningEffort: "high",
      abortTerminal,
    });
    const summary = await applyModelSwitch(session, "grok-4-fast");
    expect(summary).toMatch(/blocked/);
    expect(summary).toMatch(/reasoning_effort/);
    expect(abortTerminal).not.toHaveBeenCalled();
    expect(
      (session as unknown as { pendingProviderSwitch: unknown }).pendingProviderSwitch,
    ).toBeNull();
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
