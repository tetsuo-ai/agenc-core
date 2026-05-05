import { beforeEach, describe, expect, test, vi } from "vitest";
import { EventLog } from "../session/event-log.js";
import type { Session } from "../session/session.js";
import type { TurnContext } from "../session/turn-context.js";
import type { TurnState } from "../session/turn-state.js";
import {
  ensureExtractMemoriesInitialized,
  executeExtractMemories,
} from "../services/extractMemories/extractMemories.js";
import { commit } from "./commit.js";
import { MAX_STOP_HOOK_BLOCKS } from "./stop-hooks.js";

vi.mock("../services/extractMemories/extractMemories.js", () => ({
  ensureExtractMemoriesInitialized: vi.fn(),
  executeExtractMemories: vi.fn(async () => {}),
}));

function mkCtx(): TurnContext {
  return {
    subId: "turn-1",
    cwd: "/tmp",
    config: {
      permissions: {
        allowLoginShell: false,
      },
    },
    modelInfo: {
      slug: "stub-model",
    },
  } as unknown as TurnContext;
}

function mkState(opts: Partial<TurnState> = {}): TurnState {
  return {
    messages: [{ role: "user", content: "start" }],
    messagesForQuery: [],
    autoCompactTracking: undefined,
    taskBudgetRemaining: undefined,
    snipTokensFreed: 0,
    pendingMemoryPrefetch: undefined,
    pendingSkillPrefetch: undefined,
    contentReplacementState: undefined,
    assistantMessages: [],
    toolUseBlocks: [],
    needsFollowUp: true,
    toolResults: [],
    completedToolResults: [],
    hasAttemptedReactiveCompact: false,
    maxOutputTokensOverride: undefined,
    maxOutputTokensRecoveryCount: 0,
    recoveryReentryCount: 0,
    continuationNudgeCount: 0,
    streamingToolExecutor: null,
    pendingToolUseSummary: undefined,
    pendingBudgetDecision: undefined,
    lastResponseUsage: undefined,
    turnCount: 0,
    transition: undefined,
    stopHookActive: undefined,
    stopHookBlockingCount: 0,
    ...opts,
  };
}

function mkSession(): Session {
  return {
    emit: vi.fn(),
    nextInternalSubId: () => "sub-1",
    rolloutStore: undefined,
    eventLog: new EventLog(),
    conversationId: "conv-1",
    services: {
      hooks: {
        stopHooks: [],
      },
    },
  } as unknown as Session;
}

