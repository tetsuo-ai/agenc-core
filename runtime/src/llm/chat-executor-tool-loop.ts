/**
 * Tool call loop and single tool dispatch extracted from ChatExecutor.
 *
 * @module
 */

import type {
  LLMResponse,
  StreamProgressCallback,
  LLMStatefulResumeAnchor,
  LLMStructuredOutputRequest,
  LLMToolChoice,
} from "./types.js";
import type { PromptBudgetSection } from "./prompt-budget.js";
import type { LLMRetryPolicyMatrix, LLMPipelineStopReason } from "./policy.js";
import type {
  ToolCallRecord,
  ChatExecutionTraceEvent,
  ChatCallUsageRecord,
  ExecutionContext,
  ToolLoopTerminalResult,
  ToolLoopState,
  RecoveryHint,
} from "./chat-executor-types.js";
import {
  MAX_TOOL_IMAGE_CHARS_BUDGET,
} from "./chat-executor-constants.js";
import { isRuntimeLimitReached } from "./runtime-limit-policy.js";
import {
  didToolCallFail,
  buildToolLoopRecoveryMessages,
  buildRoutingExpansionMessage,
} from "./chat-executor-tool-utils.js";
import {
  FAILED_TOOL_RECOVERY_STREAK,
  buildFailedToolRecoveryHint,
  collectRecentConsecutiveFailedToolCalls,
  mergeRecoveryHints,
  responseRepeatsFailedToolPattern,
  updateFailedToolStreak,
} from "./chat-executor-failed-tool-tracking.js";
import {
  emitToolProtocolViolation,
  failClosedOnMalformedToolContinuation,
  materializeResponseToolCalls,
  sealPendingToolProtocol,
} from "./chat-executor-tool-protocol-helpers.js";
import {
  callModelWithReactiveCompact,
  runPerIterationCompactionBeforeModelCall,
} from "./chat-executor-compaction-wrappers.js";
import {
  applyActiveRoutedToolNames,
  buildActiveRoutedToolSet,
} from "./chat-executor-routing-state.js";
import { buildRecoveryHints } from "./chat-executor-recovery.js";
import { buildTurnEndStopGateSnapshot } from "./chat-executor-stop-gate.js";
import {
  checkTurnContinuationBudget,
  countTurnCompletionTokens,
  finishTurnContinuation,
  shouldStopForDiminishingReturns,
  startTurnContinuation,
} from "./chat-executor-continuation.js";
import { generateFallbackContent } from "./chat-executor-text.js";
import { HookRegistry } from "./hooks/index.js";
import {
  BUILTIN_ARTIFACT_EVIDENCE_HOOK_ID,
  BUILTIN_TURN_END_STOP_GATE_ID,
  runStopHookPhase,
} from "./hooks/stop-hooks.js";
import type { CanUseToolFn } from "./can-use-tool.js";
import {
  partitionToolCalls,
  type IsConcurrencySafeFn,
} from "./tool-orchestration.js";
import {
  type ContentReplacementState,
  type ToolBudgetConfig,
} from "./tool-result-budget.js";
import {
  appendToolRecord,
  checkRequestTimeout,
  clearRuntimeInstructionKey,
  emitExecutionTrace,
  getRemainingRequestMs,
  hasModelRecallBudget,
  maybePushRuntimeInstruction,
  maybePushKeyedRuntimeInstruction,
  pushMessage,
  replaceRuntimeRecoveryHintMessages,
  serializeRemainingRequestMs,
  setStopReason,
} from "./chat-executor-ctx-helpers.js";
import {
  DELEGATION_OUTPUT_VALIDATION_CODES,
  type DelegationOutputValidationCode,
} from "../utils/delegation-validation.js";
import {
  type CompletionValidatorId,
  updateRuntimeContractValidatorSnapshot,
} from "../runtime-contract/types.js";
import {
  getPendingToolProtocolCalls,
  hasPendingToolProtocol,
  responseHasToolCalls,
} from "./tool-protocol-state.js";
import {
  type RequestTaskObservationResult,
} from "./request-task-progress.js";
import { executeSingleToolCall } from "./chat-executor-single-tool-dispatch.js";

// ============================================================================
// Callback interfaces
// ============================================================================

export interface ToolLoopCallbacks {
  pushMessage(
    ctx: ExecutionContext,
    message: import("./types.js").LLMMessage,
    section: PromptBudgetSection,
    reconciliationMessage?: import("./types.js").LLMMessage,
  ): void;
  setStopReason(
    ctx: ExecutionContext,
    reason: LLMPipelineStopReason,
    detail?: string,
  ): void;
  checkRequestTimeout(ctx: ExecutionContext, stage: string): boolean;
  appendToolRecord(
    ctx: ExecutionContext,
    record: ToolCallRecord,
  ): RequestTaskObservationResult | undefined;
  emitExecutionTrace(
    ctx: ExecutionContext,
    event: ChatExecutionTraceEvent,
  ): void;
  replaceRuntimeRecoveryHintMessages(
    ctx: ExecutionContext,
    recoveryHints: readonly RecoveryHint[],
  ): void;
  maybePushRuntimeInstruction(ctx: ExecutionContext, content: string): void;
  maybePushKeyedRuntimeInstruction(
    ctx: ExecutionContext,
    params: {
      readonly key: string;
      readonly content: string;
    },
  ): void;
  clearRuntimeInstructionKey(ctx: ExecutionContext, key: string): void;
  callModelForPhase(
    ctx: ExecutionContext,
    input: {
      phase: ChatCallUsageRecord["phase"];
      callMessages: readonly import("./types.js").LLMMessage[];
      callSections?: readonly PromptBudgetSection[];
      onStreamChunk?: StreamProgressCallback;
      statefulSessionId?: string;
      statefulResumeAnchor?: LLMStatefulResumeAnchor;
      statefulHistoryCompacted?: boolean;
      routedToolNames?: readonly string[];
      persistRoutedToolNames?: boolean;
      toolChoice?: LLMToolChoice;
      structuredOutput?: LLMStructuredOutputRequest;
      preparationDiagnostics?: Record<string, unknown>;
      allowRecallBudgetBypass?: boolean;
      budgetReason: string;
    },
  ): Promise<LLMResponse | undefined>;
  serializeRemainingRequestMs(remainingRequestMs: number): number | null;
}

