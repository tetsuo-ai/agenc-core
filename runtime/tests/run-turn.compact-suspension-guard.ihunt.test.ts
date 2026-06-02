import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  maybeRunPreviousModelInlineCompact,
  setAutoCompactImplForTests,
  type AutoCompactResult,
} from "../src/session/run-turn.js";
import { buildInitialTurnState } from "../src/session/turn-state.js";
import { mkCtx, mkSession } from "./fixtures.js";
import type { LLMMessage } from "../src/llm/types.js";
import type { TurnContext } from "../src/session/turn-context.js";
import type { TurnState } from "../src/session/turn-state.js";

/**
 * Regression guard for: "Auto-compaction during a rollout-persistence-
 * suspended fork turn writes a `compacted` item into the source session's
 * durable rollout, corrupting it on resume."
 *
 * thread-manager.runForkTurn() runs a forked / background-agent turn ON the
 * source session, wrapped in withRolloutPersistenceSuspended(...), precisely
 * so the fork's history never touches the source's durable rollout. Every
 * durable write in the turn engine is gated on
 * session.isRolloutPersistenceSuspended(). The `compacted` append in
 * runAutoCompact() was the one path that leaked through that guard: if a fork
 * turn crossed the auto-compact token threshold, the fork's summarized
 * replacementHistory was persisted into the SOURCE rollout JSONL and became
 * the baseline `state.history` on a later --resume, silently destroying the
 * user's real main-thread conversation.
 *
 * These tests drive runAutoCompact() via the exported
 * maybeRunPreviousModelInlineCompact() model-downshift entry point, with a
 * stubbed compact impl, and assert the compacted item is persisted ONLY when
 * persistence is NOT suspended.
 */

const COMPACT_RESULT: AutoCompactResult = {
  wasCompacted: true,
  compactionResult: {
    message: "fork-summary",
    // The fork's summarized history. This is exactly the payload that must
    // NOT leak into the source session's durable rollout.
    replacementHistory: [
      { role: "user", content: "FORK SECRET — must not reach source rollout" },
    ],
    preCompactTokens: 1000,
    postCompactTokens: 10,
  } as unknown as NonNullable<AutoCompactResult["compactionResult"]>,
};

/**
 * Builds a session + ctx + state pre-wired so that
 * maybeRunPreviousModelInlineCompact() decides to run a model-downshift
 * compact and reaches runAutoCompact().
 *
 *   - previousTurnSettings.model differs from ctx.modelInfo.slug
 *   - previousTurnSettings.contextWindow (old) > ctx.modelInfo.contextWindow (new)
 *   - totalUsageTokens >= new context window -> previousModelLimitReached
 */
function mkDownshiftFixture(): {
  session: ReturnType<typeof mkSession>["session"];
  appendRollout: ReturnType<typeof vi.fn>;
  ctx: TurnContext;
  state: TurnState;
} {
  const history: LLMMessage[] = [
    { role: "user", content: "real main-thread question" },
    { role: "assistant", content: "real main-thread answer" },
  ];
  const { session, state: rawState } = mkSession({ history });

  // Smaller new context window than the previous model -> downshift.
  // effectiveContextWindowPercent is required by modelContextWindow().
  const ctx = mkCtx({
    modelInfo: {
      slug: "new-small-model",
      contextWindow: 1024,
      effectiveContextWindowPercent: 100,
    } as never,
  });

  // Seed previousTurnSettings on the live session state object so
  // maybeRunPreviousModelInlineCompact() resolves a larger old window.
  (rawState as unknown as Record<string, unknown>).previousTurnSettings = {
    model: "old-large-model",
    contextWindow: 8192,
  };

  const appendRollout = vi.fn();
  (session as unknown as { rolloutStore: unknown }).rolloutStore = {
    appendRollout,
    isDegraded: false,
    flushDurable: () => {},
    append: () => {},
  };

  const state = buildInitialTurnState(
    ctx,
    { role: "user", content: "continue" },
    { priorMessages: history },
  );
  state.messagesForQuery = state.messages.map((m) => ({ ...m }));

  return { session, appendRollout, ctx, state };
}

function compactedAppendCalls(appendRollout: ReturnType<typeof vi.fn>): number {
  return appendRollout.mock.calls.filter(
    (call) => (call[0] as { type?: string })?.type === "compacted",
  ).length;
}

describe("runAutoCompact durable rollout suspension guard", () => {
  beforeEach(() => {
    // The downshift path is gated on auto-compact being enabled.
    delete process.env.DISABLE_AUTO_COMPACT;
    delete process.env.AGENC_DISABLE_AUTO_COMPACT;
    setAutoCompactImplForTests(async (): Promise<AutoCompactResult> => ({
      ...COMPACT_RESULT,
    }));
  });

  afterEach(() => {
    setAutoCompactImplForTests(null);
  });

  test("control: persists `compacted` item when persistence is NOT suspended", async () => {
    const { session, appendRollout, ctx, state } = mkDownshiftFixture();

    const compacted = await maybeRunPreviousModelInlineCompact(
      session,
      ctx,
      1_000_000,
      state,
    );

    // Sanity: the downshift compact actually ran (otherwise the test below
    // would pass for the wrong reason).
    expect(compacted).toBe(true);
    expect(compactedAppendCalls(appendRollout)).toBe(1);
  });

  test("does NOT persist `compacted` item when rollout persistence is suspended (fork turn)", async () => {
    const { session, appendRollout, ctx, state } = mkDownshiftFixture();

    let compacted = false;
    await session.withRolloutPersistenceSuspended(async () => {
      compacted = await maybeRunPreviousModelInlineCompact(
        session,
        ctx,
        1_000_000,
        state,
      );
    });

    // The compact still ran (in-memory state is updated)...
    expect(compacted).toBe(true);
    // ...but the fork's summarized history must NOT have been written to the
    // source session's durable rollout. If the suspension guard is reverted,
    // exactly one `compacted` item leaks here and this assertion fails.
    expect(compactedAppendCalls(appendRollout)).toBe(0);
    // Defense-in-depth: the leaked payload would carry the fork secret.
    for (const call of appendRollout.mock.calls) {
      expect(JSON.stringify(call[0])).not.toContain("FORK SECRET");
    }
  });
});
