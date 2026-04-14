import {
  buildTurnEndStopGateSnapshot,
  checkFilesystemArtifacts,
  evaluateArtifactEvidenceGate,
} from "./chat-executor-stop-gate.js";
import {
  runDeterministicAcceptanceProbes,
  shouldRunDeterministicAcceptanceProbes,
} from "./deterministic-acceptance-probes.js";
import type {
  ChatExecutorConfig,
  ExecutionContext,
  ToolCallRecord,
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
import {
  isExplicitTopLevelVerifierRequiredForTurn,
  runTopLevelVerifierValidation,
} from "../gateway/top-level-verifier.js";

export interface CompletionValidatorExecutionResult
  extends CompletionValidatorResult {
  readonly probeRuns?: readonly ToolCallRecord[];
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
  const topLevelVerifierEnabled = isExplicitTopLevelVerifierRequiredForTurn({
    turnExecutionContract: params.ctx.turnExecutionContract,
  });
  const deterministicAcceptanceProbesEnabled =
    shouldRunDeterministicAcceptanceProbes({
      workspaceRoot: params.ctx.runtimeWorkspaceRoot,
      targetArtifacts: params.ctx.turnExecutionContract.targetArtifacts,
      allToolCalls: params.ctx.allToolCalls,
      activeToolHandler: params.ctx.activeToolHandler,
    });
  let verificationReadyGate:
    | CompletionValidatorExecutionResult
    | undefined;

  const ensureVerificationReadyGate =
    async (): Promise<CompletionValidatorExecutionResult> => {
      if (verificationReadyGate) {
        return verificationReadyGate;
      }
      if (!deterministicAcceptanceProbesEnabled && !topLevelVerifierEnabled) {
        verificationReadyGate = {
          id: "deterministic_acceptance_probes",
          outcome: "pass",
        };
        return verificationReadyGate;
      }
      const hookResult = await runStopHookPhase({
        runtime: params.stopHookRuntime,
        phase: "VerificationReady",
        matchKey: params.ctx.sessionId,
        context: {
          phase: "VerificationReady",
          sessionId: params.ctx.sessionId,
          runtimeWorkspaceRoot: params.ctx.runtimeWorkspaceRoot,
          allToolCalls: params.ctx.allToolCalls,
          verificationReady: {
            deterministicAcceptanceProbesEnabled,
            topLevelVerifierEnabled,
            targetArtifacts: params.ctx.turnExecutionContract.targetArtifacts,
          },
        },
      });
      verificationReadyGate =
        hookResult.outcome === "retry_with_blocking_message"
          ? {
              id: "deterministic_acceptance_probes",
              outcome: "retry_with_blocking_message",
              reason: hookResult.reason ?? "verification_ready",
              blockingMessage: hookResult.blockingMessage,
              evidence: hookResult.evidence,
              maxAttempts: stopHookRetryBudgetCap,
              exhaustedDetail:
                "Verification-ready recovery exhausted after stop-hook intervention.",
              stopHookResult: hookResult,
            }
          : hookResult.outcome === "prevent_continuation"
            ? {
                id: "deterministic_acceptance_probes",
                outcome: "fail_closed",
                reason: hookResult.reason ?? "verification_ready",
                exhaustedDetail:
                  hookResult.stopReason ??
                  "Verification-ready stop hook prevented continuation.",
                stopHookResult: hookResult,
              }
            : {
                id: "deterministic_acceptance_probes",
                outcome: "pass",
                evidence: hookResult.evidence,
                stopHookResult: hookResult,
              };
      return verificationReadyGate;
    };

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
    {
      id: "filesystem_artifact_verification",
      enabled: true,
      async execute(): Promise<CompletionValidatorExecutionResult> {
        const check = await checkFilesystemArtifacts({
          finalContent: params.ctx.response?.content ?? "",
          allToolCalls: params.ctx.allToolCalls,
        });
        if (!check.shouldIntervene) {
          return { id: "filesystem_artifact_verification", outcome: "pass" };
        }
        return {
          id: "filesystem_artifact_verification",
          outcome: "retry_with_blocking_message",
          reason: "filesystem_artifact_verification",
          blockingMessage: check.blockingMessage,
          evidence: {
            emptyFiles: check.emptyFiles,
            missingFiles: check.missingFiles,
            checkedFiles: check.checkedFiles,
          },
          maxAttempts: sharedCorrectionBudgetCap,
          exhaustedDetail:
            "Filesystem artifact verification failed after recovery; missing or empty artifacts remain on disk.",
        };
      },
    },
    {
      id: "deterministic_acceptance_probes",
      enabled: true,
      async execute(): Promise<CompletionValidatorExecutionResult> {
        const gate = await ensureVerificationReadyGate();
        if (gate.outcome !== "pass") {
          return gate;
        }
        const decision = await runDeterministicAcceptanceProbes({
          workspaceRoot: params.ctx.runtimeWorkspaceRoot,
          targetArtifacts: params.ctx.turnExecutionContract.targetArtifacts,
          allToolCalls: params.ctx.allToolCalls,
          activeToolHandler: params.ctx.activeToolHandler,
        });
        if (!decision.shouldIntervene) {
          return {
            id: "deterministic_acceptance_probes",
            outcome: "pass",
            ...(decision.probeRuns.length > 0 ? { probeRuns: decision.probeRuns } : {}),
          };
        }
        if (decision.allowRecovery === false) {
          return {
            id: "deterministic_acceptance_probes",
            outcome: "fail_closed",
            reason:
              decision.validationCode ??
              "deterministic_acceptance_probe_failed",
            exhaustedDetail:
              decision.stopReasonDetail ??
              "Deterministic acceptance-probe recovery exhausted.",
            validationCode: decision.validationCode,
            probeRuns: decision.probeRuns,
          };
        }
        return {
          id: "deterministic_acceptance_probes",
          outcome: "retry_with_blocking_message",
          reason:
            decision.validationCode ??
            "deterministic_acceptance_probe_failed",
          blockingMessage: decision.blockingMessage,
          evidence: decision.evidence,
          maxAttempts: sharedCorrectionBudgetCap,
          exhaustedDetail:
            decision.stopReasonDetail ??
            "Deterministic acceptance-probe recovery exhausted.",
          validationCode: decision.validationCode,
          probeRuns: decision.probeRuns,
        };
      },
    },
    {
      id: "top_level_verifier",
      enabled: topLevelVerifierEnabled,
      async execute(): Promise<CompletionValidatorExecutionResult> {
        if (!topLevelVerifierEnabled) {
          return { id: "top_level_verifier", outcome: "skipped" };
        }
        const gate = await ensureVerificationReadyGate();
        if (gate.outcome !== "pass") {
          return {
            ...gate,
            id: "top_level_verifier",
          };
        }
        const validation = await runTopLevelVerifierValidation({
          sessionId: params.ctx.sessionId,
          userRequest: params.ctx.messageText,
          result: {
            content: params.ctx.response?.content ?? "",
            stopReason: params.ctx.stopReason,
            completionState: params.ctx.completionState,
            turnExecutionContract: params.ctx.turnExecutionContract,
            toolCalls: params.ctx.allToolCalls,
            stopReasonDetail: params.ctx.stopReasonDetail,
            validationCode: params.ctx.validationCode,
            completionProgress: undefined,
            runtimeContractSnapshot: params.ctx.runtimeContractSnapshot,
          },
          subAgentManager:
            params.completionValidation?.topLevelVerifier?.subAgentManager ??
            null,
          verifierService:
            params.completionValidation?.topLevelVerifier?.verifierService ??
            null,
          taskStore:
            params.completionValidation?.topLevelVerifier?.taskStore ?? null,
          remoteJobManager:
            params.completionValidation?.topLevelVerifier?.remoteJobManager ?? null,
          agentDefinitions:
            params.completionValidation?.topLevelVerifier?.agentDefinitions,
          logger: params.completionValidation?.topLevelVerifier?.logger,
          onTraceEvent:
            params.completionValidation?.topLevelVerifier?.onTraceEvent,
        });
        return {
          id: "top_level_verifier",
          outcome: validation.outcome,
          reason: "top_level_verifier",
          blockingMessage: validation.blockingMessage,
          maxAttempts: sharedCorrectionBudgetCap,
          exhaustedDetail: validation.exhaustedDetail,
          verifier: validation.runtimeVerifier,
          verifierTaskId: validation.taskId,
          verifierRequirement: validation.verifierRequirement,
          verifierLauncherKind: validation.launcherKind,
        };
      },
    },
  ];
}
