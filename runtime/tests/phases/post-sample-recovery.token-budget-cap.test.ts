import { describe, expect, test } from "vitest";
import { buildInitialTurnState } from "../session/turn-state.js";
import { applyPendingBudgetContinuation } from "./post-sample-recovery.js";
import { MAX_RECOVERY_REENTRIES } from "../recovery/fallback-ladder.js";
import { mkCtx, mkSession } from "../../tests/fixtures.js";
import type { TurnState } from "../session/turn-state.js";

function pendBudgetStop(state: TurnState, reason: string): void {
  state.pendingBudgetDecision = { kind: "stop", reason };
}

describe("token-budget continuation re-entry cap", () => {
  test("survives far more than MAX_RECOVERY_REENTRIES continuations", async () => {
    const ctx = mkCtx();
    const { session } = mkSession();
    const state = buildInitialTurnState(ctx, {
      role: "user",
      content: "spend 500k tokens",
    });

    // The recovery safety cap is 5. A large token target legitimately
    // needs far more continuations; the regression was that the budget
    // path shared that cap and silently stopped after ~5.
    const rounds = MAX_RECOVERY_REENTRIES * 4;
    for (let i = 0; i < rounds; i++) {
      pendBudgetStop(state, `keep working (${i})`);
      await applyPendingBudgetContinuation(state, ctx, session);

      // Every round must continue, not silently halt.
      expect(state.transition).toEqual({
        reason: "token_budget_continuation",
      });
      expect(state.pendingBudgetDecision).toBeUndefined();
      // The injected continuation prompt is appended to the message log.
      expect(state.messages.at(-1)).toEqual({
        role: "user",
        content: `keep working (${i})`,
      });

      // Simulate run-turn consuming the transition before next iteration.
      state.transition = undefined;
    }

    // We pushed `rounds` continuation user messages beyond the seed.
    const continuationMessages = state.messages.filter(
      (m) => typeof m.content === "string" && m.content.startsWith("keep working"),
    );
    expect(continuationMessages).toHaveLength(rounds);
  });

  test("does not consume the recovery safety cap", async () => {
    const ctx = mkCtx();
    const { session } = mkSession();
    const state = buildInitialTurnState(ctx, {
      role: "user",
      content: "spend 500k tokens",
    });

    // Pretend a couple of genuine recovery re-entries already happened.
    state.recoveryReentryCount = 3;

    pendBudgetStop(state, "keep working");
    await applyPendingBudgetContinuation(state, ctx, session);

    // A successful (non-recovery) budget continuation resets the recovery
    // safety cap, leaving it fully available for genuine recovery loops.
    expect(state.recoveryReentryCount).toBe(0);
    expect(state.transition).toEqual({ reason: "token_budget_continuation" });
  });

  test("no-op when there is no pending budget stop decision", async () => {
    const ctx = mkCtx();
    const { session } = mkSession();
    const state = buildInitialTurnState(ctx, {
      role: "user",
      content: "hi",
    });
    const before = [...state.messages];

    await applyPendingBudgetContinuation(state, ctx, session);

    expect(state.transition).toBeUndefined();
    expect(state.messages).toEqual(before);
  });
});
