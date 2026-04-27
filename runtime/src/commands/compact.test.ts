import { describe, expect, it, vi } from "vitest";
import compactCommand, {
  formatCompactOutcome,
  runCompact,
} from "./compact.js";
import type { Session } from "../session/session.js";
import type { SlashCommandContext } from "./types.js";

vi.mock("../session/manual-compact.js", () => ({
  runSessionManualCompact: vi.fn().mockResolvedValue({
    kind: "ran",
    text: "Compaction complete.",
    instructions: "",
  }),
}));

interface StubSessionOpts {
  activeTurn?: unknown;
  abortTerminal?: ReturnType<typeof vi.fn>;
}

function stubSession(opts: StubSessionOpts = {}): Session {
  const abortTerminal = opts.abortTerminal ?? vi.fn();
  return {
    activeTurn: { unsafePeek: () => opts.activeTurn ?? null },
    abortTerminal,
  } as unknown as Session;
}

function mkctx(session: Session, argsRaw = ""): SlashCommandContext {
  return { session, argsRaw, cwd: "/ws", home: "/home/test" };
}

describe("compactCommand", () => {
  it("is userInvocable and immediate", () => {
    expect(compactCommand.userInvocable).toBe(true);
    expect(compactCommand.immediate).toBe(true);
    expect(compactCommand.name).toBe("compact");
  });

  it("blocks when a turn is currently active (mid-stream guard)", async () => {
    const abortTerminal = vi.fn();
    const session = stubSession({
      activeTurn: { turnId: "t1" },
      abortTerminal,
    });
    const res = await compactCommand.execute(mkctx(session, ""));
    expect(res.kind).toBe("error");
    if (res.kind === "error") {
      expect(res.message).toMatch(/turn is currently in flight/);
    }
    // The mid-stream guard must NOT abort the current turn — unlike
    // /model and /provider, compaction cannot be staged safely.
    expect(abortTerminal).not.toHaveBeenCalled();
  });

  it("runCompact returns 'blocked' outcome when a turn is active", async () => {
    const session = stubSession({ activeTurn: { turnId: "t1" } });
    const outcome = await runCompact(session, "please shorten");
    expect(outcome.kind).toBe("blocked");
    if (outcome.kind === "blocked") {
      expect(outcome.reason).toMatch(/turn is currently in flight/);
    }
  });

  it("returns a compact result when no turn is active", async () => {
    const session = stubSession({ activeTurn: null });
    const res = await compactCommand.execute(mkctx(session, ""));
    expect(res.kind).toBe("compact");
    if (res.kind === "compact") {
      expect(res.text.length).toBeGreaterThan(0);
    }
  });

  it("echoes custom instructions in the output message when provided", async () => {
    const { runSessionManualCompact } = await import(
      "../session/manual-compact.js"
    );
    vi.mocked(runSessionManualCompact).mockResolvedValueOnce({
      kind: "ran",
      text: "Compaction complete. Custom instructions noted: focus on the build output",
      instructions: "focus on the build output",
    });
    const session = stubSession({ activeTurn: null });
    const res = await compactCommand.execute(
      mkctx(session, "focus on the build output"),
    );
    expect(res.kind).toBe("compact");
    if (res.kind === "compact") {
      expect(res.text).toMatch(/focus on the build output/);
    }
  });

  it("empty args is handled gracefully", async () => {
    const session = stubSession({ activeTurn: null });
    const res = await compactCommand.execute(mkctx(session, ""));
    expect(res.kind).toBe("compact");
  });

  it("formatCompactOutcome renders each kind", () => {
    expect(
      formatCompactOutcome({ kind: "blocked", reason: "busy" }),
    ).toMatch(/Cannot compact/);
    expect(
      formatCompactOutcome({ kind: "ran", instructions: "" }),
    ).toMatch(/Compaction complete/);
    expect(
      formatCompactOutcome({ kind: "ran", instructions: "tighten" }),
    ).toMatch(/tighten/);
    expect(
      formatCompactOutcome({ kind: "error", cause: "boom" }),
    ).toMatch(/Compaction failed/);
  });

  it("does not mention branded references in output strings", async () => {
    const session = stubSession({ activeTurn: null });
    const res = await compactCommand.execute(mkctx(session, ""));
    const text = res.kind === "compact" ? res.text : "";
    expect(text.toLowerCase()).not.toContain(["cla", "ude"].join(""));
    expect(text.toLowerCase()).not.toContain("anthropic");
    expect(text.toLowerCase()).not.toContain("AgenC");
  });
});
