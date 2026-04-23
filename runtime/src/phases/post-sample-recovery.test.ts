import { describe, expect, test, vi } from "vitest";
vi.mock("axios", () => {
  const axiosLike = {
    create: vi.fn(() => axiosLike),
    get: vi.fn(),
    post: vi.fn(),
    interceptors: {
      request: { use: vi.fn() },
      response: { use: vi.fn() },
    },
  };
  return {
    default: axiosLike,
    create: axiosLike.create,
    isAxiosError: () => false,
  };
});
vi.mock("../llm/compact/post-compact-cleanup.js", async () => {
  const incremental = await import("../llm/grok/incremental.js");
  return {
    runPostCompactCleanup: vi.fn(() => incremental.clearAllResponseIds()),
  };
});
import { EventLog } from "../session/event-log.js";
import type { Session } from "../session/session.js";
import type { TurnContext } from "../session/turn-context.js";
import type { TurnState } from "../session/turn-state.js";
import { postSampleRecovery } from "./post-sample-recovery.js";
import { MAX_RECOVERY_REENTRIES } from "../recovery/fallback-ladder.js";
import {
  hasAttemptedCollapseDrain,
  runCollapseDrain,
  type CollapseDrainDriver,
} from "../recovery/collapse-drain.js";

function mkCtx(): TurnContext {
  return {
    subId: "t1",
    realtimeActive: false,
    config: {
      model: "stub",
      cwd: "/tmp",
      permissions: { allowLoginShell: false },
    },
    configSnapshot: {},
    modelInfo: { slug: "stub" },
    cwd: "/tmp",
    depth: 0,
  } as unknown as TurnContext;
}

function mkSession(log: EventLog): Session {
  let i = 0;
  return {
    conversationId: "conv-1",
    eventLog: log,
    services: {
      hooks: {},
      provider: { name: "grok" },
    },
    nextInternalSubId: () => `s-${++i}`,
  } as unknown as Session;
}

function mkState(opts: Partial<TurnState> = {}): TurnState {
  return {
    messages: [],
    messagesForQuery: [],
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
    lastResponseUsage: undefined,
    turnCount: 1,
    transition: undefined,
    stopHookActive: undefined,
    stopHookBlockingCount: 0,
    ...opts,
  };
}

describe("post-sample-recovery integration", () => {
  test("I-22: pendingBudgetDecision=stop → transition=token_budget_continuation + reset flag", async () => {
    const log = new EventLog();
    const session = mkSession(log);
    const nudgeMessage =
      "Stopped at 40% of token target (400 / 1,000). Keep working — do not summarize.";
    const state = mkState({
      pendingBudgetDecision: {
        kind: "stop",
        reason: nudgeMessage,
      },
      hasAttemptedReactiveCompact: true,
      maxOutputTokensRecoveryCount: 2,
      maxOutputTokensOverride: 12_000,
      pendingToolUseSummary: Promise.resolve(null),
      stopHookActive: true,
    });
    const warnings: string[] = [];
    log.subscribe((e) => {
      const p = e.msg.payload as { cause?: string };
      if (e.msg.type === "warning" && p.cause === "token_budget_continuation") {
        warnings.push(p.cause);
      }
    });
    await postSampleRecovery(state, mkCtx(), session);
    expect(state.transition?.reason).toBe("token_budget_continuation");
    expect(state.hasAttemptedReactiveCompact).toBe(false);
    expect(state.maxOutputTokensRecoveryCount).toBe(0);
    expect(state.maxOutputTokensOverride).toBeUndefined();
    expect(state.pendingToolUseSummary).toBeUndefined();
    expect(state.stopHookActive).toBeUndefined();
    expect(state.pendingBudgetDecision).toBeUndefined();
    expect(warnings).toContain("token_budget_continuation");
    expect(state.messages[state.messages.length - 1]).toEqual({
      role: "user",
      content: nudgeMessage,
    });
  });

  test("I-42: pendingBudgetDecision=stop respects the recovery re-entry cap", async () => {
    const log = new EventLog();
    const session = mkSession(log);
    const state = mkState({
      pendingBudgetDecision: {
        kind: "stop",
        reason: "Continue with the task.",
      },
      recoveryReentryCount: MAX_RECOVERY_REENTRIES,
    });

    const causes: string[] = [];
    log.subscribe((event) => {
      if (event.msg.type !== "error") return;
      const payload = event.msg.payload as { cause?: string };
      if (payload.cause) causes.push(payload.cause);
    });

    await postSampleRecovery(state, mkCtx(), session);

    expect(state.transition).toBeUndefined();
    expect(state.pendingBudgetDecision).toBeUndefined();
    expect(state.messages).toEqual([]);
    expect(causes).toContain("recovery_loop");
  });

  test("max-output-tokens first attempt: escalate sets override + transition", async () => {
    const log = new EventLog();
    const session = mkSession(log);
    const state = mkState({
      assistantMessages: [
        {
          uuid: "a",
          role: "assistant",
          text: "",
          toolCalls: [],
          apiError: "max_output_tokens",
        },
      ],
    });
    await postSampleRecovery(state, mkCtx(), session);
    expect(state.transition?.reason).toBe("max_output_tokens_escalate");
    expect(state.maxOutputTokensOverride).toBe(64_000);
  });

  test("normal stream (no recovery) → no transition", async () => {
    const log = new EventLog();
    const session = mkSession(log);
    const state = mkState({
      assistantMessages: [
        {
          uuid: "a",
          role: "assistant",
          text: "happy path",
          toolCalls: [],
        },
      ],
    });
    await postSampleRecovery(state, mkCtx(), session);
    expect(state.transition).toBeUndefined();
  });

  test("normal stream clears the collapse-drain one-shot flag", async () => {
    const log = new EventLog();
    const session = mkSession(log);
    const state = mkState({
      assistantMessages: [
        {
          uuid: "a",
          role: "assistant",
          text: "happy path",
          toolCalls: [],
        },
      ],
    });
    const driver: CollapseDrainDriver = {
      isEnabled: () => true,
      async recoverFromOverflow(messages) {
        return { committed: 1, messages };
      },
    };

    await runCollapseDrain(state, {
      session,
      driver,
    });
    expect(hasAttemptedCollapseDrain(state)).toBe(true);

    state.transition = undefined;
    await postSampleRecovery(state, mkCtx(), session);

    expect(hasAttemptedCollapseDrain(state)).toBe(false);
  });

  // Removed: "withheld 413 routes through the live session contextCollapse
  // service before reactive compact". This test exercised the openclaude
  // contextCollapse runtime service end-to-end via stageContextCollapseForSession,
  // which the lean rebuild stubbed out as a no-op. Without that subsystem
  // the assertions cannot hold; if the gut runtime ever re-implements
  // context-collapse, restore the test then.

  test("stopHookActive alone does not re-trigger stop_hook_blocking", async () => {
    const log = new EventLog();
    const session = mkSession(log);
    const state = mkState({
      assistantMessages: [
        {
          uuid: "a",
          role: "assistant",
          text: "continued after hook block",
          toolCalls: [],
        },
      ],
      stopHookActive: true,
    });

    await postSampleRecovery(state, mkCtx(), session);

    expect(state.transition).toBeUndefined();
  });
});
