import { describe, expect, test } from "vitest";

import { continuationNudge } from "src/phases/continuation-nudge";
import type { TurnContext } from "src/session/turn-context";
import type { TurnState } from "src/session/turn-state";
import type { Session } from "src/session/session";

/**
 * Revert-sensitive regression test for gaphunt #3 finding #34.
 *
 * #34 The continuation nudge is a synthetic, heuristic-driven user turn.
 *     A false-positive regex match must not pollute the durable
 *     rollout/transcript that --resume replays. The bounded fix marks the
 *     injected nudge message with runtimeOnly.excludeFromDurableHistory=true
 *     so syncSessionState's durable-history filter (run-turn.ts) drops it
 *     while it stays available in-context for the next iteration.
 *
 * NOTE: This test intentionally asserts ONLY the durability marker on the
 * injected nudge. The stop/continue decision heuristic is left unchanged per
 * the unit spec, so the first-half assertion in the finding's regressionTest
 * (no nudge on a "Next, I will run the verification" final answer) is NOT
 * implemented here — doing so would require redesigning the heuristic, which
 * is explicitly out of scope for this bounded data-integrity fix.
 */

function mkCtx(): TurnContext {
  return {
    config: { maxTurns: 10 },
  } as unknown as TurnContext;
}

function mkSession(): Session {
  return {} as Session;
}

function mkState(): TurnState {
  return {
    messages: [],
    messagesForQuery: [],
    autoCompactTracking: undefined,
    taskBudgetRemaining: undefined,
    snipTokensFreed: 0,
    pendingMemoryPrefetch: undefined,
    pendingSkillPrefetch: undefined,
    contentReplacementState: undefined,
    assistantMessages: [
      {
        uuid: "a1",
        role: "assistant",
        text: "Now I'll create the file.",
        toolCalls: [],
      },
    ],
    toolUseBlocks: [],
    needsFollowUp: false,
    toolResults: [],
    hasAttemptedReactiveCompact: true,
    maxOutputTokensOverride: 64_000,
    maxOutputTokensRecoveryCount: 2,
    recoveryReentryCount: 0,
    continuationNudgeCount: 0,
    streamingToolExecutor: null,
    pendingToolUseSummary: Promise.resolve(null),
    pendingBudgetDecision: undefined,
    lastResponseUsage: undefined,
    turnCount: 1,
    transition: undefined,
    stopHookActive: true,
    stopHookBlockingCount: 0,
  } as unknown as TurnState;
}

describe("continuationNudge — gaphunt3 #34 (non-durable nudge)", () => {
  test("injected nudge is marked excludeFromDurableHistory so --resume never replays it", async () => {
    const state = mkState();

    await continuationNudge(state, mkCtx(), mkSession());

    // Sanity: the heuristic still fired (behavior unchanged) and a nudge
    // was appended in-context.
    expect(state.transition?.reason).toBe("continuation_nudge");
    const nudge = state.messages.at(-1);
    expect(nudge?.role).toBe("user");
    expect(nudge?.content).toBe(
      "Continue with the task. Use the appropriate tools to proceed.",
    );

    // The core fix: the synthetic nudge must be flagged non-durable so the
    // run-turn durable-history / rollout filters
    // (excludeFromDurableHistory(message)) drop it and a heuristic
    // false positive cannot corrupt the resumable transcript.
    expect(nudge?.runtimeOnly?.excludeFromDurableHistory).toBe(true);
  });

  test("the run-turn durable-history filter would exclude the injected nudge", async () => {
    const state = mkState();

    await continuationNudge(state, mkCtx(), mkSession());

    const nudge = state.messages.at(-1);
    expect(nudge).toBeDefined();

    // Mirror run-turn.ts excludeFromDurableHistory(): the persisted-history
    // and rollout paths both skip messages carrying this marker. With the
    // fix the nudge is filtered out of durable history; without it the
    // synthetic turn would be persisted and replayed on --resume.
    const excludeFromDurableHistory = (m: typeof nudge): boolean =>
      m?.runtimeOnly?.excludeFromDurableHistory === true;

    expect(excludeFromDurableHistory(nudge)).toBe(true);
    const durable = state.messages.filter(
      (m) => !excludeFromDurableHistory(m),
    );
    expect(durable).not.toContain(nudge);
  });
});
