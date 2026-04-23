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
  lastCompactionMs?: number | null;
}) {
  return {
    state: { unsafePeek: () => ({ history: opts.history ?? [] }) },
    budgetTracker:
      opts.emitted === undefined
        ? null
        : { emitted: opts.emitted, remaining: opts.remaining ?? null },
    eventLog: { lastCompactionMs: opts.lastCompactionMs ?? null },
  } as unknown as Session;
}

describe("contextCommand", () => {
  it("reports tokens, limit, message count, and last compaction", () => {
    const snap = collectContextSnapshot(
      stubSession({
        history: [1, 2, 3],
        emitted: 500,
        remaining: 1500,
        lastCompactionMs: 1_700_000_000_000,
      }),
    );
    expect(snap.tokensUsed).toBe(500);
    expect(snap.tokensLimit).toBe(2000);
    expect(snap.messageCount).toBe(3);
    expect(snap.lastCompactionMs).toBe(1_700_000_000_000);
    const text = formatContext(snap);
    expect(text).toMatch(/500 \/ 2000/);
    expect(text).toMatch(/Message count/);
    expect(text).toMatch(/Last compaction/);
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
