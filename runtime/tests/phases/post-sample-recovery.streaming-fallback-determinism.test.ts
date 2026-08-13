import { describe, expect, test } from "vitest";

import { buildInitialTurnState } from "../session/turn-state.js";
import { postSampleRecovery } from "./post-sample-recovery.js";
import { mkCtx, mkSession } from "../../tests/fixtures.js";
import type { TurnState } from "../session/turn-state.js";

/**
 * Puts the turn in the state `isStreamingFallbackOccured` recognises: a
 * partial assistant answer plus a recoverable stream error.
 */
function stageStreamingFallback(state: TurnState, text: string): void {
  state.transition = undefined;
  state.assistantMessages = [
    {
      uuid: `assistant-${state.assistantMessages.length}`,
      text,
      apiError: "provider_error",
      toolCalls: [],
    },
  ] as unknown as TurnState["assistantMessages"];
  (state as TurnState & { lastStreamError?: unknown }).lastStreamError =
    new Error("stream closed before completion");
}

describe("streaming fallback determinism guard", () => {
  test("retries once when the regenerated partial differs", async () => {
    const ctx = mkCtx();
    const { session } = mkSession();
    const state = buildInitialTurnState(ctx, {
      role: "user",
      content: "write the inventory",
    });

    stageStreamingFallback(state, "first attempt, partial answer");
    await postSampleRecovery(state, ctx, session);
    expect(state.transition).toEqual({ reason: "streaming_fallback_retry" });

    // A different partial means sampling is still moving; keep retrying.
    stageStreamingFallback(state, "second attempt, a DIFFERENT partial");
    await postSampleRecovery(state, ctx, session);
    expect(state.transition).toEqual({ reason: "streaming_fallback_retry" });
  });

  test("stops instead of re-rolling a byte-identical partial", async () => {
    const ctx = mkCtx();
    const { session } = mkSession();
    const state = buildInitialTurnState(ctx, {
      role: "user",
      content: "write the inventory",
    });

    // Observed on grok-4.6: the turn degenerated into repeating one token
    // until it hit the output cap, and consecutive attempts came back
    // byte-for-byte identical (36,879 characters each). Re-rolling that
    // burned the remaining re-entries for no output at all.
    const degenerate = ` leftover`.repeat(4_094);

    stageStreamingFallback(state, degenerate);
    await postSampleRecovery(state, ctx, session);
    expect(state.transition).toEqual({ reason: "streaming_fallback_retry" });

    stageStreamingFallback(state, degenerate);
    await postSampleRecovery(state, ctx, session);

    // No further retry: an identical partial proves regeneration is
    // deterministic, so the remaining re-entries cannot produce anything new.
    expect(state.transition).not.toEqual({
      reason: "streaming_fallback_retry",
    });
  });
});
