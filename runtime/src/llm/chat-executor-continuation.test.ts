import { describe, expect, it } from "vitest";

import {
  checkTurnContinuationBudget,
  countTurnCompletionTokens,
  createTurnContinuationState,
  finishTurnContinuation,
  shouldStopForDiminishingReturns,
  startTurnContinuation,
} from "./chat-executor-continuation.js";
import type {
  ChatCallUsageRecord,
  ExecutionContext,
  ToolCallRecord,
} from "./chat-executor-types.js";

function makeCallUsageRecord(
  completionTokens: number,
): ChatCallUsageRecord {
  return {
    callIndex: 1,
    phase: "tool_followup",
    provider: "test",
    model: "test-model",
    finishReason: "stop",
    usage: {
      promptTokens: 10,
      completionTokens,
      totalTokens: completionTokens + 10,
    },
    durationMs: 1,
    beforeBudget: { tokens: 0, messages: 0, toolSchemas: 0 },
    afterBudget: { tokens: 0, messages: 0, toolSchemas: 0 },
  };
}

function makeToolCall(overrides: Partial<ToolCallRecord> = {}): ToolCallRecord {
  return {
    name: "system.writeFile",
    args: { path: "src/main.c", content: "ok" },
    result: JSON.stringify({ ok: true }),
    isError: false,
    durationMs: 1,
    ...overrides,
  };
}

function makeCtx(params: {
  readonly callUsage?: readonly ChatCallUsageRecord[];
  readonly allToolCalls?: readonly ToolCallRecord[];
} = {}): ExecutionContext {
  return {
    callUsage: [...(params.callUsage ?? [])],
    allToolCalls: [...(params.allToolCalls ?? [])],
    continuationState: createTurnContinuationState(),
  } as unknown as ExecutionContext;
}

describe("chat-executor-continuation", () => {
  it("treats real tool activity as productive continuation progress", () => {
    const ctx = makeCtx();
    const active = startTurnContinuation({
      state: ctx.continuationState,
      ctx,
      reason: "turn_end_stop_gate",
      validatorId: "turn_end_stop_gate",
    });

    ctx.allToolCalls.push(makeToolCall());

    const summary = finishTurnContinuation({
      state: ctx.continuationState,
      ctx,
    });

    expect(active.attempt).toBe(1);
    expect(summary?.productive).toBe(true);
    expect(summary?.toolCallsIssued).toBe(true);
    expect(summary?.successfulWorkspaceMutation).toBe(true);
    expect(ctx.continuationState.consecutiveLowProgressStalls).toBe(0);
  });

  it("flags low-progress narration-only continuation cycles", () => {
    const ctx = makeCtx();
    startTurnContinuation({
      state: ctx.continuationState,
      ctx,
      reason: "artifact_evidence",
      validatorId: "artifact_evidence",
    });

    ctx.callUsage.push(makeCallUsageRecord(120));

    const summary = finishTurnContinuation({
      state: ctx.continuationState,
      ctx,
    });

    expect(summary?.productive).toBe(false);
    expect(summary?.lowProgressStall).toBe(true);
    expect(summary?.outputTokenDelta).toBe(120);
    expect(ctx.continuationState.consecutiveLowProgressStalls).toBe(1);
  });

  it("stops for diminishing returns after three low-progress continuation cycles", () => {
    const ctx = makeCtx();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      startTurnContinuation({
        state: ctx.continuationState,
        ctx,
        reason: "turn_end_stop_gate",
        validatorId: "turn_end_stop_gate",
      });
      ctx.callUsage.push(makeCallUsageRecord(100));
      finishTurnContinuation({
        state: ctx.continuationState,
        ctx,
      });
    }

    expect(ctx.continuationState.continuationCount).toBe(3);
    expect(ctx.continuationState.consecutiveLowProgressStalls).toBe(3);
    expect(shouldStopForDiminishingReturns(ctx.continuationState)).toBe(true);
  });

  it("continues while the turn stays below the token budget threshold", () => {
    const ctx = makeCtx({
      callUsage: [makeCallUsageRecord(300)],
    });

    const decision = checkTurnContinuationBudget({
      state: ctx.continuationState,
      budget: 1_000,
      globalTurnTokens: countTurnCompletionTokens(ctx.callUsage),
      eligible: true,
    });

    expect(decision.action).toBe("continue");
    if (decision.action !== "continue") {
      throw new Error("Expected continuation");
    }
    expect(decision.continuationCount).toBe(1);
    expect(decision.turnTokens).toBe(300);
    expect(ctx.continuationState.budget.lastGlobalOutputTokens).toBe(300);
  });

  it("stops token-budget continuation after repeated low-delta continuations", () => {
    const ctx = makeCtx();

    let globalTurnTokens = 100;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const decision = checkTurnContinuationBudget({
        state: ctx.continuationState,
        budget: 2_000,
        globalTurnTokens,
        eligible: true,
      });
      expect(decision.action).toBe("continue");
      globalTurnTokens += 100;
    }

    const stopDecision = checkTurnContinuationBudget({
      state: ctx.continuationState,
      budget: 2_000,
      globalTurnTokens,
      eligible: true,
    });

    expect(stopDecision.action).toBe("stop");
    if (stopDecision.action !== "stop") {
      throw new Error("Expected stop");
    }
    expect(stopDecision.completionEvent?.diminishingReturns).toBe(true);
    expect(stopDecision.completionEvent?.continuationCount).toBe(3);
  });

  it("keeps token-budget stalls from poisoning validator recovery diminishing returns", () => {
    const ctx = makeCtx();

    const budgetDecision = checkTurnContinuationBudget({
      state: ctx.continuationState,
      budget: 2_000,
      globalTurnTokens: 100,
      eligible: true,
    });
    expect(budgetDecision.action).toBe("continue");
    if (budgetDecision.action !== "continue") {
      throw new Error("Expected token-budget continuation");
    }

    startTurnContinuation({
      state: ctx.continuationState,
      ctx,
      reason: "token_budget",
    });
    finishTurnContinuation({ state: ctx.continuationState, ctx });

    startTurnContinuation({
      state: ctx.continuationState,
      ctx,
      reason: "validator",
      validatorId: "top_level_verifier",
    });
    finishTurnContinuation({ state: ctx.continuationState, ctx });

    expect(ctx.continuationState.continuationCount).toBe(1);
    expect(ctx.continuationState.consecutiveLowProgressStalls).toBe(1);
    expect(shouldStopForDiminishingReturns(ctx.continuationState)).toBe(false);
  });
});
