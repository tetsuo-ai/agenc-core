import { afterEach, describe, expect, test, vi } from "vitest";
import { runAutoCompact, setAutoCompactImplForTests } from "../../src/session/run-turn-compaction.js";
import { buildInitialTurnState } from "../../src/session/turn-state.js";
import { CompactionReconstructionRequiredError } from "../../src/services/compact/transaction-types.js";
import { mkCtx, mkSession } from "../fixtures.js";

afterEach(() => {
  setAutoCompactImplForTests(null);
  vi.restoreAllMocks();
});

describe("compaction failures never imply unchanged history", () => {
  test.each(["AbortError", "CompactionReconstructionRequiredError"])("propagates %s even for a non-strict caller", async (kind) => {
    const { session } = mkSession();
    const ctx = mkCtx();
    const state = buildInitialTurnState(ctx, { role: "user", content: "retain me" });
    const before = structuredClone(state.messages);
    const error = kind === "AbortError"
      ? new DOMException("cancel requested", "AbortError")
      : new CompactionReconstructionRequiredError("committed-attempt");
    setAutoCompactImplForTests(async () => { throw error; });

    await expect(runAutoCompact(session, ctx, "do_not_inject", "context_limit", "pre_turn", state))
      .rejects.toBe(error);
    expect(state.messages).toEqual(before);
  });

  test("does not call a partially applied legacy projection a harmless refusal", async () => {
    const { session } = mkSession();
    const ctx = mkCtx();
    const state = buildInitialTurnState(ctx, { role: "user", content: "before" });
    const error = new Error("projection callback failed after state changed");
    setAutoCompactImplForTests(async () => ({
      wasCompacted: true,
      compactionResult: {
        message: "summary",
        replacementHistory: [{ role: "user", content: "replacement" }],
      },
    }));

    await expect(runAutoCompact(session, ctx, "do_not_inject", "context_limit", "in_turn", state, {
      onDurableHistoryReplaced: () => { throw error; },
    })).rejects.toBe(error);
    expect(state.messages[0]?.content).toBe("replacement");
  });

  test("never treats untyped error prose as advisory summary rejection", async () => {
    const { session } = mkSession();
    const ctx = mkCtx();
    const state = buildInitialTurnState(ctx, { role: "user", content: "retain me" });
    const deferred = vi.fn();
    const error = new Error("facts[0] cites an unplanned source ref");
    setAutoCompactImplForTests(async () => { throw error; });

    await expect(runAutoCompact(session, ctx, "do_not_inject", "context_limit", "pre_turn", state, {
      propagateErrors: true,
      onAdvisoryRefusal: deferred,
    })).rejects.toBe(error);
    expect(deferred).not.toHaveBeenCalled();
    expect(state.messages[0]?.content).toBe("retain me");
  });
});
