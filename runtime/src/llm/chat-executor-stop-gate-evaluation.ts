/**
 * Turn-end stop-gate evaluation extracted from chat-executor-tool-loop.
 *
 * Runs the Stop-phase hook chain after the model stops requesting
 * tools and dispatches the outcome:
 *
 *   - `pass`                       → try a token-budget continuation
 *   - `prevent_continuation`       → set stop reason + clear content
 *   - `retry_with_blocking_message`→ delegate to the completion
 *                                    recovery helper (re-enters the
 *                                    loop on a successful nudge)
 *
 * Also fires the completion-validator trace envelope
 * (`completion_validation_started` / `completion_validator_started`
 * / `completion_validator_finished` / `completion_validation_finished`)
 * so observability clients still get the same event stream as before
 * the extraction.
 *
 * @module
 */

import type { ExecutionContext } from "./chat-executor-types.js";
import type { ToolLoopCallbacks, ToolLoopConfig } from "./chat-executor-tool-loop.js";
import type { CompletionValidatorId } from "../runtime-contract/types.js";
import {
  DELEGATION_OUTPUT_VALIDATION_CODES,
  type DelegationOutputValidationCode,
} from "../utils/delegation-validation.js";
import { finishTurnContinuation } from "./chat-executor-continuation.js";
import { updateRuntimeContractValidatorSnapshot } from "../runtime-contract/types.js";
import { buildTurnEndStopGateSnapshot } from "./chat-executor-stop-gate.js";
import {
  BUILTIN_ARTIFACT_EVIDENCE_HOOK_ID,
  BUILTIN_TURN_END_STOP_GATE_ID,
  runStopHookPhase,
} from "./hooks/stop-hooks.js";
import { hasPendingToolProtocol, responseHasToolCalls } from "./tool-protocol-state.js";
import {
  attemptCompletionRecovery,
  attemptTokenBudgetContinuation,
} from "./chat-executor-completion-recovery.js";

function asDelegationOutputValidationCode(
  value: unknown,
): DelegationOutputValidationCode | undefined {
  return typeof value === "string" &&
    (DELEGATION_OUTPUT_VALIDATION_CODES as readonly string[]).includes(value)
    ? (value as DelegationOutputValidationCode)
    : undefined;
}

export interface StopGateEvaluationResult {
  /** True when the caller should `continue` the outer turn loop. */
  readonly shouldContinueLoop: boolean;
}

export interface StopGateEvaluationParams {
  readonly ctx: ExecutionContext;
  readonly config: ToolLoopConfig;
  readonly callbacks: ToolLoopCallbacks;
  readonly emitContinuationEvaluation: () => ReturnType<
    typeof finishTurnContinuation
  >;
}

/**
 * Fires at most once per turn. Runs only when the tool loop exited
 * cleanly (model stopped requesting tools, no abort, no pending tool
 * protocol state, stopReason === "completed"). Otherwise returns
 * `{ shouldContinueLoop: false }` without any side effects.
 */
export async function evaluateTurnEndStopGate(
  params: StopGateEvaluationParams,
): Promise<StopGateEvaluationResult> {
  const { ctx, config, callbacks, emitContinuationEvaluation } = params;
  if (
    ctx.signal?.aborted ||
    !ctx.response ||
    responseHasToolCalls(ctx.response) ||
    hasPendingToolProtocol(ctx.toolProtocolState) ||
    ctx.stopReason !== "completed"
  ) {
    return { shouldContinueLoop: false };
  }
  // Plan-mode is read-only and the user explicitly asked for a plan as
  // text (e.g. `/plan come up with a plan for M1`). The
  // `narrated_future_tool_work` and `truncated_success_claim` detectors
  // that the stop-gate fires are designed for execution flows where the
  // assistant should be calling mutation tools instead of describing
  // them. Forcing plan-mode answers through that gate causes the
  // detector to reject the plan as a "checkpoint" and pump the model
  // into endless `tool_choice: required` recovery rounds reading the
  // same files over and over. Skip the gate entirely when the active
  // workflow stage is `plan`.
  if (ctx.runtimeWorkflowStage === "plan") {
    return { shouldContinueLoop: false };
  }

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
  let shouldContinueLoop = false;
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
        userMessageText: ctx.messageText,
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
      const snapshotOutcome = !outcome
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
        ctx,
        config,
        callbacks,
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
          (hookValidationCode === "missing_file_mutation_evidence" ||
            hookValidationCode === "missing_file_artifact_evidence") &&
          hookResult.blockingMessage
            ? hookResult.blockingMessage
            : "Stop-gate recovery exhausted after the model continued to emit an invalid completion summary.",
        validationCode: hookValidationCode,
        validatorId: "turn_end_stop_gate",
        stopHookResult: hookResult,
        continuationSummary,
      });
      if (stopHookRecovery.recovered) {
        shouldContinueLoop = true;
      }
      completionValidationStatus = stopHookRecovery.recovered
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
      if (stopHookRecovery.recovered) {
        return { shouldContinueLoop: true };
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
  if (shouldContinueLoop) {
    return { shouldContinueLoop: true };
  }
  const tokenBudgetContinuation = await attemptTokenBudgetContinuation({
    ctx,
    config,
    callbacks,
    continuationSummary,
  });
  if (tokenBudgetContinuation.recovered) {
    return { shouldContinueLoop: true };
  }
  return { shouldContinueLoop: false };
}
