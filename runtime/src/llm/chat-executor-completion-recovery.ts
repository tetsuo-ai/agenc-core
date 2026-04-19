/**
 * Completion-recovery helpers extracted from chat-executor-tool-loop.
 *
 * The tool loop's stop-gate path can trigger two kinds of in-turn
 * recovery after the model stops requesting tools:
 *
 *   1. `attemptCompletionRecovery` — fires when a stop-hook returns
 *      `retry_with_blocking_message`. It pushes the blocking message
 *      into history, compacts, re-calls the model (with `tool_choice:
 *      required` for mutation / artifact-evidence validation codes),
 *      and either resumes the outer loop or records the recovery as
 *      exhausted.
 *
 *   2. `attemptTokenBudgetContinuation` — fires when the continuation
 *      controller decides the turn needs a budget nudge. It injects
 *      the nudge message, compacts, re-calls the model, and resumes
 *      the outer loop when the model produces more output.
 *
 * Both helpers return `{ recovered }` — a `true` value signals the
 * caller to set its `shouldContinueAfterStopGate` flag and re-enter
 * the tool loop on the next iteration of the outer do-while.
 *
 * @module
 */

import type {
  ExecutionContext,
  ChatCallUsageRecord,
} from "./chat-executor-types.js";
import type { CompletionValidatorId } from "../runtime-contract/types.js";
import type { ToolLoopCallbacks, ToolLoopConfig } from "./chat-executor-tool-loop.js";
import type { DelegationOutputValidationCode } from "../utils/delegation-validation.js";
import type { StopHookPhaseResult } from "./hooks/stop-hooks.js";
import {
  checkTurnContinuationBudget,
  countTurnCompletionTokens,
  finishTurnContinuation,
  shouldStopForDiminishingReturns,
  startTurnContinuation,
} from "./chat-executor-continuation.js";
import {
  getRemainingRequestMs,
  hasModelRecallBudget,
} from "./chat-executor-ctx-helpers.js";
import {
  callModelWithReactiveCompact,
  runPerIterationCompactionBeforeModelCall,
} from "./chat-executor-compaction-wrappers.js";
import {
  failClosedOnMalformedToolContinuation,
  sealPendingToolProtocol,
} from "./chat-executor-tool-protocol-helpers.js";
import { responseHasToolCalls } from "./tool-protocol-state.js";

const TOOL_FOLLOWUP_PHASE: ChatCallUsageRecord["phase"] = "tool_followup";

export interface CompletionRecoveryParams {
  readonly ctx: ExecutionContext;
  readonly config: ToolLoopConfig;
  readonly callbacks: ToolLoopCallbacks;
  readonly reason: string;
  readonly blockingMessage?: string;
  readonly evidence?: unknown;
  readonly maxAttempts?: number;
  readonly budgetReason: string;
  readonly exhaustedDetail: string;
  readonly validationCode?: DelegationOutputValidationCode;
  readonly validatorId?: CompletionValidatorId;
  readonly stopHookResult?: StopHookPhaseResult;
  readonly continuationSummary?: ReturnType<typeof finishTurnContinuation>;
}

export interface CompletionRecoveryResult {
  /** When true, the caller should continue the outer tool loop. */
  readonly recovered: boolean;
}

/**
 * Default cap on stop-hook recovery retries when neither the
 * stopHookRuntime nor requiredToolEvidence supplies an explicit value.
 * Without this default the cap was `undefined` (= unlimited), so a
 * single misclassified `narrated_future_tool_work` rejection could
 * pump the model into hundreds of `tool_choice: required` rounds with
 * no exit. Two attempts is enough for a real recovery (one nudge, one
 * retry) without becoming an infinite retry pump on detector
 * misfires.
 */
const DEFAULT_COMPLETION_RECOVERY_MAX_ATTEMPTS = 2;

