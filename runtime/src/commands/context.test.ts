import { describe, expect, it } from "vitest";
import contextCommand, {
  collectContextSnapshot,
  formatContext,
} from "./context.js";
import type { Session } from "../session/session.js";

function stubSession(opts: {
  history?: unknown[];
  emitted?: number;
  remaining?: number | null;
}) {
  return {
    state: { unsafePeek: () => ({ history: opts.history ?? [] }) },
    budgetTracker:
      opts.emitted === undefined
        ? null
        : { emitted: opts.emitted, remaining: opts.remaining ?? null },
    eventLog: {},
  } as unknown as Session;
}

const compactBoundary = (timestamp: string) => ({
  type: "system",
  subtype: "compact_boundary",
  timestamp,
});

describe("contextCommand", () => {
  it("reports tokens, limit, message count, and last compaction from history", () => {
    const ts = "2026-04-23T10:00:00.000Z";
    const snap = collectContextSnapshot(
      stubSession({
        history: [{ role: "user" }, compactBoundary(ts), { role: "assistant" }],
        emitted: 500,
        remaining: 1500,
      }),
    );
    expect(snap.tokensUsed).toBe(500);
    expect(snap.tokensLimit).toBe(2000);
    expect(snap.messageCount).toBe(3);
    expect(snap.lastCompactionMs).toBe(Date.parse(ts));
    const text = formatContext(snap);
    expect(text).toMatch(/500 \/ 2000/);
    expect(text).toMatch(/Message count/);
    expect(text).toMatch(/Last compaction/);
  });

  it("returns the most-recent compact_boundary when multiple exist", () => {
    const older = "2026-04-22T10:00:00.000Z";
    const newer = "2026-04-23T10:00:00.000Z";
    const snap = collectContextSnapshot(
      stubSession({
        history: [
          compactBoundary(older),
          { role: "user" },
          compactBoundary(newer),
          { role: "assistant" },
        ],
        emitted: 0,
        remaining: 0,
      }),
    );
    expect(snap.lastCompactionMs).toBe(Date.parse(newer));
  });

  it("returns null when no compact_boundary marker exists", () => {
    const snap = collectContextSnapshot(
      stubSession({
        history: [{ role: "user" }, { role: "assistant" }],
        emitted: 100,
      }),
    );
    expect(snap.lastCompactionMs).toBeNull();
  });

  it("handles 'unlimited' when remaining is infinite", () => {
    const snap = collectContextSnapshot(
      stubSession({
        emitted: 100,
        remaining: Number.POSITIVE_INFINITY,
      }),
    );
    expect(snap.tokensLimit).toBeNull();
    const text = formatContext(snap);
    expect(text).toMatch(/unlimited/);
  });

  it("shows 'n/a (budget disabled)' when budget tracker absent", async () => {
    const res = await contextCommand.execute({
      session: stubSession({ history: [] }),
      argsRaw: "",
      cwd: "/ws",
      home: "/home/test",
    });
    expect(res.kind).toBe("text");
    if (res.kind === "text") {
      expect(res.text).toMatch(/n\/a \(budget disabled\)/);
      expect(res.text).toMatch(/Last compaction : never/);
    }
  });
});
