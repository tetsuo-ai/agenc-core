import { didToolCallFail } from "../llm/chat-executor-tool-utils.js";
import type { DelegationOutputValidationCode } from "../utils/delegation-validation.js";

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
  readonly validationCode?: DelegationOutputValidationCode;
  readonly requiresVerification?: boolean;
  readonly verificationSatisfied?: boolean;
}): WorkflowCompletionState {
  const successfulToolCalls = input.toolCalls.filter(
    (toolCall) => !didToolCallFail(toolCall.isError, toolCall.result),
  );
  const hasProgress = successfulToolCalls.length > 0;

  if (input.stopReason === "completed") {
    if (input.requiresVerification && !input.verificationSatisfied) {
      return "needs_verification";
    }
    return "completed";
  }

  if (input.stopReason === "tool_calls") {
    return "blocked";
  }

  if (input.validationCode === "missing_behavior_harness" && hasProgress) {
    return "partial";
  }

  return hasProgress ? "partial" : "blocked";
}
