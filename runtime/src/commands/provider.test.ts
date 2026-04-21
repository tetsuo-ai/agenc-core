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
  activeTurn?: unknown;
  abortTerminal?: ReturnType<typeof vi.fn>;
  pendingProviderSwitch?: unknown;
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
    setPendingProviderSwitch(next: unknown): void;
  } = {
    state: { unsafePeek: () => ({ sessionConfiguration }) },
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

describe("providerCommand", () => {
  it("is userInvocable and immediate", () => {
    expect(providerCommand.userInvocable).toBe(true);
    expect(providerCommand.immediate).toBe(true);
    expect(providerCommand.name).toBe("provider");
  });

  it("re-exports the I-57 stub so callers can reach it without model.js", () => {
    const session = stubSession();
    const compat = checkModelHistoryCompat(session, "grok-4");
    expect(compat.compatible).toBe(true);
  });

  it("returns a usage error when args are empty", async () => {
    const session = stubSession();
    const res = await providerCommand.execute(mkctx(session, ""));
    expect(res.kind).toBe("error");
    if (res.kind === "error") {
      expect(res.message).toMatch(/Usage: \/provider/);
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
      expect(res.text).toMatch(/was "xai"/);
    }
    const pending = (session as unknown as {
      pendingProviderSwitch: { provider: string; model: string } | null;
    }).pendingProviderSwitch;
    expect(pending).toEqual({ provider: "ollama", model: "grok-4" });
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
    expect(pending).toEqual({ provider: "ollama", model: "grok-4" });
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
      expect(res.text.toLowerCase()).not.toContain("openclaude");
    }
  });
});
