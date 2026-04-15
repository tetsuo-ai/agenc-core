import {
  buildTurnEndStopGateSnapshot,
  evaluateArtifactEvidenceGate,
} from "./chat-executor-stop-gate.js";
import type {
  ChatExecutorConfig,
  ExecutionContext,
} from "./chat-executor-types.js";
import {
  runStopHookPhase,
  type StopHookPhaseResult,
  type StopHookRuntime,
} from "./hooks/stop-hooks.js";
import type {
  CompletionValidatorResult,
  CompletionValidatorId,
  RuntimeContractFlags,
} from "../runtime-contract/types.js";

export interface CompletionValidatorExecutionResult
  extends CompletionValidatorResult {
  readonly stopHookResult?: StopHookPhaseResult;
}

export interface CompletionValidator {
  readonly id: CompletionValidatorId;
  readonly enabled: boolean;
  execute(): Promise<CompletionValidatorExecutionResult>;
}

export function buildCompletionValidators(params: {
  readonly ctx: ExecutionContext;
  readonly runtimeContractFlags: RuntimeContractFlags;
  readonly stopHookRuntime?: StopHookRuntime;
  readonly completionValidation?: ChatExecutorConfig["completionValidation"];
}): readonly CompletionValidator[] {
  const sharedCorrectionBudgetCap =
    params.ctx.requiredToolEvidence?.maxCorrectionAttemptsExplicit === true
      ? params.ctx.requiredToolEvidence.maxCorrectionAttempts
      : undefined;
  const stopHookRetryBudgetCap =
    params.stopHookRuntime?.maxAttemptsExplicit === true
      ? Math.max(
          sharedCorrectionBudgetCap ?? 0,
          params.stopHookRuntime.maxAttempts,
        )
      : sharedCorrectionBudgetCap;

  return [
    {
      id: "artifact_evidence",
      enabled: true,
      async execute(): Promise<CompletionValidatorExecutionResult> {
        const decision = evaluateArtifactEvidenceGate({
          requiredToolEvidence: params.ctx.requiredToolEvidence,
          runtimeContext: {
            workspaceRoot: params.ctx.runtimeWorkspaceRoot,
          },
          allToolCalls: params.ctx.allToolCalls,
        });
        if (!decision.shouldIntervene) {
          return { id: "artifact_evidence", outcome: "pass" };
        }
        return {
          id: "artifact_evidence",
          outcome: "retry_with_blocking_message",
          reason: decision.validationCode ?? "artifact_evidence_gate",
          blockingMessage: decision.blockingMessage,
          evidence: decision.evidence,
          maxAttempts: sharedCorrectionBudgetCap,
          exhaustedDetail:
            decision.stopReasonDetail ??
            "Artifact-evidence recovery exhausted.",
          validationCode: decision.validationCode,
        };
      },
    },
    {
      id: "turn_end_stop_gate",
      enabled: true,
      async execute(): Promise<CompletionValidatorExecutionResult> {
        if (params.runtimeContractFlags.stopHooksEnabled && params.stopHookRuntime) {
          const turnEndSnapshot = buildTurnEndStopGateSnapshot(
            params.ctx.allToolCalls,
          );
          const hookResult = await runStopHookPhase({
            runtime: params.stopHookRuntime,
            phase: "Stop",
            matchKey: params.ctx.sessionId,
            context: {
              phase: "Stop",
              sessionId: params.ctx.sessionId,
              runtimeWorkspaceRoot: params.ctx.runtimeWorkspaceRoot,
              finalContent: params.ctx.response?.content ?? "",
              allToolCalls: params.ctx.allToolCalls,
              turnEndSnapshot,
            },
          });
          if (hookResult.outcome === "pass") {
            return {
              id: "turn_end_stop_gate",
              outcome: "pass",
              evidence: hookResult.evidence,
              stopHookResult: hookResult,
            };
          }
          if (hookResult.outcome === "prevent_continuation") {
            return {
              id: "turn_end_stop_gate",
              outcome: "fail_closed",
              reason: hookResult.reason ?? "turn_end_stop_gate",
              exhaustedDetail:
                hookResult.stopReason ??
                "Stop-hook chain prevented completion.",
              stopHookResult: hookResult,
            };
          }
          return {
            id: "turn_end_stop_gate",
            outcome: "retry_with_blocking_message",
            reason: hookResult.reason ?? "turn_end_stop_gate",
            blockingMessage: hookResult.blockingMessage,
            evidence: hookResult.evidence,
            maxAttempts: stopHookRetryBudgetCap,
            exhaustedDetail:
              hookResult.reason === "narrated_future_tool_work"
                ? "Stop-gate recovery exhausted: the model kept narrating future work instead of calling tools."
                : "Stop-gate recovery exhausted after the model continued to emit an invalid completion summary.",
            stopHookResult: hookResult,
          };
        }
        return { id: "turn_end_stop_gate", outcome: "pass" };
      },
    },
    {
      id: "request_task_progress",
      enabled: true,
      async execute(): Promise<CompletionValidatorExecutionResult> {
        const requestTaskState = params.ctx.requestTaskState;
        const hasMalformedTaskMetadata =
          requestTaskState.malformedTasks.length > 0;
        if (!hasMalformedTaskMetadata) {
          return { id: "request_task_progress", outcome: "pass" };
        }

        const maxAttempts = sharedCorrectionBudgetCap;
        const allowedIds = requestTaskState.allowedMilestones.map(
          (milestone) => milestone.id,
        );
        const malformedDetails = requestTaskState.malformedTasks
          .map((task) => `#${task.taskId}: ${task.errors.join("; ")}`)
          .join("\n");
        return {
          id: "request_task_progress",
          outcome: "retry_with_blocking_message",
          reason: "request_task_progress",
          blockingMessage:
            "Task runtime metadata is malformed and must be corrected before finalization.\n" +
            `${malformedDetails}\n` +
            (allowedIds.length > 0
              ? `Allowed request milestone ids: ${allowedIds.join(", ")}`
              : "Remove or correct malformed `metadata._runtime` fields before continuing."),
          evidence: {
            malformedTasks: requestTaskState.malformedTasks,
            allowedMilestoneIds: allowedIds,
          },
          maxAttempts,
          exhaustedDetail:
            "Request task progress recovery exhausted while malformed task metadata remained in the session task state.",
        };
      },
    },
  ];
}
