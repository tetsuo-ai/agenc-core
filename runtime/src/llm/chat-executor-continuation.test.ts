import { describe, expect, it } from "vitest";

import {
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
});