const TERMINAL_MUTATION_TOOL_NAMES = new Set([
  "system.applyPatch",
  "system.appendFile",
  "system.delete",
  "system.editFile",
  "system.mkdir",
  "system.move",
  "system.writeFile",
  "desktop.text_editor",
]);

function detectSuccessfulWorkspaceMutation(
  toolCalls: readonly ToolCallRecord[],
): boolean {
  return toolCalls.some(
    (call) =>
      TERMINAL_MUTATION_TOOL_NAMES.has(call.name) &&
      !didToolCallFail(call.isError, call.result),
  );
}

function buildToolLoopTerminalResult(
  ctx: ExecutionContext,
): ToolLoopTerminalResult {
  return {
    content: ctx.finalContent,
    stopReason: ctx.stopReason,
    ...(ctx.stopReasonDetail ? { stopReasonDetail: ctx.stopReasonDetail } : {}),
    ...(ctx.validationCode ? { validationCode: ctx.validationCode } : {}),
    runtimeContractSnapshot: ctx.runtimeContractSnapshot,
    mutationDetected: detectSuccessfulWorkspaceMutation(ctx.allToolCalls),
  };
}

function asDelegationOutputValidationCode(
  value: unknown,
): DelegationOutputValidationCode | undefined {
  return typeof value === "string" &&
    (DELEGATION_OUTPUT_VALIDATION_CODES as readonly string[]).includes(value)
    ? (value as DelegationOutputValidationCode)
    : undefined;
}

export interface ToolLoopConfig {
  readonly maxRuntimeSystemHints: number;
  readonly toolCallTimeoutMs: number;
  readonly retryPolicyMatrix: LLMRetryPolicyMatrix;
  readonly allowedTools: Set<string> | null;
  /**
   * The model's context window in tokens. Used to compute the
   * autocompact threshold as a percentage of the window
   * (DEFAULT_AUTOCOMPACT_THRESHOLD_FRACTION = 40%). When not set,
   * falls back to DEFAULT_AUTOCOMPACT_THRESHOLD_TOKENS (120K).
   */
  readonly contextWindowTokens?: number;
  readonly maxOutputTokens?: number;
  /** Cut 5.2: hook registry for PreToolUse / PostToolUse / PostToolUseFailure. */
  readonly hookRegistry?: HookRegistry;
  /**
   * Cut 5.7: canUseTool permission seam. When set, the tool dispatch
   * loop calls this before each tool to check whether the call is
   * allowed. Returning `deny` short-circuits the call with the hook's
   * message. Returning `ask` is currently treated as a soft deny at
   * this layer (interactive approval is the gateway's responsibility).
   * Returning `allow` with `updatedInput` rewrites the tool args
   * before dispatch.
   */
  readonly canUseTool?: CanUseToolFn;
  /**
   * Cut 5.5: concurrency-safe tool predicate. When set, the tool loop
   * partitions each round's tool calls into consecutive-concurrency-safe
   * batches and emits a telemetry trace describing the partition shape.
   * The dispatch itself remains serial (stateful mutation through the
   * loop callbacks is order-sensitive); this wiring lets callers
   * inventory which rounds would benefit from parallel dispatch.
   */
  readonly isConcurrencySafe?: IsConcurrencySafeFn;
  /**
   * Cut 5.3: tool result budget config. When set, oversized tool
   * results are persisted to disk and replaced in the message
   * history with a `<persisted-output>` placeholder that includes
   * the file path + a 2 KB preview. The state is stored on the
   * caller-supplied Map<sessionId, ContentReplacementState> so it
   * persists across rounds in the same session.
   */
  readonly toolResultBudget?: ToolBudgetConfig;
  readonly toolResultBudgetState?: Map<string, ContentReplacementState>;
  /**
   * Phase N wire-up: optional memory consolidation hook passed to
   * `applyPerIterationCompaction`. When set, the per-iteration
   * compaction chain invokes this hook after the autocompact
   * decision layer. Callers typically wire
   * `memory/consolidation.ts:consolidateEpisodicSlice` here to
   * get deterministic in-memory slice consolidation. Off by
   * default — the feature is explicitly opt-in.
   */
  readonly consolidationHook?: (
    messages: readonly import("./types.js").LLMMessage[],
  ) => {
    readonly action: "noop" | "consolidated";
    readonly summaryMessage?: import("./types.js").LLMMessage;
  };
  readonly runtimeContractFlags: import("../runtime-contract/types.js").RuntimeContractFlags;
  readonly stopHookRuntime?: import("./hooks/stop-hooks.js").StopHookRuntime;
}