export async function attemptCompletionRecovery(
  params: CompletionRecoveryParams,
): Promise<CompletionRecoveryResult> {
  const { ctx, config, callbacks } = params;
  const continuationCap =
    params.maxAttempts !== undefined
      ? Math.max(0, params.maxAttempts)
      : DEFAULT_COMPLETION_RECOVERY_MAX_ATTEMPTS;
  const shouldExhaustForDiminishingReturns = shouldStopForDiminishingReturns(
    ctx.continuationState,
  );
  if (
    !params.blockingMessage ||
    (continuationCap !== undefined &&
      ctx.continuationState.continuationCount >= continuationCap) ||
    shouldExhaustForDiminishingReturns
  ) {
    if (params.stopHookResult) {
      callbacks.emitExecutionTrace(ctx, {
        type: "stop_hook_exhausted",
        phase: "tool_followup",
        callIndex: ctx.callIndex,
        payload: {
          validatorId: params.validatorId ?? params.reason,
          stopHookPhase: params.stopHookResult.phase,
          outcome: params.stopHookResult.outcome,
          reason: params.stopHookResult.reason,
          stopReason: params.stopHookResult.stopReason,
          exhaustedDetail: params.exhaustedDetail,
          validationCode: params.validationCode,
          attempts: ctx.continuationState.continuationCount,
          maxAttempts: continuationCap,
          diminishingReturns: shouldExhaustForDiminishingReturns,
        },
      });
    }
    callbacks.emitExecutionTrace(ctx, {
      type: "continuation_stopped",
      phase: "tool_followup",
      callIndex: ctx.callIndex,
      payload: {
        reason: params.reason,
        validatorId: params.validatorId,
        attempt: ctx.continuationState.continuationCount,
        maxAttempts: continuationCap,
        exhaustedDetail: params.exhaustedDetail,
        continuationSummary: params.continuationSummary,
        stopCause: shouldExhaustForDiminishingReturns
          ? "diminishing_returns"
          : continuationCap !== undefined &&
              ctx.continuationState.continuationCount >= continuationCap
            ? "continuation_cap"
            : "blocking_message_unavailable",
      },
    });
    callbacks.setStopReason(
      ctx,
      "validation_error",
      shouldExhaustForDiminishingReturns
        ? `${params.exhaustedDetail} Runtime continuation controller stopped after repeated low-progress recoveries.`
        : params.exhaustedDetail,
    );
    if (params.validationCode) {
      ctx.validationCode = params.validationCode;
    }
    if (ctx.response) {
      ctx.response = {
        ...ctx.response,
        content: "",
      };
    }
    return { recovered: false };
  }

  sealPendingToolProtocol(ctx, callbacks, "validation_recovery");
  const activeContinuation = startTurnContinuation({
    state: ctx.continuationState,
    ctx,
    reason: params.reason,
    validatorId: params.validatorId,
    tighterCap: continuationCap,
  });
  if (params.stopHookResult) {
    callbacks.emitExecutionTrace(ctx, {
      type: "stop_hook_retry_requested",
      phase: "tool_followup",
      callIndex: ctx.callIndex,
      payload: {
        validatorId: params.validatorId ?? params.reason,
        stopHookPhase: params.stopHookResult.phase,
        outcome: params.stopHookResult.outcome,
        reason: params.stopHookResult.reason,
        stopReason: params.stopHookResult.stopReason,
        attempt: activeContinuation.attempt,
        maxAttempts: continuationCap,
        validationCode: params.validationCode,
      },
    });
  }
  callbacks.emitExecutionTrace(ctx, {
    type: "continuation_started",
    phase: "tool_followup",
    callIndex: ctx.callIndex,
    payload: {
      reason: params.reason,
      validatorId: params.validatorId,
      attempt: activeContinuation.attempt,
      maxAttempts: continuationCap,
    },
  });
  callbacks.emitExecutionTrace(ctx, {
    type: "stop_gate_intervention",
    phase: "tool_followup",
    callIndex: ctx.callIndex,
    payload: {
      reason: params.reason,
      attempt: activeContinuation.attempt,
      maxAttempts: continuationCap,
      finalContentPreview: (ctx.response?.content ?? "").slice(0, 240),
      ...(params.evidence !== undefined ? { evidence: params.evidence } : {}),
    },
  });
  callbacks.pushMessage(
    ctx,
    {
      role: "user",
      content: params.blockingMessage,
    },
    "system_runtime",
  );
  await runPerIterationCompactionBeforeModelCall(
    ctx,
    config,
    callbacks,
    TOOL_FOLLOWUP_PHASE,
  );
  const shouldRequireRecoveryTool =
    params.validationCode === "missing_file_mutation_evidence" ||
    params.validationCode === "missing_file_artifact_evidence" ||
    (params.stopHookResult !== undefined &&
      ctx.requiredToolEvidence !== undefined);
  const recoveryToolChoice = shouldRequireRecoveryTool ? "required" : undefined;
  const recoveryResponse = await callModelWithReactiveCompact(
    ctx,
    callbacks,
    TOOL_FOLLOWUP_PHASE,
    () => ({
      phase: TOOL_FOLLOWUP_PHASE,
      callMessages: ctx.messages,
      callSections: ctx.messageSections,
      onStreamChunk: ctx.activeStreamCallback,
      structuredOutput: ctx.structuredOutput,
      promptCacheKey: ctx.sessionId,
      toolChoice: recoveryToolChoice,
      budgetReason: params.budgetReason,
    }),
  );
  if (!recoveryResponse) {
    ctx.continuationState.active = undefined;
    if (params.stopHookResult) {
      callbacks.emitExecutionTrace(ctx, {
        type: "stop_hook_exhausted",
        phase: "tool_followup",
        callIndex: ctx.callIndex,
        payload: {
          validatorId: params.validatorId ?? params.reason,
          stopHookPhase: params.stopHookResult.phase,
          outcome: params.stopHookResult.outcome,
          reason: params.stopHookResult.reason,
          stopReason: params.stopHookResult.stopReason,
          exhaustedDetail: params.exhaustedDetail,
          validationCode: params.validationCode,
          attempt: activeContinuation.attempt,
          maxAttempts: continuationCap,
        },
      });
    }
    if (ctx.stopReason === "completed") {
      callbacks.setStopReason(ctx, "validation_error", params.exhaustedDetail);
      if (params.validationCode) {
        ctx.validationCode = params.validationCode;
      }
    }
    return { recovered: false };
  }
  if (
    (params.validationCode === "missing_file_mutation_evidence" ||
      params.validationCode === "missing_file_artifact_evidence") &&
    !responseHasToolCalls(recoveryResponse)
  ) {
    ctx.continuationState.active = undefined;
    callbacks.emitExecutionTrace(ctx, {
      type: "continuation_stopped",
      phase: "tool_followup",
      callIndex: ctx.callIndex,
      payload: {
        reason: params.reason,
        validatorId: params.validatorId,
        attempt: activeContinuation.attempt,
        maxAttempts: continuationCap,
        exhaustedDetail: params.exhaustedDetail,
        validationCode: params.validationCode,
        stopCause: "missing_required_recovery_tool_calls",
      },
    });
    callbacks.setStopReason(ctx, "validation_error", params.exhaustedDetail);
    ctx.validationCode = params.validationCode;
    ctx.response = { ...recoveryResponse, content: "" };
    return { recovered: false };
  }
  ctx.response = recoveryResponse;
  failClosedOnMalformedToolContinuation(ctx, callbacks);
  return { recovered: true };
}

