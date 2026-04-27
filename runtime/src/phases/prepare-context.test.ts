import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
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
import type { LLMMessage } from "../llm/types.js";
import * as autoCompactModule from "../llm/compact/auto-compact.js";
import { PROMPT_TOO_LONG_ERROR_MESSAGE } from "../recovery/api-errors.js";
import type { Event } from "../session/event-log.js";
import type { Session } from "../session/session.js";
import type { TurnContext } from "../session/turn-context.js";
import type { TurnState } from "../session/turn-state.js";
import { createContentReplacementState } from "../session/_deps/tool-result-storage.js";
import {
  getPrepareContextTerminal,
  prepareContext,
} from "./prepare-context.js";

function repeat(n: number, ch = "x"): string {
  return ch.repeat(n);
}

function mkToolMsg(size: number, toolName = "Bash"): LLMMessage {
  return {
    role: "tool",
    content: repeat(size, "x"),
    toolCallId: `call-${size}-${toolName}`,
    toolName,
  };
}

function mkUserMsg(text: string): LLMMessage {
  return { role: "user", content: text };
}

function mkAssistantMsg(text: string): LLMMessage {
  return { role: "assistant", content: text };
}

// ─────────────────────────────────────────────────────────────────────
// prepareContext wiring — verify Stage 2 fires inside the phase chain
// ─────────────────────────────────────────────────────────────────────

function mkCtx(
  overrides: Record<string, unknown> = {},
): TurnContext {
  return {
    subId: "t1",
    realtimeActive: false,
    config: {},
    configSnapshot: {
      toolBudget: {
        maxToolResultBudgetBytes: 10 * 1024,
        truncateToBytes: 2 * 1024,
      },
    },
    modelInfo: { slug: "claude-3-5-sonnet-20241022" },
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
    sessionSource: "cli_main",
    depth: 0,
    ...overrides,
  } as unknown as TurnContext;
}

function mkSession(
  collected: Event[],
  rolloutStore: Session["rolloutStore"] = null,
): Session {
  let i = 0;
  return {
    conversationId: "conv-1",
    rolloutStore,
    state: {
      unsafePeek: () => ({ history: [], totalTokenUsage: 0 }),
      with: async (
        fn: (value: { history: LLMMessage[]; totalTokenUsage: number }) => void,
      ) => fn({ history: [], totalTokenUsage: 0 }),
    },
    services: { hooks: {} },
    nextInternalSubId: () => `sub-${++i}`,
    emit: (e: Event) => {
      collected.push(e);
    },
  } as unknown as Session;
}

function mkState(messages: LLMMessage[]): TurnState {
  return {
    messages,
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
  };
}

describe("prepareContext Stage 2 wiring", () => {
  test("is a no-op when content replacement state is not provisioned", async () => {
    const events: Event[] = [];
    const session = mkSession(events);
    const state = mkState([
      mkUserMsg("seed"),
      mkToolMsg(500, "A"),
      mkAssistantMsg("ack"),
      mkToolMsg(400, "B"),
    ]);
    await prepareContext(state, mkCtx(), session);
    const warnings = events.filter((e) => e.msg.type === "warning");
    expect(warnings).toHaveLength(0);
    expect(state.messagesForQuery.length).toBe(4);
    const toolMsg = state.messagesForQuery.find((m) => m.role === "tool");
    expect(toolMsg?.content).toBe(repeat(500, "x"));
  });

  test("uses the upstream content-replacement path when state is provisioned", async () => {
    const events: Event[] = [];
    const session = mkSession(events);
    const big = 3 * 1024 * 1024;
    const state = mkState([
      mkUserMsg("seed"),
      mkToolMsg(big, "A"),
      mkAssistantMsg("ack"),
    ]);
    state.contentReplacementState = createContentReplacementState() as never;

    await prepareContext(
      state,
      mkCtx({ querySource: "compact" }),
      session,
    );

    expect(typeof state.messagesForQuery[1]?.content).toBe("string");
    expect(state.messagesForQuery[1]?.content).not.toBe(repeat(big, "x"));
    expect(
      String(state.messagesForQuery[1]?.content).includes(
        "[Old tool result content cleared]",
      ) ||
        String(state.messagesForQuery[1]?.content).includes(
          "<persisted-output>",
        ),
    ).toBe(true);
    expect(String(state.messages[1]?.content)).toContain(
      "[Old tool result content cleared]",
    );
    expect(state.messages[1]?.content).not.toBe(repeat(big, "x"));
  });
});