// ============================================================================
// executeToolCallLoop (standalone)
// ============================================================================

/**
 * Run the snip → microcompact → autocompact chain on the current
 * conversation history before handing it to the provider. Mutates
 * `ctx.messages` in place if any layer prunes, updates
 * `ctx.perIterationCompaction`, and emits a trace event per layer
 * that fired. Safe to call before every provider call — layers noop
 * when their conditions are not met.
 *
 * This is the live wire-up referenced by Phase A of the 16-phase
 * refactor in TODO.MD. Prior to this wiring, the compact skeleton at
 * `runtime/src/llm/compact/*.ts` was a disconnected port — the
 * functions existed but nothing in the live loop called them. Every
 * provider call in this file is now preceded by this helper, so the
 * chain actually runs.
 */
export async function executeToolCallLoop(
  ctx: ExecutionContext,
  config: ToolLoopConfig,
  callbacks: ToolLoopCallbacks,
): Promise<ToolLoopTerminalResult> {
  // Phase A wire-up: run the layered compaction chain before the
  // initial provider call. This is the top-of-iteration insertion
  // point for the layered compaction runtime. Phase H added
  // PreCompact / PostCompact hook dispatch inside the helper.
  await runPerIterationCompactionBeforeModelCall(
    ctx,
    config,
    callbacks,
    "initial",
  );
  // Phase I wire-up: wrap the provider call in reactive compaction
  // recovery so a 413 response triggers a retry with trimmed
  // history before bubbling the error.
  ctx.response = await callModelWithReactiveCompact(
    ctx,
    callbacks,
    "initial",
    () => ({
      phase: "initial",
      callMessages: ctx.messages,
      callSections: ctx.messageSections,
      onStreamChunk: ctx.activeStreamCallback,
      structuredOutput: ctx.structuredOutput,
      statefulSessionId: ctx.sessionId,
      statefulResumeAnchor: ctx.stateful?.resumeAnchor,
      statefulHistoryCompacted: ctx.stateful?.historyCompacted,
      preparationDiagnostics: {
        plannerReason: ctx.plannerDecision.reason,
        plannerShouldPlan: ctx.plannerDecision.shouldPlan,
      },
      budgetReason:
        "Initial completion blocked by max model recalls per request budget",
    }),
  );
  failClosedOnMalformedToolContinuation(ctx, callbacks);

  let rounds = 0;
  let effectiveMaxToolRounds = ctx.effectiveMaxToolRounds;
  const loopState: ToolLoopState = {
    remainingToolImageChars: MAX_TOOL_IMAGE_CHARS_BUDGET,
    activeRoutedToolSet: null,
    expandAfterRound: false,
  };
  let consecutiveFailedToolCalls = 0;
  let forcedFailureRecoveryUsed = false;

  // Turn-end completion validation now shares one turn-local
  // continuation controller instead of per-validator attempt maps.
  // Continuations keep going while request/model/tool budgets allow and
  // the last continuation cycle was still productive. Explicit
  // per-validator caps remain supported only as tighter ceilings.
  let shouldContinueAfterStopGate = false;
  const emitContinuationEvaluation = (): ReturnType<
    typeof finishTurnContinuation
  > => {
    const summary = finishTurnContinuation({
      state: ctx.continuationState,
      ctx,
    });
    if (!summary) {
      return undefined;
    }
    callbacks.emitExecutionTrace(ctx, {
      type: "continuation_evaluated",
      phase: "tool_followup",
      callIndex: ctx.callIndex,
      payload: {
        reason: summary.reason,
        validatorId: summary.validatorId,
        attempt: summary.attempt,
        outputTokenDelta: summary.outputTokenDelta,
        toolCallsIssued: summary.toolCallsIssued,
        successfulWorkspaceMutation: summary.successfulWorkspaceMutation,
        diagnosticFingerprintChanged: summary.diagnosticFingerprintChanged,
        materiallyIncreasedOutput: summary.materiallyIncreasedOutput,
        productive: summary.productive,
        lowProgressStall: summary.lowProgressStall,
        consecutiveLowProgressStalls:
          ctx.continuationState.consecutiveLowProgressStalls,
      },
    });
    return summary;
  };
  const resolveTurnOutputTokenBudget = (): number | null => {
    return ctx.turnOutputTokenBudget;
  };
  const shouldAllowBudgetContinuation = (): boolean => {
    const structuredOutputActive =
      ctx.structuredOutput?.schema !== undefined &&
      ctx.structuredOutput.enabled !== false;
    if (structuredOutputActive) {
      return false;
    }
    if (ctx.sessionId.startsWith("subagent:")) {
      return false;
    }
    return true;
  };
  const attemptCompletionRecovery = async (params: {
    readonly reason: string;
    readonly blockingMessage?: string;
    readonly evidence?: unknown;
    readonly maxAttempts?: number;
    readonly budgetReason: string;
    readonly exhaustedDetail: string;
    readonly validationCode?: DelegationOutputValidationCode;
    readonly validatorId?: CompletionValidatorId;
    readonly stopHookResult?: import("./hooks/stop-hooks.js").StopHookPhaseResult;
    readonly continuationSummary?: ReturnType<typeof finishTurnContinuation>;
  }): Promise<boolean> => {
    const continuationCap =
      params.maxAttempts !== undefined
        ? Math.max(0, params.maxAttempts)
        : undefined;
    const shouldExhaustForDiminishingReturns =
      shouldStopForDiminishingReturns(ctx.continuationState);
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
      return false;
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
      "tool_followup",
    );
    const shouldRequireRecoveryTool =
      params.validationCode === "missing_file_mutation_evidence" ||
      params.validationCode === "missing_file_artifact_evidence" ||
      (params.stopHookResult !== undefined && ctx.requiredToolEvidence !== undefined);
    const recoveryToolChoice = shouldRequireRecoveryTool
      ? "required"
      : undefined;
    const recoveryResponse = await callModelWithReactiveCompact(
      ctx,
      callbacks,
      "tool_followup",
      () => ({
        phase: "tool_followup",
        callMessages: ctx.messages,
        callSections: ctx.messageSections,
        onStreamChunk: ctx.activeStreamCallback,
        structuredOutput: ctx.structuredOutput,
        statefulSessionId: ctx.sessionId,
        statefulResumeAnchor: ctx.stateful?.resumeAnchor,
        statefulHistoryCompacted: ctx.stateful?.historyCompacted,
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
      return false;
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
      return false;
    }
    ctx.response = recoveryResponse;
    failClosedOnMalformedToolContinuation(ctx, callbacks);
    shouldContinueAfterStopGate = true;
    return true;
  };
  const attemptTokenBudgetContinuation = async (params: {
    readonly continuationSummary?: ReturnType<typeof finishTurnContinuation>;
  }): Promise<boolean> => {
    const decision = checkTurnContinuationBudget({
      state: ctx.continuationState,
      budget: resolveTurnOutputTokenBudget(),
      globalTurnTokens: countTurnCompletionTokens(ctx.callUsage),
      eligible: shouldAllowBudgetContinuation(),
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
      return false;
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
      return false;
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
      "tool_followup",
    );
    const continuationResponse = await callModelWithReactiveCompact(
      ctx,
      callbacks,
      "tool_followup",
      () => ({
        phase: "tool_followup",
        callMessages: ctx.messages,
        callSections: ctx.messageSections,
        onStreamChunk: ctx.activeStreamCallback,
        structuredOutput: ctx.structuredOutput,
        statefulSessionId: ctx.sessionId,
        statefulResumeAnchor: ctx.stateful?.resumeAnchor,
        statefulHistoryCompacted: ctx.stateful?.historyCompacted,
        budgetReason:
          "Max model recalls exceeded during token-budget continuation",
      }),
    );
    if (!continuationResponse) {
      ctx.continuationState.active = undefined;
      return false;
    }
    ctx.response = continuationResponse;
    failClosedOnMalformedToolContinuation(ctx, callbacks);
    shouldContinueAfterStopGate = true;
    return true;
  };
  do {
    shouldContinueAfterStopGate = false;
  while (
    ctx.response &&
    responseHasToolCalls(ctx.response)
  ) {
    if (ctx.signal?.aborted) {
      materializeResponseToolCalls(ctx, callbacks);
      sealPendingToolProtocol(ctx, callbacks, "request_cancelled");
      callbacks.setStopReason(ctx, "cancelled", "Execution cancelled by caller");
      break;
    }
    if (callbacks.checkRequestTimeout(ctx, "tool loop")) {
      materializeResponseToolCalls(ctx, callbacks);
      sealPendingToolProtocol(ctx, callbacks, "request_timeout");
      break;
    }
    if (isRuntimeLimitReached(rounds, effectiveMaxToolRounds)) {
      materializeResponseToolCalls(ctx, callbacks);
      sealPendingToolProtocol(ctx, callbacks, "max_tool_rounds");
      callbacks.setStopReason(
        ctx,
        "tool_calls",
        `Reached max tool rounds (${effectiveMaxToolRounds})`,
      );
      break;
    }

    rounds++;
    const roundToolCallStart = ctx.allToolCalls.length;
    const roundRoutedToolNames =
      ctx.transientRoutedToolNames ?? ctx.activeRoutedToolNames;
    loopState.activeRoutedToolSet = buildActiveRoutedToolSet(
      roundRoutedToolNames,
    );
    ctx.transientRoutedToolNames = undefined;
    loopState.expandAfterRound = false;
    const roundToolCalls = materializeResponseToolCalls(ctx, callbacks);
    if (!ctx.activeToolHandler) {
      sealPendingToolProtocol(ctx, callbacks, "missing_tool_handler");
      callbacks.setStopReason(
        ctx,
        "tool_error",
        "Model requested tools but no tool handler is available for this turn.",
      );
      break;
    }

    // Phase B (U2): partition this round's tool calls into
    // concurrency-safe batches. A run of consecutive read-only tool
    // calls becomes one parallel batch dispatched via Promise.all;
    // every other call runs serially as its own batch of length 1.
    // When the caller does not supply `isConcurrencySafe`, every
    // call falls into its own serial batch (identical to the old
    // for-loop).
    const dispatchBatches = partitionToolCalls(
      roundToolCalls,
      config.isConcurrencySafe ?? (() => false),
    );
    const parallelBatchCount = dispatchBatches.filter(
      (batch) => batch.isConcurrencySafe && batch.toolCalls.length > 1,
    ).length;
    if (config.isConcurrencySafe) {
      callbacks.emitExecutionTrace(ctx, {
        type: "tool_dispatch_started",
        phase: "tool_followup",
        callIndex: ctx.callIndex,
        payload: {
          tool: "__round_partition__",
          args: {},
          argumentDiagnostics: {
            batchCount: dispatchBatches.length,
            parallelBatchCount,
            concurrencySafeToolNames: dispatchBatches
              .filter((batch) => batch.isConcurrencySafe)
              .flatMap((batch) => batch.toolCalls.map((call) => call.name)),
          },
        },
      });
    }

    let abortRound = false;
    let breakRound = false;
    for (const batch of dispatchBatches) {
      if (batch.toolCalls.length === 0) continue;
      if (batch.isConcurrencySafe && batch.toolCalls.length > 1) {
        // Phase B wire-up: concurrency-safe batches dispatch via
        // Promise.all. The concurrency guarantee is: JS is
        // single-threaded, so per-call mutations on ctx (messages,
        // allToolCalls, etc.) are atomic between await points. The
        // tool_result protocol does NOT require results to appear in
        // the same order as the originating tool_calls — each
        // tool_result carries its own tool_call_id that the provider
        // matches against the prior assistant message. Completion
        // order is therefore acceptable.
        //
        // Image-char budget mutations (loopState.remainingToolImageChars)
        // can be race-prone across interleaved parallel calls, but
        // tools in the concurrency-safe allowlist are read-only
        // (system.readFile, system.listDir, agenc.* queries) and do
        // not return images, so the budget drift is bounded to zero
        // for this code path in practice.
        const results = await Promise.all(
          batch.toolCalls.map((call) =>
            executeSingleToolCall(ctx, call, loopState, config, callbacks),
          ),
        );
        for (const action of results) {
          if (action === "end_round") {
            breakRound = true;
          }
          if (action === "abort_loop" || action === "abort_round") {
            abortRound = true;
          }
        }
      } else {
        for (const toolCall of batch.toolCalls) {
          const action = await executeSingleToolCall(
            ctx,
            toolCall,
            loopState,
            config,
            callbacks,
          );
          if (action === "end_round") {
            breakRound = true;
            break;
          }
          if (action === "abort_loop" || action === "abort_round") {
            abortRound = true;
            break;
          }
        }
      }
      if (abortRound || breakRound) break;
    }

    if (ctx.signal?.aborted) {
      sealPendingToolProtocol(ctx, callbacks, "request_cancelled");
      callbacks.setStopReason(ctx, "cancelled", "Execution cancelled by caller");
      break;
    }
    if (callbacks.checkRequestTimeout(ctx, "tool follow-up")) {
      sealPendingToolProtocol(ctx, callbacks, "request_timeout");
      break;
    }

    const roundCalls = ctx.allToolCalls.slice(roundToolCallStart);
    if (abortRound) {
      sealPendingToolProtocol(ctx, callbacks, "round_aborted");
      break;
    }
    consecutiveFailedToolCalls = updateFailedToolStreak(
      consecutiveFailedToolCalls,
      roundCalls,
    );
    const recentConsecutiveFailedToolCalls = collectRecentConsecutiveFailedToolCalls(
      ctx.allToolCalls,
    );
    const failedToolRecoveryHint = buildFailedToolRecoveryHint(
      recentConsecutiveFailedToolCalls,
    );
    const shouldForceFailureRecovery =
      ctx.effectiveFailureBudget > 0 &&
      !forcedFailureRecoveryUsed &&
      consecutiveFailedToolCalls >= FAILED_TOOL_RECOVERY_STREAK;

    // Recovery hints.
    const recoveryHistoryWindow = ctx.allToolCalls.slice(
      Math.max(0, ctx.allToolCalls.length - 48),
    );
    const recoveryHints = mergeRecoveryHints(
      buildRecoveryHints(
        roundCalls,
        new Set<string>(),
        recoveryHistoryWindow,
      ),
      shouldForceFailureRecovery ? failedToolRecoveryHint : undefined,
    );
    callbacks.replaceRuntimeRecoveryHintMessages(ctx, recoveryHints);
    if (recoveryHints.length > 0) {
      callbacks.emitExecutionTrace(ctx, {
        type: "recovery_hints_injected",
        phase: "tool_followup",
        callIndex: ctx.callIndex + 1,
        payload: {
          count: recoveryHints.length,
          hints: recoveryHints.map((hint) => ({
            key: hint.key,
            message: hint.message,
          })),
        },
      });
    }
    const runtimeHintCount = ctx.messageSections.filter(
      (s) => s === "system_runtime",
    ).length;
    for (const msg of buildToolLoopRecoveryMessages(
      recoveryHints,
      config.maxRuntimeSystemHints,
      runtimeHintCount,
    )) {
      callbacks.pushMessage(ctx, msg, "system_runtime");
    }
    // Routing expansion on miss.
    if (loopState.expandAfterRound && ctx.expandedRoutedToolNames.length > 0) {
      const previousRoutedToolNames = [...ctx.activeRoutedToolNames];
      ctx.routedToolsExpanded = true;
      applyActiveRoutedToolNames(ctx, ctx.expandedRoutedToolNames);
      callbacks.emitExecutionTrace(ctx, {
        type: "route_expanded",
        phase: "tool_followup",
        callIndex: ctx.callIndex + 1,
        payload: {
          previousRoutedToolNames,
          nextRoutedToolNames: ctx.activeRoutedToolNames,
          routedToolMisses: ctx.routedToolMisses,
        },
      });
      const updatedHintCount = ctx.messageSections.filter(
        (s) => s === "system_runtime",
      ).length;
      const expansionMsg = buildRoutingExpansionMessage(
        config.maxRuntimeSystemHints,
        updatedHintCount,
      );
      if (expansionMsg) {
        callbacks.pushMessage(ctx, expansionMsg, "system_runtime");
      }
    }

    // Phase A wire-up: run the layered compaction chain before the
    // follow-up provider call. Phase I wire-up: wrap the call in
    // reactive compaction recovery so a 413 triggers a retry with
    // trimmed history. Phase H added PreCompact / PostCompact hook
    // dispatch inside the helper.
    await runPerIterationCompactionBeforeModelCall(
      ctx,
      config,
      callbacks,
      "tool_followup",
    );
    // Re-call LLM.
    const nextResponse = await callModelWithReactiveCompact(
      ctx,
      callbacks,
      "tool_followup",
      () => ({
        phase: "tool_followup",
        callMessages: ctx.messages,
        callSections: ctx.messageSections,
        onStreamChunk: ctx.activeStreamCallback,
        structuredOutput: ctx.structuredOutput,
        statefulSessionId: ctx.sessionId,
        statefulResumeAnchor: ctx.stateful?.resumeAnchor,
        statefulHistoryCompacted: ctx.stateful?.historyCompacted,
        ...(shouldForceFailureRecovery ? { toolChoice: "none" as const } : {}),
        budgetReason:
          "Max model recalls exceeded while following up after tool calls",
      }),
    );
    if (!nextResponse) break;
    if (shouldForceFailureRecovery) {
      forcedFailureRecoveryUsed = true;
      if (
        responseHasToolCalls(nextResponse) &&
        !responseRepeatsFailedToolPattern({
          response: nextResponse,
          failedCalls: recentConsecutiveFailedToolCalls,
        })
      ) {
        emitToolProtocolViolation(
          ctx,
          callbacks,
          "tool_choice_none_ignored_after_failed_tool_recovery",
          {
            toolNames: nextResponse.toolCalls.map((toolCall) => toolCall.name),
            finishReason: nextResponse.finishReason,
          },
        );
        callbacks.setStopReason(
          ctx,
          "validation_error",
          "Provider emitted tool calls after the runtime requested a no-tool recovery turn.",
        );
        ctx.response = { ...nextResponse, content: "" };
        break;
      }
    }
    ctx.response = nextResponse;
    failClosedOnMalformedToolContinuation(ctx, callbacks);
  }

  // Turn-end stop gate evaluation. Runs only when the inner tool loop
  // exited cleanly (model stopped requesting tools, no abort, no
  // budget/timeout failure). Fires at most once per turn.
  if (
    !ctx.signal?.aborted &&
    ctx.response &&
    !responseHasToolCalls(ctx.response) &&
    !hasPendingToolProtocol(ctx.toolProtocolState) &&
    ctx.stopReason === "completed"
  ) {
    const continuationSummary = ctx.continuationState.active
      ? emitContinuationEvaluation()
      : undefined;
    const stopHookValidators = [
      {
        hookId: BUILTIN_TURN_END_STOP_GATE_ID,
        validatorId: "turn_end_stop_gate" as CompletionValidatorId,
      },
      {
        hookId: BUILTIN_ARTIFACT_EVIDENCE_HOOK_ID,
        validatorId: "artifact_evidence" as CompletionValidatorId,
      },
    ] as const;

    callbacks.emitExecutionTrace(ctx, {
      type: "completion_validation_started",
      phase: "tool_followup",
      callIndex: ctx.callIndex,
      payload: {
        validatorOrder: stopHookValidators.map((entry) => entry.validatorId),
        runtimeContract: ctx.runtimeContractSnapshot,
      },
    });

    let completionValidationStatus = "passed";
    const stopHooksEnabled =
      config.runtimeContractFlags.stopHooksEnabled &&
      config.stopHookRuntime !== undefined;

    for (const entry of stopHookValidators) {
      callbacks.emitExecutionTrace(ctx, {
        type: "completion_validator_started",
        phase: "tool_followup",
        callIndex: ctx.callIndex,
        payload: {
          validatorId: entry.validatorId,
          enabled: stopHooksEnabled,
          runtimeContract: ctx.runtimeContractSnapshot,
        },
      });
    }
    if (!stopHooksEnabled) {
      for (const entry of stopHookValidators) {
        ctx.runtimeContractSnapshot = updateRuntimeContractValidatorSnapshot({
          snapshot: ctx.runtimeContractSnapshot,
          id: entry.validatorId,
          enabled: false,
          executed: false,
          outcome: "skipped",
        });
        callbacks.emitExecutionTrace(ctx, {
          type: "completion_validator_finished",
          phase: "tool_followup",
          callIndex: ctx.callIndex,
          payload: {
            validatorId: entry.validatorId,
            enabled: false,
            outcome: "skipped",
            runtimeContract: ctx.runtimeContractSnapshot,
          },
        });
      }
    } else {
      const hookResult = await runStopHookPhase({
        runtime: config.stopHookRuntime,
        phase: "Stop",
        matchKey: ctx.sessionId,
        context: {
          phase: "Stop",
          sessionId: ctx.sessionId,
          runtimeWorkspaceRoot: ctx.runtimeWorkspaceRoot,
          finalContent: ctx.response?.content ?? "",
          allToolCalls: ctx.allToolCalls,
          turnEndSnapshot: buildTurnEndStopGateSnapshot(ctx.allToolCalls),
          runtimeChecks: {
            requiredToolEvidence: ctx.requiredToolEvidence,
            targetArtifacts: ctx.turnExecutionContract.targetArtifacts,
            activeToolHandler: ctx.activeToolHandler,
            appendProbeRuns: (runs) => {
              for (const run of runs) {
                callbacks.appendToolRecord(ctx, run);
              }
            },
          },
        },
      });
      callbacks.emitExecutionTrace(ctx, {
        type: "stop_hook_execution_finished",
        phase: "tool_followup",
        callIndex: ctx.callIndex,
        payload: {
          validatorId: "turn_end_stop_gate",
          stopHookPhase: hookResult.phase,
          outcome: hookResult.outcome,
          reason: hookResult.reason,
          stopReason: hookResult.stopReason,
          hookIds: hookResult.hookOutcomes.map((outcome) => outcome.hookId),
          progressMessages: hookResult.progressMessages,
          evidence: hookResult.evidence,
        },
      });

      const hookOutcomes = new Map(
        hookResult.hookOutcomes.map((outcome) => [outcome.hookId, outcome]),
      );
      for (const entry of stopHookValidators) {
        const outcome = hookOutcomes.get(entry.hookId);
        const snapshotOutcome =
          !outcome
            ? "skipped"
            : outcome.preventContinuation
              ? "fail_closed"
              : outcome.blockingError
                ? "retry_with_blocking_message"
                : "pass";
        const reason =
          outcome?.stopReason ??
          outcome?.blockingError?.hookId ??
          outcome?.hookId;
        ctx.runtimeContractSnapshot = updateRuntimeContractValidatorSnapshot({
          snapshot: ctx.runtimeContractSnapshot,
          id: entry.validatorId,
          enabled: true,
          executed: outcome !== undefined,
          outcome: snapshotOutcome,
          reason,
        });
        callbacks.emitExecutionTrace(ctx, {
          type: "completion_validator_finished",
          phase: "tool_followup",
          callIndex: ctx.callIndex,
          payload: {
            validatorId: entry.validatorId,
            enabled: true,
            outcome: snapshotOutcome,
            reason,
            runtimeContract: ctx.runtimeContractSnapshot,
          },
        });
      }

      if (hookResult.outcome !== "pass") {
        callbacks.emitExecutionTrace(ctx, {
          type: "stop_hook_blocked",
          phase: "tool_followup",
          callIndex: ctx.callIndex,
          payload: {
            validatorId: "turn_end_stop_gate",
            stopHookPhase: hookResult.phase,
            outcome: hookResult.outcome,
            reason: hookResult.reason,
            stopReason: hookResult.stopReason,
          },
        });
      }

      if (hookResult.outcome === "prevent_continuation") {
        completionValidationStatus = "fail_closed";
        callbacks.setStopReason(
          ctx,
          "validation_error",
          hookResult.stopReason ?? "Stop-hook chain prevented completion.",
        );
        ctx.validationCode = asDelegationOutputValidationCode(
          hookResult.stopReason ?? hookResult.reason,
        );
        if (ctx.response) {
          ctx.response = {
            ...ctx.response,
            content: "",
          };
        }
      } else if (hookResult.outcome === "retry_with_blocking_message") {
        const hookValidationCode = asDelegationOutputValidationCode(
          hookResult.stopReason ?? hookResult.reason,
        );
        const stopHookRecovery = await attemptCompletionRecovery({
          reason: hookResult.reason ?? "turn_end_stop_gate",
          blockingMessage: hookResult.blockingMessage,
          evidence: hookResult.evidence,
          maxAttempts:
            config.stopHookRuntime?.maxAttemptsExplicit === true
              ? config.stopHookRuntime.maxAttempts
              : ctx.requiredToolEvidence?.maxCorrectionAttemptsExplicit === true
                ? ctx.requiredToolEvidence.maxCorrectionAttempts
                : undefined,
          budgetReason:
            hookValidationCode === "missing_file_mutation_evidence" ||
            hookValidationCode === "missing_file_artifact_evidence"
              ? "Max model recalls exceeded during artifact-evidence recovery turn"
              : "Max model recalls exceeded during stop-hook recovery turn",
          exhaustedDetail:
            hookResult.reason === "narrated_future_tool_work"
              ? "Stop-gate recovery exhausted: the model kept narrating future work instead of calling tools."
              : (hookValidationCode === "missing_file_mutation_evidence" ||
                    hookValidationCode === "missing_file_artifact_evidence") &&
                  hookResult.blockingMessage
                ? hookResult.blockingMessage
                : "Stop-gate recovery exhausted after the model continued to emit an invalid completion summary.",
          validationCode: hookValidationCode,
          validatorId: "turn_end_stop_gate",
          stopHookResult: hookResult,
          continuationSummary,
        });
        completionValidationStatus = stopHookRecovery
          ? "recovery_requested"
          : "recovery_exhausted";
        callbacks.emitExecutionTrace(ctx, {
          type: "completion_validation_finished",
          phase: "tool_followup",
          callIndex: ctx.callIndex,
          payload: {
            status: completionValidationStatus,
            stopReason: ctx.stopReason,
            validationCode: ctx.validationCode,
            runtimeContract: ctx.runtimeContractSnapshot,
          },
        });
        if (stopHookRecovery) {
          continue;
        }
      }
    }

    callbacks.emitExecutionTrace(ctx, {
      type: "completion_validation_finished",
      phase: "tool_followup",
      callIndex: ctx.callIndex,
      payload: {
        status: completionValidationStatus,
        stopReason: ctx.stopReason,
        validationCode: ctx.validationCode,
        runtimeContract: ctx.runtimeContractSnapshot,
      },
    });
    if (shouldContinueAfterStopGate) {
      continue;
    }
    const requestedBudgetContinuation = await attemptTokenBudgetContinuation({
      continuationSummary,
    });
    if (requestedBudgetContinuation) {
      continue;
    }
  }
  } while (shouldContinueAfterStopGate);

  if (hasPendingToolProtocol(ctx.toolProtocolState)) {
    emitToolProtocolViolation(
      ctx,
      callbacks,
      "finalization_with_unresolved_tool_calls",
      {
        pendingToolCallIds: getPendingToolProtocolCalls(ctx.toolProtocolState).map(
          (toolCall) => toolCall.id,
        ),
      },
    );
    sealPendingToolProtocol(ctx, callbacks, "finalization_guard");
    callbacks.setStopReason(
      ctx,
      "validation_error",
      "Runtime detected unresolved tool calls at finalization and closed the turn instead of surfacing a clean completion.",
    );
    if (ctx.response) {
      ctx.response = {
        ...ctx.response,
        content: "",
      };
    }
  }

  if (ctx.signal?.aborted) {
    callbacks.setStopReason(ctx, "cancelled", "Execution cancelled by caller");
  }

  ctx.finalContent = ctx.response?.content ?? "";
  const missingFinalToolFollowupAnswer =
    !ctx.finalContent &&
    ctx.allToolCalls.length > 0 &&
    ctx.stopReason === "completed";
  if (missingFinalToolFollowupAnswer) {
    callbacks.setStopReason(
      ctx,
      "no_progress",
      "Model returned empty content after tool follow-up; refusing to surface raw tool output as the final answer.",
    );
  }
  const shouldSummarizeToolFallback =
    !missingFinalToolFollowupAnswer &&
    !ctx.finalContent &&
    ctx.allToolCalls.length > 0 &&
    ctx.stopReason === "tool_calls" &&
    ctx.toolProtocolState.repairCount === 0;
  if (shouldSummarizeToolFallback) {
    ctx.finalContent =
      generateFallbackContent(ctx.allToolCalls) ?? ctx.finalContent;
  }
  if (!ctx.finalContent && ctx.stopReason !== "completed" && ctx.stopReasonDetail) {
    ctx.finalContent = ctx.stopReasonDetail;
  }

  return buildToolLoopTerminalResult(ctx);
}

// ============================================================================
// Callback wiring — Phase F PR-5 extraction
// ============================================================================

/**
 * Dependencies for `buildToolLoopCallbacks` that aren't already pure
 * ctx helpers. Only two values need to come from the owning
 * `ChatExecutor` instance: the per-request max runtime system hint
 * cap (a construction-time config) and the `callModelForPhase`
 * orchestration entrypoint (still class state until PR-7 extracts E5).
 */
export interface ToolLoopCallbacksDependencies {
  readonly maxRuntimeSystemHints: number;
  readonly callModelForPhase: ToolLoopCallbacks["callModelForPhase"];
}

/**
 * Build the callback struct consumed by `executeToolCallLoop`. All
 * callback entries route to pure free helpers in
 * `chat-executor-ctx-helpers.ts` except `callModelForPhase`, which is
 * passed through from the caller so the tool loop does not need any
 * import on `chat-executor.ts`.
 *
 * Phase F extraction (PR-5). Previously
 * `ChatExecutor.buildToolLoopCallbacks`.
 */
export function buildToolLoopCallbacks(
  deps: ToolLoopCallbacksDependencies,
): ToolLoopCallbacks {
  const { maxRuntimeSystemHints, callModelForPhase } = deps;
  return {
    pushMessage,
    setStopReason,
    checkRequestTimeout,
    appendToolRecord,
    emitExecutionTrace,
    replaceRuntimeRecoveryHintMessages,
    maybePushRuntimeInstruction: (ctx, content) =>
      maybePushRuntimeInstruction(ctx, content, maxRuntimeSystemHints),
    maybePushKeyedRuntimeInstruction: (ctx, params) =>
      maybePushKeyedRuntimeInstruction(ctx, params, maxRuntimeSystemHints),
    clearRuntimeInstructionKey,
    callModelForPhase,
    serializeRemainingRequestMs,
  };
}

/**
 * Find the index where the "tail" section of a message array begins,
 * defined as the slice after the last user message. Used by in-flight
 * compaction (PR-6 extraction target E1) to preserve the trailing
 * turn unchanged when compacting the conversation history replay.
 *
 * Phase F extraction (PR-5). Previously
 * `ChatExecutor.findInFlightCompactionTailStartIndex`. Extracted here
 * so PR-6's `chat-executor-in-flight-compaction.ts` can import it
 * without depending on `chat-executor.ts`.
 */
export function findInFlightCompactionTailStartIndex(
  messages: readonly import("./types.js").LLMMessage[],
  sections?: readonly PromptBudgetSection[],
): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (
      sections?.[index] === "user" ||
      messages[index]?.role === "user"
    ) {
      return index + 1;
    }
  }
  return messages.length;
}