export interface TokenBudgetContinuationParams {
  readonly ctx: ExecutionContext;
  readonly config: ToolLoopConfig;
  readonly callbacks: ToolLoopCallbacks;
  readonly continuationSummary?: ReturnType<typeof finishTurnContinuation>;
}

export async function attemptTokenBudgetContinuation(
  params: TokenBudgetContinuationParams,
): Promise<CompletionRecoveryResult> {
  const { ctx, config, callbacks } = params;
  const decision = checkTurnContinuationBudget({
    state: ctx.continuationState,
    budget: ctx.turnOutputTokenBudget,
    globalTurnTokens: countTurnCompletionTokens(ctx.callUsage),
    eligible: isBudgetContinuationEligible(ctx),
  });
  if (decision.action === "stop") {
    if (decision.completionEvent) {
      callbacks.emitExecutionTrace(ctx, {
        type: "continuation_stopped",
        phase: "tool_followup",
        callIndex: ctx.callIndex,
        payload: {
          reason: "token_budget",
          continuationSummary: params.continuationSummary,
          completionEvent: decision.completionEvent,
          stopCause: decision.completionEvent.diminishingReturns
            ? "diminishing_returns"
            : "token_budget_completed",
        },
      });
    }
    return { recovered: false };
  }
  if (!hasModelRecallBudget(ctx) || getRemainingRequestMs(ctx) <= 0) {
    callbacks.emitExecutionTrace(ctx, {
      type: "continuation_stopped",
      phase: "tool_followup",
      callIndex: ctx.callIndex,
      payload: {
        reason: "token_budget",
        continuationSummary: params.continuationSummary,
        stopCause: !hasModelRecallBudget(ctx)
          ? "model_recall_budget_exhausted"
          : "request_timeout_exhausted",
        turnTokens: decision.turnTokens,
        budget: decision.budget,
        pct: decision.pct,
        continuationCount: decision.continuationCount,
      },
    });
    return { recovered: false };
  }
  sealPendingToolProtocol(ctx, callbacks, "validation_recovery");
  const activeContinuation = startTurnContinuation({
    state: ctx.continuationState,
    ctx,
    reason: "token_budget",
  });
  callbacks.emitExecutionTrace(ctx, {
    type: "continuation_started",
    phase: "tool_followup",
    callIndex: ctx.callIndex,
    payload: {
      reason: "token_budget",
      attempt: activeContinuation.attempt,
      continuationCount: decision.continuationCount,
      turnTokens: decision.turnTokens,
      budget: decision.budget,
      pct: decision.pct,
    },
  });
  callbacks.pushMessage(
    ctx,
    {
      role: "user",
      content: decision.nudgeMessage,
    },
    "system_runtime",
  );
  await runPerIterationCompactionBeforeModelCall(
    ctx,
    config,
    callbacks,
    TOOL_FOLLOWUP_PHASE,
  );
  const continuationResponse = await callModelWithReactiveCompact(
    ctx,
    callbacks,
    TOOL_FOLLOWUP_PHASE,
    () => ({
      phase: TOOL_FOLLOWUP_PHASE,
      callMessages: ctx.messages,
      callSections: ctx.messageSections,
      onStreamChunk: ctx.activeStreamCallback,
      structuredOutput: ctx.structuredOutput,
      promptCacheKey: ctx.sessionId,
      budgetReason:
        "Max model recalls exceeded during token-budget continuation",
    }),
  );
  if (!continuationResponse) {
    ctx.continuationState.active = undefined;
    return { recovered: false };
  }
  ctx.response = continuationResponse;
  failClosedOnMalformedToolContinuation(ctx, callbacks);
  return { recovered: true };
}

function isBudgetContinuationEligible(ctx: ExecutionContext): boolean {
  const structuredOutputActive =
    ctx.structuredOutput?.schema !== undefined &&
    ctx.structuredOutput.enabled !== false;
  if (structuredOutputActive) return false;
  if (ctx.sessionId.startsWith("subagent:")) return false;
  return true;
}
