import { afterEach, describe, expect, test, vi } from "vitest";
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
import { AsyncQueue } from "../utils/async-queue.js";
import { EventLog } from "../session/event-log.js";
import { Session, type Event, type SessionOpts, type SessionServices } from "../session/session.js";
import type { TurnContext } from "../session/turn-context.js";
import type { TurnState } from "../session/turn-state.js";
import { postSampleRecovery } from "./post-sample-recovery.js";
import { MAX_RECOVERY_REENTRIES } from "../recovery/fallback-ladder.js";
import {
  hasAttemptedCollapseDrain,
  runCollapseDrain,
  type CollapseDrainDriver,
} from "../recovery/collapse-drain.js";
import {
  resetContextCollapse,
  stageContextCollapseForSession,
} from "../services/contextCollapse/index.js";

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

function buildLiveSession(): Session {
  const services = {
    mcpConnectionManager: {
      setApprovalPolicy: () => {},
      setSandboxPolicy: () => {},
      requiredStartupFailures: async () => [],
    },
    mcpStartupCancellationToken: {
      cancel: () => {},
      isCancelled: () => false,
    },
    provider: { name: "grok" },
    registry: {
      tools: [],
      toLLMTools: () => [],
      dispatch: async () => ({ content: "", isError: false }),
    },
    hooks: {},
  } as unknown as SessionServices;

  return new Session({
    conversationId: "conv-live",
    services,
    initialState: {
      sessionConfiguration: {
        cwd: "/tmp",
        approvalPolicy: { value: "never" },
        sandboxPolicy: { value: "read_only" },
        fileSystemSandboxPolicy: {
          allowWrite: [],
          denyWrite: [],
          allowRead: [],
          denyRead: [],
        },
        networkSandboxPolicy: {
          allowlist: [],
          denylist: [],
          allowManagedDomainsOnly: false,
        },
        windowsSandboxLevel: "none",
        collaborationMode: { model: "stub" },
        dynamicTools: [],
        sessionSource: "cli_main",
      },
      history: [],
    } as SessionOpts["initialState"],
    features: {
      appsEnabledForAuth: () => false,
      useLegacyLandlock: () => false,
    },
    jsRepl: { id: "repl-test" },
    config: {
      model: "stub",
      cwd: "/tmp",
      permissions: { allowLoginShell: false },
    } as SessionOpts["config"],
    modelInfo: { slug: "stub" } as SessionOpts["modelInfo"],
    eventQueue: new AsyncQueue<Event>(),
  });
}

afterEach(() => {
  resetContextCollapse();
});

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

  test("withheld 413 routes through the live session contextCollapse service before reactive compact", async () => {
    const session = buildLiveSession();
    const state = mkState({
      messagesForQuery: [
        { role: "user", content: "before" },
        { role: "assistant", content: "after" },
      ],
      assistantMessages: [
        {
          uuid: "a",
          role: "assistant",
          text: "Prompt is too long: 137500 tokens > 135000 maximum",
          toolCalls: [],
          apiError: "prompt_too_long",
        },
      ],
    });

    stageContextCollapseForSession(
      session.conversationId,
      [{ role: "user", content: "[collapsed]" }],
      {
        committed: 1,
        collapsedMessages: 1,
        querySource: session.services.querySource,
      },
    );

    await postSampleRecovery(state, mkCtx(), session);

    expect(state.transition?.reason).toBe("collapse_drain_retry");
    expect(state.messagesForQuery).toEqual([
      { role: "user", content: "[collapsed]" },
    ]);
    expect(session.services.contextCollapse?.isContextCollapseEnabled()).toBe(
      false,
    );
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