describe("prepareContext Stage 3/4 wiring", () => {
  test("retry handoff rebuilds from committed recovery history, not stale messagesForQuery", async () => {
    const events: Event[] = [];
    const session = mkSession(events);
    const recoveredMessages: LLMMessage[] = [
      mkUserMsg("[collapsed]"),
      mkAssistantMsg("tail"),
    ];
    const staleMessagesForQuery: LLMMessage[] = [
      mkUserMsg("stale-a"),
      mkAssistantMsg("stale-b"),
      mkUserMsg("stale-c"),
    ];
    const state = mkState(recoveredMessages);
    state.messagesForQuery = staleMessagesForQuery;
    state.transition = { reason: "reactive_compact_retry" };

    await prepareContext(state, mkCtx(), session);

    expect(state.messagesForQuery).toEqual(recoveredMessages);
  });

  test("snip clears oversized tool results on the live path", async () => {
    const events: Event[] = [];
    const session = mkSession(events);
    const ctx = mkCtx({
      configSnapshot: {
        toolBudget: {
          maxToolResultBudgetBytes: 100 * 1024,
          truncateToBytes: 2 * 1024,
        },
      },
    });
    const state = mkState([
      mkUserMsg("seed"),
      mkToolMsg(20 * 1024, "A"),
      mkAssistantMsg("ack"),
      mkToolMsg(500, "B"),
    ]);

    await prepareContext(state, ctx, session);

    expect(state.snipTokensFreed).toBeGreaterThan(0);
    expect(typeof state.messagesForQuery[1]?.content === "string").toBe(true);
    expect(state.messagesForQuery[1]?.content).toContain(
      "[Old tool result content cleared]",
    );
    expect(state.messagesForQuery[3]?.content).toBe(repeat(500));
    expect(getPrepareContextTerminal(state)).toBeUndefined();
  });

  test("microcompact leaves older tool results intact on the live path", async () => {
    const events: Event[] = [];
    const session = mkSession(events);
    const state = mkState([
      mkUserMsg("seed"),
      mkToolMsg(200, "A"),
      mkAssistantMsg("ack"),
      mkToolMsg(200, "B"),
      mkAssistantMsg("ack"),
      mkToolMsg(200, "C"),
      mkAssistantMsg("ack"),
      mkToolMsg(200, "D"),
      mkAssistantMsg("ack"),
      mkToolMsg(200, "E"),
      mkAssistantMsg("ack"),
      mkToolMsg(200, "F"),
      mkAssistantMsg("ack"),
      mkToolMsg(200, "G"),
    ]);

    await prepareContext(state, mkCtx(), session);

    const toolMessages = state.messagesForQuery.filter((m) => m.role === "tool");
    expect(toolMessages).toHaveLength(7);
    for (const toolMessage of toolMessages) {
      expect(toolMessage?.content).toBe(repeat(200));
    }
    expect(getPrepareContextTerminal(state)).toBeUndefined();
  });
});

function mkUsageAssistantMsg(finalContextTokens: number): LLMMessage {
  return {
    role: "assistant",
    content: "prior response",
    type: "assistant",
    message: {
      id: "resp-1",
      model: "claude-3-5-sonnet-20241022",
      content: [{ type: "text", text: "prior response" }],
      usage: {
        input_tokens: finalContextTokens - 25,
        output_tokens: 25,
        iterations: [
          {
            input_tokens: finalContextTokens - 25,
            output_tokens: 25,
          },
        ],
      },
    },
  } as unknown as LLMMessage;
}

