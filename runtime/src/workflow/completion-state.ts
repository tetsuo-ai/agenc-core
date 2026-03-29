import { didToolCallFail } from "../llm/chat-executor-tool-utils.js";
import type { DelegationOutputValidationCode } from "../utils/delegation-validation.js";
import type { ImplementationCompletionContract } from "./completion-contract.js";
import { resolveWorkflowRequestCompletionStatus } from "./request-completion.js";
import { deriveVerificationObligations, type WorkflowVerificationContract } from "./verification-obligations.js";

export const WORKFLOW_COMPLETION_STATES = [
  "completed",
  "partial",
  "blocked",
  "needs_verification",
] as const;

export type WorkflowCompletionState =
  typeof WORKFLOW_COMPLETION_STATES[number];

export const WORKFLOW_DEPENDENCY_STATE_KINDS = [
  "satisfied_terminal",
  "satisfied_nonterminal",
  "unsatisfied_nonterminal",
  "unsatisfied_terminal",
] as const;

export type WorkflowDependencyStateKind =
  typeof WORKFLOW_DEPENDENCY_STATE_KINDS[number];

export const WORKFLOW_RESOLUTION_SEMANTICS = [
  "normal",
  "delegation_fallback",
  "noop_success",
] as const;

export type WorkflowResolutionSemantics =
  typeof WORKFLOW_RESOLUTION_SEMANTICS[number];

export interface WorkflowDependencyState {
  readonly kind: WorkflowDependencyStateKind;
  readonly completionState: WorkflowCompletionState;
  readonly dependencySatisfied: boolean;
  readonly terminal: boolean;
  readonly verifierClosed: boolean;
  readonly semantics: WorkflowResolutionSemantics;
}

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

export function resolveWorkflowDependencyState(params: {
  readonly completionState?: WorkflowCompletionState;
  readonly reportedStatus?: string;
  readonly reportedOutcome?: string;
  readonly recoveredViaParentFallback?: boolean;
}): WorkflowDependencyState {
  if (
    params.recoveredViaParentFallback === true ||
    params.reportedStatus === "delegation_fallback"
  ) {
    return {
      kind: "unsatisfied_terminal",
      completionState: "blocked",
      dependencySatisfied: false,
      terminal: true,
      verifierClosed: false,
      semantics: "delegation_fallback",
    };
  }

  const semantics =
    params.reportedOutcome === "already_satisfied"
      ? "noop_success"
      : "normal";
  const completionState = params.completionState ?? "completed";
  switch (completionState) {
    case "completed":
      return {
        kind: "satisfied_terminal",
        completionState,
        dependencySatisfied: true,
        terminal: true,
        verifierClosed: true,
        semantics,
      };
    case "needs_verification":
      return {
        kind: "satisfied_nonterminal",
        completionState,
        dependencySatisfied: true,
        terminal: false,
        verifierClosed: false,
        semantics,
      };
    case "partial":
      return {
        kind: "unsatisfied_nonterminal",
        completionState,
        dependencySatisfied: false,
        terminal: false,
        verifierClosed: false,
        semantics,
      };
    case "blocked":
    default:
      return {
        kind: "unsatisfied_terminal",
        completionState: "blocked",
        dependencySatisfied: false,
        terminal: true,
        verifierClosed: false,
        semantics,
      };
  }
}

export function resolvePipelineCompletionStateFromDependencyStates(
  states: readonly Pick<WorkflowDependencyState, "kind" | "completionState">[],
): WorkflowCompletionState {
  if (
    states.some((state) =>
      state.kind === "unsatisfied_terminal" ||
      state.completionState === "blocked"
    )
  ) {
    return "blocked";
  }
  if (
    states.some((state) =>
      state.kind === "unsatisfied_nonterminal" ||
      state.completionState === "partial"
    )
  ) {
    return "partial";
  }
  if (
    states.some((state) =>
      state.kind === "satisfied_nonterminal" ||
      state.completionState === "needs_verification"
    )
  ) {
    return "needs_verification";
  }
  return "completed";
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
