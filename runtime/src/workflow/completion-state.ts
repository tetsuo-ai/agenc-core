import { didToolCallFail } from "../llm/chat-executor-tool-utils.js";
import type { DelegationOutputValidationCode } from "../utils/delegation-validation.js";
import { resolveWorkflowRequestCompletionStatus } from "./request-completion.js";
import type { WorkflowVerificationContract } from "./verification-obligations.js";

export type WorkflowCompletionState =
  | "completed"
  | "partial"
  | "blocked"
  | "needs_verification";

export interface PlannerVerificationSnapshot {
  readonly performed: boolean;
  readonly overall: "pass" | "retry" | "fail" | "skipped";
}

interface CompletionStateToolCall {
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
  readonly completedRequestMilestoneIds?: readonly string[];
  readonly validationCode?: DelegationOutputValidationCode;
  readonly verifier?: PlannerVerificationSnapshot;
}): WorkflowCompletionState {
  const verifier = input.verifier;
  const successfulToolCalls = input.toolCalls.filter(
    (toolCall) => !didToolCallFail(toolCall.isError, toolCall.result),
  );
  const hasProgress = successfulToolCalls.length > 0;
  const requestCompletion = resolveWorkflowRequestCompletionStatus({
    contract: input.verificationContract?.requestCompletion,
    completedMilestoneIds: input.completedRequestMilestoneIds,
  });

  if (input.stopReason === "completed") {
    if (verifier?.overall === "retry" || verifier?.overall === "fail") {
      return hasProgress ? "partial" : "blocked";
    }
    return "completed";
  }

  if (input.stopReason === "tool_calls") {
    return "blocked";
  }

  if (input.validationCode === "missing_behavior_harness" && hasProgress) {
    return "partial";
  }

  if ((requestCompletion?.remainingMilestones.length ?? 0) > 0 && hasProgress) {
    return "partial";
  }

  return hasProgress ? "partial" : "blocked";
}