describe("commit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("keeps resolved tool-use summaries out of model-visible history", async () => {
    const upstreamSummary = {
      type: "tool_use_summary",
      summary: "Searched the repo and found the bootstrap entry point.",
      precedingToolUseIds: ["tool-1"],
      uuid: "sum-1",
      timestamp: "2026-04-21T00:00:00.000Z",
    };
    const legacySummary = {
      type: "tool_use_summary",
      content: "Ran tests and confirmed the fix.",
      uuid: "sum-2",
    };

    for (const pending of [upstreamSummary, legacySummary]) {
      const state = mkState({
        pendingToolUseSummary: Promise.resolve(pending as never),
      });

      await commit(state, mkCtx(), mkSession());

      expect(state.pendingToolUseSummary).toBeUndefined();
      expect(state.turnCount).toBe(1);
      expect(state.messages).toEqual([{ role: "user", content: "start" }]);
    }
  });

  test("emits the resolved summary text back through agent_message", async () => {
    const session = mkSession();
    const state = mkState({
      pendingToolUseSummary: Promise.resolve({
        type: "tool_use_summary",
        summary: "Indexed the repo and queued the follow-up work.",
        uuid: "sum-3",
      } as never),
    });

    await commit(state, mkCtx(), session);

    expect(session.emit).toHaveBeenCalledWith({
      id: "sub-1",
      msg: {
        type: "agent_message",
        payload: {
          message: "Indexed the repo and queued the follow-up work.",
        },
      },
    });
  });

  test("summary promise rejection is non-fatal and still clears the pending slot", async () => {
    const state = mkState({
      pendingToolUseSummary: Promise.reject(new Error("summary_boom")),
    });

    await commit(state, mkCtx(), mkSession());

    expect(state.pendingToolUseSummary).toBeUndefined();
    expect(state.turnCount).toBe(1);
    expect(state.messages).toEqual([{ role: "user", content: "start" }]);
  });

  test("blocking stop hook increments once and re-enters without double counting", async () => {
    const session = mkSession();
    const state = mkState({
      needsFollowUp: false,
      toolUseBlocks: [],
    });
    (
      session.services.hooks as {
        stopHooks: Array<{ name: string; run: () => Promise<unknown> }>;
      }
    ).stopHooks = [
      {
        name: "lint",
        run: async () => ({
          shouldStop: false,
          shouldBlock: true,
          blockReason: "lint errors",
          continuationFragments: ["fix lint"],
        }),
      },
    ];

    await commit(state, mkCtx(), session);

    expect(state.stopHookBlockingCount).toBe(1);
    expect(state.transition?.reason).toBe("stop_hook_blocking");
    expect(state.messages.at(-1)).toEqual({
      role: "user",
      content: "fix lint",
    });
    expect(executeExtractMemories).not.toHaveBeenCalled();
  });

  test("third blocking stop hook hits the cap without re-entering", async () => {
    const session = mkSession();
    const state = mkState({
      needsFollowUp: false,
      toolUseBlocks: [],
      stopHookBlockingCount: MAX_STOP_HOOK_BLOCKS - 1,
    });
    (
      session.services.hooks as {
        stopHooks: Array<{ name: string; run: () => Promise<unknown> }>;
      }
    ).stopHooks = [
      {
        name: "lint",
        run: async () => ({
          shouldStop: false,
          shouldBlock: true,
          blockReason: "lint errors",
          continuationFragments: ["fix lint"],
        }),
      },
    ];

    await commit(state, mkCtx(), session);

    expect(state.stopHookBlockingCount).toBe(MAX_STOP_HOOK_BLOCKS);
    expect(state.transition).toBeUndefined();
    expect(state.stopHookActive).toBe(false);
    expect((session.emit as ReturnType<typeof vi.fn>).mock.calls).toContainEqual([
      {
        id: "sub-1",
        msg: {
          type: "error",
          payload: {
            cause: "stop_hook_loop",
            message: `stop hooks blocked ${MAX_STOP_HOOK_BLOCKS} times in a row — forcing terminal (stop_hook_blocked)`,
          },
        },
      },
    ]);
  });

  test("schedules memory extraction after a natural terminal turn", async () => {
    const session = mkSession();
    const ctx = mkCtx();
    const state = mkState({
      needsFollowUp: false,
      toolUseBlocks: [],
      messages: [
        { role: "user", content: "remember terminal scheduling" },
        { role: "assistant", content: "ok" },
      ],
      completedToolResults: [
        {
          callId: "write-1",
          toolName: "Write",
          arguments: "{}",
          content: "ok",
          isError: false,
        },
      ],
    });

    await commit(state, ctx, session);

    expect(ensureExtractMemoriesInitialized).toHaveBeenCalledOnce();
    expect(executeExtractMemories).toHaveBeenCalledOnce();
    expect(executeExtractMemories).toHaveBeenCalledWith(
      {
        messages: state.messages,
        completedToolResults: state.completedToolResults,
        ctx,
        session,
        signal: undefined,
      },
      expect.any(Function),
    );
  });

  test("does not schedule memory extraction while tools are pending", async () => {
    const state = mkState({
      needsFollowUp: true,
      toolUseBlocks: [
        {
          type: "tool_use",
          id: "tool-1",
          name: "Write",
          input: {},
        },
      ],
    });

    await commit(state, mkCtx(), mkSession());

    expect(ensureExtractMemoriesInitialized).not.toHaveBeenCalled();
    expect(executeExtractMemories).not.toHaveBeenCalled();
  });
});