describe("prepareContext Stage 7 blocking-limit parity", () => {
  const originalDisableAutoCompact = process.env.DISABLE_AUTO_COMPACT;
  const originalBlockingLimitOverride =
    process.env.AGENC_BLOCKING_LIMIT_OVERRIDE;
  const originalUserType = process.env.USER_TYPE;
  const originalMaxContext = process.env.AGENC_MAX_CONTEXT_TOKENS;
  const originalAutoCompactPct = process.env.AGENC_AUTOCOMPACT_PCT_OVERRIDE;

  beforeEach(() => {
    delete process.env.DISABLE_AUTO_COMPACT;
    delete process.env.AGENC_BLOCKING_LIMIT_OVERRIDE;
    delete process.env.AGENC_MAX_CONTEXT_TOKENS;
    delete process.env.AGENC_AUTOCOMPACT_PCT_OVERRIDE;
    delete process.env.USER_TYPE;
    vi.restoreAllMocks();
  });

  afterEach(() => {
    if (originalDisableAutoCompact !== undefined) {
      process.env.DISABLE_AUTO_COMPACT = originalDisableAutoCompact;
    } else {
      delete process.env.DISABLE_AUTO_COMPACT;
    }
    if (originalBlockingLimitOverride !== undefined) {
      process.env.AGENC_BLOCKING_LIMIT_OVERRIDE =
        originalBlockingLimitOverride;
    } else {
      delete process.env.AGENC_BLOCKING_LIMIT_OVERRIDE;
    }
    if (originalUserType !== undefined) {
      process.env.USER_TYPE = originalUserType;
    } else {
      delete process.env.USER_TYPE;
    }
    if (originalMaxContext !== undefined) {
      process.env.AGENC_MAX_CONTEXT_TOKENS = originalMaxContext;
    } else {
      delete process.env.AGENC_MAX_CONTEXT_TOKENS;
    }
    if (originalAutoCompactPct !== undefined) {
      process.env.AGENC_AUTOCOMPACT_PCT_OVERRIDE = originalAutoCompactPct;
    } else {
      delete process.env.AGENC_AUTOCOMPACT_PCT_OVERRIDE;
    }
    vi.restoreAllMocks();
  });

  test("hard blocking-limit preempts when auto compact recovery is not owning the turn", async () => {
    process.env.DISABLE_AUTO_COMPACT = "1";
    process.env.AGENC_BLOCKING_LIMIT_OVERRIDE = "50";
    vi.spyOn(autoCompactModule, "calculateTokenWarningState").mockReturnValue({
      percentLeft: 0,
      isAboveWarningThreshold: true,
      isAboveErrorThreshold: true,
      isAboveAutoCompactThreshold: false,
      isAtBlockingLimit: true,
    });

    const state = mkState([mkUserMsg(repeat(400))]);

    await prepareContext(
      state,
      mkCtx({
        reactiveCompact: { isReactiveCompactEnabled: () => false },
      }),
      mkSession([]),
    );

    const terminal = getPrepareContextTerminal(state);
    expect(terminal?.terminal.reason).toBe("blocking_limit");
    expect(terminal?.assistantMessage.text).toBe(PROMPT_TOO_LONG_ERROR_MESSAGE);
  });

  test("skip cases do not preempt for compact/session_memory, reactive compact, or context collapse recovery owners", async () => {
    process.env.AGENC_BLOCKING_LIMIT_OVERRIDE = "50";

    const compactState = mkState([mkUserMsg(repeat(400))]);
    await prepareContext(
      compactState,
      mkCtx({ querySource: "compact" }),
      mkSession([]),
    );
    expect(getPrepareContextTerminal(compactState)).toBeUndefined();

    const sessionMemoryState = mkState([mkUserMsg(repeat(400))]);
    await prepareContext(
      sessionMemoryState,
      mkCtx({ querySource: "session_memory" }),
      mkSession([]),
    );
    expect(getPrepareContextTerminal(sessionMemoryState)).toBeUndefined();

    const reactiveCompactState = mkState([mkUserMsg(repeat(400))]);
    await prepareContext(
      reactiveCompactState,
      mkCtx({
        reactiveCompact: { isReactiveCompactEnabled: () => true },
      }),
      mkSession([]),
    );
    expect(getPrepareContextTerminal(reactiveCompactState)).toBeUndefined();

    const contextCollapseState = mkState([mkUserMsg(repeat(400))]);
    await prepareContext(
      contextCollapseState,
      mkCtx({
        reactiveCompact: { isReactiveCompactEnabled: () => false },
        contextCollapse: { isContextCollapseEnabled: () => true },
      }),
      mkSession([]),
    );
    expect(getPrepareContextTerminal(contextCollapseState)).toBeUndefined();
  });

  test("projects the staged context-collapse view before auto-compact", async () => {
    const state = mkState([
      mkUserMsg("raw-history"),
      mkAssistantMsg("assistant-tail"),
    ]);
    await prepareContext(
      state,
      mkCtx({
        contextCollapse: {
          isContextCollapseEnabled: () => true,
          maybeCollapseContext: () => [
            mkUserMsg("[collapsed-view]"),
            mkAssistantMsg("tail"),
          ],
        },
      }),
      mkSession([]),
    );

    expect(state.messagesForQuery).toEqual([
      mkUserMsg("[collapsed-view]"),
      mkAssistantMsg("tail"),
    ]);
  });

  test("successful compaction on this iteration skips blocking preempt and carries taskBudgetRemaining forward", async () => {
    process.env.AGENC_BLOCKING_LIMIT_OVERRIDE = "1";
    const appendRollout = vi.fn();
    const compactionResult = {
      boundaryMarker: { role: "system", content: "boundary" },
      summaryMessages: [{ role: "assistant", content: "compacted-summary" }],
      messagesToKeep: [{ role: "user", content: "kept-tail" }],
      attachments: [],
      hookResults: [],
    };

    const autoCompactSpy = vi
      .spyOn(autoCompactModule, "autoCompactIfNeeded")
      .mockResolvedValue({
      wasCompacted: true,
      compactionResult,
    });

    const state = mkState([mkUsageAssistantMsg(350), mkUserMsg(repeat(400))]);
    state.taskBudgetRemaining = 400;

    await prepareContext(
      state,
      mkCtx({
        taskBudget: { total: 1000 },
      }),
      mkSession([], {
        appendRollout,
      } as unknown as Session["rolloutStore"]),
    );

    expect(getPrepareContextTerminal(state)).toBeUndefined();
    expect(state.messagesForQuery).toEqual([
      compactionResult.boundaryMarker,
      ...compactionResult.summaryMessages,
      ...compactionResult.messagesToKeep,
    ]);
    expect(state.taskBudgetRemaining).toBe(50);
    expect(appendRollout).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "compacted",
        payload: expect.objectContaining({
          message: "compacted-summary",
          replacementHistory: [
            { role: "system", content: "boundary" },
            { role: "assistant", content: "compacted-summary" },
            { role: "user", content: "kept-tail" },
          ],
        }),
      }),
      { durable: true },
    );
    expect(autoCompactSpy).toHaveBeenCalledWith(
      [mkUsageAssistantMsg(350), mkUserMsg(repeat(400))],
      expect.objectContaining({
        options: expect.objectContaining({
          querySource: "repl_main_thread",
        }),
      }),
      expect.objectContaining({
        forkContextMessages: [mkUsageAssistantMsg(350), mkUserMsg(repeat(400))],
        toolUseContext: expect.objectContaining({
          options: expect.objectContaining({
            querySource: "repl_main_thread",
          }),
        }),
      }),
      "repl_main_thread",
      undefined,
      0,
    );
  });

  test("circuit-breaker blocks after repeated auto-compact failures while still above auto-compact threshold", async () => {
    process.env.AGENC_BLOCKING_LIMIT_OVERRIDE = "1000000";

    vi.spyOn(autoCompactModule, "autoCompactIfNeeded").mockResolvedValue({
      wasCompacted: false,
      consecutiveFailures: 3,
    });
    vi.spyOn(autoCompactModule, "calculateTokenWarningState").mockReturnValue({
      percentLeft: 0,
      isAboveWarningThreshold: true,
      isAboveErrorThreshold: true,
      isAboveAutoCompactThreshold: true,
      isAtBlockingLimit: false,
    });

    const state = mkState([mkUserMsg(repeat(2_000))]);

    await prepareContext(
      state,
      mkCtx({
        reactiveCompact: { isReactiveCompactEnabled: () => true },
      }),
      mkSession([]),
    );

    const terminal = getPrepareContextTerminal(state);
    expect(state.autoCompactTracking?.consecutiveFailures).toBe(3);
    expect(terminal?.terminal.reason).toBe("blocking_limit");
    expect(terminal?.assistantMessage.text).toContain(
      "automatic compaction has failed",
    );
  });
});
