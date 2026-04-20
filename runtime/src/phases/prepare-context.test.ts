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
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { LLMMessage } from "../llm/types.js";
import type { Event } from "../session/event-log.js";
import type { Session } from "../session/session.js";
import type { TurnContext } from "../session/turn-context.js";
import type { TurnState } from "../session/turn-state.js";
import {
  applyToolResultBudgeting,
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

function mkCtx(): TurnContext {
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
    modelInfo: { slug: "stub" },
    cwd: "/tmp",
    depth: 0,
  } as unknown as TurnContext;
}

function mkSession(collected: Event[]): Session {
  let i = 0;
  return {
    conversationId: "conv-1",
    rolloutStore: null,
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
