import { describe, expect, test } from "vitest";
import {
  NOOP_COLLAPSE_DRIVER,
  runCollapseDrain,
  type CollapseDrainDriver,
} from "./collapse-drain.js";
import type { Session } from "../session/session.js";
import type { TurnState } from "../session/turn-state.js";
import type { LLMMessage } from "../llm/types.js";

function mkState(messages: LLMMessage[] = []): TurnState {
  return {
    messages: [],
    messagesForQuery: messages,
    autoCompactTracking: undefined,
    taskBudgetRemaining: undefined,
    snipTokensFreed: 0,
    pendingMemoryPrefetch: undefined,
    pendingSkillPrefetch: undefined,
    contentReplacementState: undefined,
    assistantMessages: [],
    toolUseBlocks: [],
    needsFollowUp: false,
    toolResults: [],
    hasAttemptedReactiveCompact: false,
    maxOutputTokensOverride: undefined,
    maxOutputTokensRecoveryCount: 0,
    recoveryReentryCount: 0,
    continuationNudgeCount: 0,
    streamingToolExecutor: null,
    pendingToolUseSummary: undefined,
    pendingBudgetDecision: undefined,
    turnCount: 1,
    transition: undefined,
    stopHookActive: undefined,
    stopHookBlockingCount: 0,
  };
}

const mockSession = {} as unknown as Session;

describe("collapse-drain", () => {
  test("one-shot guard — already-drained state returns skipped_guard", async () => {
    const state = mkState();
    state.transition = { reason: "collapse_drain_retry" };
    const out = await runCollapseDrain(state, { session: mockSession });
    expect(out.kind).toBe("skipped_guard");
  });

  test("no-op driver returns noop", async () => {
    const state = mkState();
    const out = await runCollapseDrain(state, {
      session: mockSession,
      driver: NOOP_COLLAPSE_DRIVER,
    });
    expect(out.kind).toBe("noop");
  });

  test("drained driver mutates messagesForQuery + sets transition", async () => {
    const orig: LLMMessage[] = [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
    ];
    const collapsed: LLMMessage[] = [{ role: "user", content: "[collapsed]" }];
    const state = mkState(orig);
    const driver: CollapseDrainDriver = {
      isEnabled: () => true,
      async recoverFromOverflow() {
        return { committed: 1, messages: collapsed };
      },
    };
    const out = await runCollapseDrain(state, {
      session: mockSession,
      driver,
    });
    expect(out.kind).toBe("drained");
    if (out.kind === "drained") expect(out.committed).toBe(1);
    expect(state.messagesForQuery).toEqual(collapsed);
    expect(state.transition?.reason).toBe("collapse_drain_retry");
  });
});
