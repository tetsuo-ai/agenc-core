import { describe, expect, test } from "vitest";
import { EventLog } from "../session/event-log.js";
import type { Session } from "../session/session.js";
import type { TurnContext } from "../session/turn-context.js";
import type { TurnState } from "../session/turn-state.js";
import {
  evaluateStopHooks,
  executeStopFailureHooks,
  MAX_STOP_HOOK_BLOCKS,
  type StopHookHandler,
} from "./stop-hooks.js";

function mkCtx(): TurnContext {
  return {
    subId: "t1",
    realtimeActive: false,
    config: {
      model: "stub",
      cwd: "/tmp",
      features: {
        appsEnabledForAuth: () => false,
        useLegacyLandlock: () => false,
      },
      multiAgentV2: {
        usageHintEnabled: false,
        usageHintText: "",
        hideSpawnAgentMetadata: false,
      },
      permissions: {
        allowLoginShell: false,
        shellEnvironmentPolicy: { allowedEnvVars: [], blockedEnvVars: [] },
        windowsSandboxPrivateDesktop: false,
      },
      ghostSnapshot: { enabled: false },
      agentRoles: [],
    },
    configSnapshot: {} as never,
    modelInfo: {
      slug: "stub",
      effectiveContextWindowPercent: 1,
      supportedReasoningLevels: [],
      defaultReasoningSummary: "auto",
      truncationPolicy: "off",
      usedFallbackModelMetadata: false,
    },
    cwd: "/tmp",
    depth: 0,
  } as unknown as TurnContext;
}

function mkSession(
  log: EventLog,
  stopHooks: ReadonlyArray<StopHookHandler>,
  stopFailureHooks: ReadonlyArray<StopHookHandler> = [],
): Session {
  let i = 0;
  return {
    conversationId: "conv-1",
    eventLog: log,
    services: {
      hooks: { stopHooks, stopFailureHooks },
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
    turnCount: 1,
    transition: undefined,
    stopHookActive: undefined,
    stopHookBlockingCount: 0,
    ...opts,
  };
}

describe("evaluateStopHooks", () => {
  test("no hooks configured → allowStop=true, blocking=false", async () => {
    const log = new EventLog();
    const session = mkSession(log, []);
    const result = await evaluateStopHooks(mkState(), mkCtx(), session);
    expect(result.allowStop).toBe(true);
    expect(result.blocking).toBe(false);
  });

  test("blocking hook injects continuation + bumps counter", async () => {
    const log = new EventLog();
    const session = mkSession(log, [
      {
        name: "lint",
        run: async () => ({
          shouldStop: false,
          shouldBlock: true,
          blockReason: "lint errors",
          continuationFragments: ["Fix the 3 ESLint errors above"],
        }),
      },
    ]);
    const state = mkState();
    const result = await evaluateStopHooks(state, mkCtx(), session);
    expect(result.blocking).toBe(true);
    expect(result.injectedMessage).toContain("Fix the 3");
    expect(state.stopHookBlockingCount).toBe(1);
  });

  test("I-17: MAX_STOP_HOOK_BLOCKS reached → force terminate + error event", async () => {
    const log = new EventLog();
    const session = mkSession(log, [
      {
        name: "always-blocks",
        run: async () => ({
          shouldStop: false,
          shouldBlock: true,
          continuationFragments: ["keep going"],
        }),
      },
    ]);
    const state = mkState({ stopHookBlockingCount: MAX_STOP_HOOK_BLOCKS });
    const errors: string[] = [];
    log.subscribe((e) => {
      const p = e.msg.payload as { cause?: string };
      if (e.msg.type === "error" && p.cause === "stop_hook_loop") errors.push(p.cause);
    });
    const result = await evaluateStopHooks(state, mkCtx(), session);
    expect(result.allowStop).toBe(true);
    expect(result.blocking).toBe(false);
    expect(errors).toContain("stop_hook_loop");
  });

  test("I-39: throwing hook emits typed error + continues ladder", async () => {
    const log = new EventLog();
    const session = mkSession(log, [
      {
        name: "throws",
        run: async () => {
          throw new Error("hook_boom");
        },
      },
      {
        name: "noop",
        run: async () => ({
          shouldStop: true,
          shouldBlock: false,
          continuationFragments: [],
        }),
      },
    ]);
    const errors: string[] = [];
    log.subscribe((e) => {
      const p = e.msg.payload as { cause?: string };
      if (e.msg.type === "error" && p.cause === "stop_hook_threw") errors.push(p.cause);
    });
    const result = await evaluateStopHooks(mkState(), mkCtx(), session);
    expect(result.allowStop).toBe(true);
    expect(errors).toContain("stop_hook_threw");
  });

  test("API-error guard: blocking hook on API-error turn → skipped", async () => {
    const log = new EventLog();
    const session = mkSession(log, [
      {
        name: "blocker",
        run: async () => ({
          shouldStop: false,
          shouldBlock: true,
          continuationFragments: ["continue"],
        }),
      },
    ]);
    const state = mkState({
      assistantMessages: [
        {
          uuid: "a",
          role: "assistant",
          text: "Prompt is too long: ...",
          toolCalls: [],
          apiError: "context_window_exceeded",
        },
      ],
    });
    const result = await evaluateStopHooks(state, mkCtx(), session);
    expect(result.allowStop).toBe(true);
    expect(result.blocking).toBe(false);
    expect(result.reason).toBe("api_error_stop_guard");
  });
});

describe("executeStopFailureHooks", () => {
  test("no-op when last message isn't API error", async () => {
    const log = new EventLog();
    let called = 0;
    const session = mkSession(
      log,
      [],
      [
        {
          name: "failure-hook",
          run: async () => {
            called += 1;
            return {
              shouldStop: true,
              shouldBlock: false,
              continuationFragments: [],
            };
          },
        },
      ],
    );
    await executeStopFailureHooks(mkState(), mkCtx(), session);
    expect(called).toBe(0);
  });

  test("fires on API-error assistant message", async () => {
    const log = new EventLog();
    let called = 0;
    const session = mkSession(
      log,
      [],
      [
        {
          name: "failure-hook",
          run: async () => {
            called += 1;
            return {
              shouldStop: true,
              shouldBlock: false,
              continuationFragments: [],
            };
          },
        },
      ],
    );
    const state = mkState({
      assistantMessages: [
        {
          uuid: "a",
          role: "assistant",
          text: "",
          toolCalls: [],
          apiError: "context_window_exceeded",
        },
      ],
    });
    await executeStopFailureHooks(state, mkCtx(), session);
    expect(called).toBe(1);
  });
});
