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

function mkCtx(modelInfo: Record<string, unknown> = {}): TurnContext {
  return {
    subId: "t1",
    realtimeActive: false,
    config: {
      model: "stub",
      cwd: "/tmp",
      permissions: { allowLoginShell: false },
    },
    configSnapshot: {},
    modelInfo: { slug: "stub", ...modelInfo },
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
    await postSampleRecovery(
      state,
      mkCtx({
        maxOutputTokensCappedDefault: true,
        maxOutputTokensUpperLimit: 64_000,
      }),
      session,
    );
    expect(state.transition?.reason).toBe("max_output_tokens_escalate");
    expect(state.maxOutputTokensOverride).toBe(64_000);
  });

  test("max-output-tokens explicit override bypasses capped-default escalation", async () => {
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

    await postSampleRecovery(
      state,
      mkCtx({
        maxOutputTokensExplicit: true,
        maxOutputTokensCappedDefault: false,
        maxOutputTokensUpperLimit: 64_000,
      }),
      session,
    );

    expect(state.transition?.reason).toBe("max_output_tokens_recovery");
    expect(state.maxOutputTokensOverride).toBeUndefined();
    expect(state.maxOutputTokensRecoveryCount).toBe(1);
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

  // Restored after the gut runtime grew a real context-collapse
  // subsystem (`session/_deps/context-collapse.ts`). The test now
  // exercises the post-sample-recovery routing layer end-to-end through
  // the live `services.contextCollapse.recoverFromOverflow` driver: a
  // withheld 413 must hit collapse-drain BEFORE reactive-compact, and
  // the resulting transition must be `collapse_drain_retry`.
  test("withheld 413 routes through the live session contextCollapse service before reactive compact", async () => {
    const log = new EventLog();
    const session = mkSession(log);
    let recoverCalls = 0;
    let reactiveCompactCalls = 0;
    (session as unknown as { services: Record<string, unknown> }).services = {
      ...((session as unknown as { services: Record<string, unknown> }).services ?? {}),
      contextCollapse: {
        isContextCollapseEnabled: () => true,
        recoverFromOverflow: (
          messages: ReadonlyArray<{ role: string; content: string }>,
        ) => {
          recoverCalls += 1;
          return {
            committed: 1,
            messages: [{ role: "user", content: "[collapsed]" }],
          };
        },
      },
      reactiveCompact: {
        isReactiveCompactEnabled: () => true,
      },
      provider: { name: "grok" },
      hooks: {},
    };
    // Stub the reactive-compact path so we can assert it was NOT
    // reached on the first 413 attempt.
    const reactiveCompactMod = await import("../recovery/reactive-compact.js");
    const spy = vi
      .spyOn(reactiveCompactMod, "runReactiveCompact")
      .mockImplementation(async () => {
        reactiveCompactCalls += 1;
        return { kind: "compacted" } as never;
      });
    try {
      const state = mkState({
        messagesForQuery: [
          { role: "user", content: "earlier prompt 1" },
          { role: "assistant", content: "earlier reply 1" },
          { role: "user", content: "earlier prompt 2" },
          { role: "assistant", content: "earlier reply 2" },
          { role: "user", content: "current prompt" },
        ],
        assistantMessages: [
          {
            uuid: "a",
            role: "assistant",
            text: "Prompt is too long",
            toolCalls: [],
            apiError: "prompt_too_long",
          },
        ],
      });

      await postSampleRecovery(state, mkCtx(), session);

      expect(recoverCalls).toBe(1);
      expect(reactiveCompactCalls).toBe(0);
      expect(state.transition?.reason).toBe("collapse_drain_retry");
      expect(hasAttemptedCollapseDrain(state)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

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
