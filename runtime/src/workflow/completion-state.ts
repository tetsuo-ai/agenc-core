import { didToolCallFail } from "../llm/chat-executor-tool-utils.js";
import type { DelegationOutputValidationCode } from "../utils/delegation-validation.js";
import type { ImplementationCompletionContract } from "./completion-contract.js";
import { resolveWorkflowRequestCompletionStatus } from "./request-completion.js";
import { deriveVerificationObligations, type WorkflowVerificationContract } from "./verification-obligations.js";

export type WorkflowCompletionState =
  | "completed"
  | "partial"
  | "blocked"
  | "needs_verification";

export interface PlannerVerificationSnapshot {
  readonly performed: boolean;
  readonly overall: "pass" | "retry" | "fail" | "skipped";
}

export interface CompletionStateToolCall {
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly result: string;
  readonly isError: boolean;
}

export function resolvePipelineCompletionState(input: {
  readonly status: "running" | "completed" | "failed" | "halted";
  readonly completedSteps: number;
}): WorkflowCompletionState {
  if (input.status === "completed") {
    return "completed";
  }
  if (input.status === "halted") {
    return "blocked";
  }
  return input.completedSteps > 0 ? "partial" : "blocked";
}

export function resolveWorkflowCompletionState(input: {
  readonly stopReason: string;
  readonly toolCalls: readonly CompletionStateToolCall[];
  readonly verificationContract?: WorkflowVerificationContract;
  readonly completionContract?: ImplementationCompletionContract;
  readonly completedRequestMilestoneIds?: readonly string[];
  readonly validationCode?: DelegationOutputValidationCode;
  readonly verifier?: PlannerVerificationSnapshot;
}): WorkflowCompletionState {
  const verificationContract = mergeVerificationContract(input);
  const obligations = verificationContract
    ? deriveVerificationObligations(verificationContract)
    : undefined;
  const verifier = input.verifier;
  const successfulToolCalls = input.toolCalls.filter(
    (toolCall) => !didToolCallFail(toolCall.isError, toolCall.result),
  );
  const hasProgress = successfulToolCalls.length > 0;
  const requestCompletion = resolveWorkflowRequestCompletionStatus({
    contract: verificationContract?.requestCompletion,
    completedMilestoneIds: input.completedRequestMilestoneIds,
  });
  const requiresExplicitVerification = Boolean(
    obligations &&
      (
        obligations.requiresBuildVerification ||
        obligations.requiresBehaviorVerification ||
        obligations.requiresReviewVerification
      ),
  );
  const requiresVerificationBeforeCompletion =
    requiresExplicitVerification;

  if (input.stopReason === "completed") {
    if ((requestCompletion?.remainingMilestones.length ?? 0) > 0) {
      return hasProgress ? "partial" : "blocked";
    }
    if (
      requiresVerificationBeforeCompletion &&
      (!verifier || verifier.performed !== true || verifier.overall === "skipped")
    ) {
      return "needs_verification";
    }
    if (verifier?.overall === "retry" || verifier?.overall === "fail") {
      return hasProgress || obligations?.partialCompletionAllowed === true
        ? "partial"
        : "blocked";
    }
    return "completed";
  }

  if (input.stopReason === "tool_calls") {
    return "blocked";
  }

  if (
    input.validationCode === "missing_behavior_harness" &&
    (hasProgress || obligations?.requiresBehaviorVerification)
  ) {
    return "needs_verification";
  }

  if (hasProgress || obligations?.partialCompletionAllowed === true) {
    return "partial";
  }
  return "blocked";
}

function mergeVerificationContract(input: {
  readonly verificationContract?: WorkflowVerificationContract;
  readonly completionContract?: ImplementationCompletionContract;
}): WorkflowVerificationContract | undefined {
  if (!input.verificationContract && !input.completionContract) {
    return undefined;
  }
  return {
    ...(input.verificationContract ?? {}),
    ...(input.completionContract
      ? { completionContract: input.completionContract }
      : {}),
  };
}
