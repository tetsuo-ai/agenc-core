/**
 * Stage 2 (tool-result budgeting) tests — ports the behavioral surface
 * of openclaude `toolResultStorage.applyToolResultBudget` as driven by
 * `query.ts:~369`. Verifies:
 *   - no-op under budget
 *   - oldest-first truncation until under budget
 *   - message ordering preserved
 *   - `truncateToBytes` respected (no under-truncation)
 *   - env override respected (`AGENC_TOOL_RESULT_BUDGET_BYTES` /
 *     `AGENC_TOOL_RESULT_TRUNCATE_BYTES`)
 *   - prepareContext wiring emits a warning when truncation fires and
 *     writes the truncated slice back into `state.messagesForQuery`.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { LLMMessage } from "../llm/types.js";
import * as autoCompactModule from "../llm/compact/auto-compact.js";
import { PROMPT_TOO_LONG_ERROR_MESSAGE } from "../recovery/api-errors.js";
import type { Event } from "../session/event-log.js";
import type { Session } from "../session/session.js";
import type { TurnContext } from "../session/turn-context.js";
import type { TurnState } from "../session/turn-state.js";
import {
  applyToolResultBudgeting,
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

describe("applyToolResultBudgeting", () => {
  const originalBudget = process.env.AGENC_TOOL_RESULT_BUDGET_BYTES;
  const originalTruncate = process.env.AGENC_TOOL_RESULT_TRUNCATE_BYTES;

  beforeEach(() => {
    delete process.env.AGENC_TOOL_RESULT_BUDGET_BYTES;
    delete process.env.AGENC_TOOL_RESULT_TRUNCATE_BYTES;
  });

  afterEach(() => {
    if (originalBudget !== undefined) {
      process.env.AGENC_TOOL_RESULT_BUDGET_BYTES = originalBudget;
    } else {
      delete process.env.AGENC_TOOL_RESULT_BUDGET_BYTES;
    }
    if (originalTruncate !== undefined) {
      process.env.AGENC_TOOL_RESULT_TRUNCATE_BYTES = originalTruncate;
    } else {
      delete process.env.AGENC_TOOL_RESULT_TRUNCATE_BYTES;
    }
  });

  test("no-op when total tool-result bytes are under budget", () => {
    const messages: LLMMessage[] = [
      mkUserMsg("hi"),
      mkToolMsg(1_000),
      mkAssistantMsg("reply"),
      mkToolMsg(500),
    ];
    const before = messages.map((m) => m);
    const result = applyToolResultBudgeting(messages, undefined, {
      maxToolResultBudgetBytes: 10_000,
      truncateToBytes: 2_000,
    });
    expect(result.truncatedCount).toBe(0);
    expect(result.bytesFreed).toBe(0);
    // Passthrough returns the same reference, not a fresh clone.
    expect(result.messages).toBe(messages);
    expect(messages).toEqual(before);
  });

  test("truncates oldest-first until total is under budget", () => {
    // 3 tool results, each 50KB. Budget = 80KB, truncate = 10KB.
    // Oldest tool msg (50KB) should be truncated first; that brings
    // running total from 150KB to ~10KB + 50KB + 50KB = ~110KB.
    // Still over budget → truncate second oldest. After two cuts:
    // ~10KB + ~10KB + 50KB ≈ 70KB ≤ 80KB → stop. Third remains intact.
    const big = 50 * 1024;
    const messages: LLMMessage[] = [
      mkUserMsg("seed"),
      mkToolMsg(big, "First"),
      mkAssistantMsg("ack"),
      mkToolMsg(big, "Second"),
      mkAssistantMsg("ack"),
      mkToolMsg(big, "Third"),
    ];
    const result = applyToolResultBudgeting(messages, undefined, {
      maxToolResultBudgetBytes: 80 * 1024,
      truncateToBytes: 10 * 1024,
    });
    expect(result.truncatedCount).toBe(2);
    expect(result.bytesFreed).toBeGreaterThan(0);
    // Oldest two tool messages should be truncated; newest intact.
    const first = result.messages[1];
    const second = result.messages[3];
    const third = result.messages[5];
    expect(typeof first?.content === "string" && first.content.includes("[truncated:")).toBe(true);
    expect(typeof second?.content === "string" && second.content.includes("[truncated:")).toBe(true);
    expect(third?.content).toBe(repeat(big, "x"));
  });

  test("preserves message ordering and non-tool entries verbatim", () => {
    const big = 20 * 1024;
    const user = mkUserMsg("u1");
    const assistantA = mkAssistantMsg("aA");
    const assistantB = mkAssistantMsg("aB");
    const messages: LLMMessage[] = [
      user,
      mkToolMsg(big, "A"),
      assistantA,
      mkToolMsg(big, "B"),
      assistantB,
    ];
    const result = applyToolResultBudgeting(messages, undefined, {
      maxToolResultBudgetBytes: 5 * 1024,
      truncateToBytes: 1 * 1024,
    });
    expect(result.messages).toHaveLength(messages.length);
    expect(result.messages[0]).toBe(user);
    expect(result.messages[2]).toBe(assistantA);
    expect(result.messages[4]).toBe(assistantB);
    expect(result.messages[1]?.role).toBe("tool");
    expect(result.messages[3]?.role).toBe("tool");
  });

  test("respects truncateToBytes cap (never under-truncates)", () => {
    const big = 100 * 1024;
    const messages: LLMMessage[] = [mkToolMsg(big)];
    const result = applyToolResultBudgeting(messages, undefined, {
      maxToolResultBudgetBytes: 1_000,
      truncateToBytes: 8 * 1024,
    });
    expect(result.truncatedCount).toBe(1);
    const content = result.messages[0]?.content;
    expect(typeof content).toBe("string");
    expect((content as string).length).toBeLessThanOrEqual(8 * 1024);
    expect((content as string).endsWith("]\n")).toBe(true);
    expect((content as string)).toContain("[truncated: original was");
    expect((content as string)).toContain("returning first");
  });

  test("env override AGENC_TOOL_RESULT_BUDGET_BYTES wins over config", () => {
    // Config says "large budget" (would be a no-op); env clamps it
    // down so the helper must truncate.
    process.env.AGENC_TOOL_RESULT_BUDGET_BYTES = String(4 * 1024);
    const big = 50 * 1024;
    const messages: LLMMessage[] = [mkToolMsg(big)];
    const result = applyToolResultBudgeting(messages, undefined, {
      maxToolResultBudgetBytes: 10 * 1024 * 1024,
      truncateToBytes: 2 * 1024,
    });
    expect(result.truncatedCount).toBe(1);
    expect(result.bytesFreed).toBeGreaterThan(0);
  });

  test("env override AGENC_TOOL_RESULT_TRUNCATE_BYTES caps truncation", () => {
    process.env.AGENC_TOOL_RESULT_TRUNCATE_BYTES = String(3 * 1024);
    const big = 50 * 1024;
    const messages: LLMMessage[] = [mkToolMsg(big)];
    const result = applyToolResultBudgeting(messages, undefined, {
      maxToolResultBudgetBytes: 1_000,
      truncateToBytes: 500 * 1024, // would be huge; env wins
    });
    expect(result.truncatedCount).toBe(1);
    const content = result.messages[0]?.content as string;
    expect(content.length).toBeLessThanOrEqual(3 * 1024);
  });

  test("uses I-88 index when larger than in-place measurement", () => {
    // Empty in-place messages, but the I-88 index says a lot of
    // tool-result bytes have been recorded this session. We can't
    // shed from empty messages, so truncatedCount stays 0 — but the
    // helper correctly reads the index total.
    const messages: LLMMessage[] = [];
    const idx = new Map<string, number>([
      ["turn-1", 10 * 1024 * 1024],
      ["turn-2", 5 * 1024 * 1024],
    ]);
    const result = applyToolResultBudgeting(messages, idx, {
      maxToolResultBudgetBytes: 2 * 1024 * 1024,
      truncateToBytes: 40 * 1024,
    });
    expect(result.truncatedCount).toBe(0);
    expect(result.messages).toBe(messages);
  });
});

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
  test("emits tool_result_budget_truncated warning and mutates state.messagesForQuery", async () => {
    const big = 20 * 1024;
    const events: Event[] = [];
    const session = mkSession(events);
    const state = mkState([
      mkUserMsg("seed"),
      mkToolMsg(big, "A"),
      mkAssistantMsg("ack"),
      mkToolMsg(big, "B"),
    ]);
    await prepareContext(state, mkCtx(), session);
    const warnings = events.filter((e) => e.msg.type === "warning");
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    const payload = warnings[0]?.msg.payload as {
      cause?: string;
      message?: string;
    };
    expect(payload.cause).toBe("tool_result_budget_truncated");
    expect(payload.message).toMatch(/\d+ tool result\(s\) truncated/);
    // The truncated slice should be what the stream phase sees.
    expect(state.messagesForQuery.length).toBe(4);
    const toolMsg = state.messagesForQuery.find((m) => m.role === "tool");
    expect(
      typeof toolMsg?.content === "string" &&
        toolMsg.content.includes("[truncated:"),
    ).toBe(true);
  });

  test("no warning emitted when total is under budget", async () => {
    const events: Event[] = [];
    const session = mkSession(events);
    const state = mkState([
      mkUserMsg("seed"),
      mkToolMsg(500),
      mkAssistantMsg("ack"),
    ]);
    await prepareContext(state, mkCtx(), session);
    const budgetWarnings = events.filter(
      (e) =>
        e.msg.type === "warning" &&
        (e.msg.payload as { cause?: string }).cause ===
          "tool_result_budget_truncated",
    );
    expect(budgetWarnings).toHaveLength(0);
  });
});

describe("prepareContext Stage 3/4 wiring", () => {
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

  test("microcompact clears older tool results on the live path", async () => {
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
    expect(toolMessages[0]?.content).toContain(
      "[Old tool result content cleared]",
    );
    expect(toolMessages[1]?.content).toContain(
      "[Old tool result content cleared]",
    );
    for (const toolMessage of toolMessages.slice(2)) {
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
    process.env.CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE;
  const originalUserType = process.env.USER_TYPE;
  const originalMaxContext = process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS;
  const originalAutoCompactPct = process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE;

  beforeEach(() => {
    delete process.env.DISABLE_AUTO_COMPACT;
    delete process.env.CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE;
    delete process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS;
    delete process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE;
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
      process.env.CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE =
        originalBlockingLimitOverride;
    } else {
      delete process.env.CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE;
    }
    if (originalUserType !== undefined) {
      process.env.USER_TYPE = originalUserType;
    } else {
      delete process.env.USER_TYPE;
    }
    if (originalMaxContext !== undefined) {
      process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = originalMaxContext;
    } else {
      delete process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS;
    }
    if (originalAutoCompactPct !== undefined) {
      process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = originalAutoCompactPct;
    } else {
      delete process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE;
    }
    vi.restoreAllMocks();
  });

  test("hard blocking-limit preempts when auto compact recovery is not owning the turn", async () => {
    process.env.DISABLE_AUTO_COMPACT = "1";
    process.env.CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE = "50";
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
    process.env.CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE = "50";

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

  test("successful compaction on this iteration skips blocking preempt and carries taskBudgetRemaining forward", async () => {
    process.env.CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE = "1";
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
    process.env.CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE = "1000000";

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
