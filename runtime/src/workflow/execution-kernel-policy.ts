import type {
  PipelinePlannerStep,
  PipelinePlannerSubagentStep,
  PipelineResult,
  PipelineStopReasonHint,
} from "./pipeline.js";
import type {
  ExecutionKernelDependencyState,
  ExecutionKernelNodeOutcome,
} from "./execution-kernel-types.js";
import {
  didToolCallFail,
  extractToolFailureTextFromResult,
} from "../llm/chat-executor-tool-utils.js";

export function assessPlannerDependencySatisfaction(
  step: PipelinePlannerStep,
  result: string,
): ExecutionKernelDependencyState {
  if (step.stepType === "deterministic_tool") {
    if (result.startsWith("SKIPPED:")) {
      if (step.onError === "skip") {
        return { satisfied: true };
      }
      const reason = result.slice("SKIPPED:".length).trim();
      return {
        satisfied: false,
        reason:
          reason.length > 0
            ? reason
            : `Planner step "${step.name}" was skipped`,
        stopReasonHint: "tool_error",
      };
    }
    if (didToolCallFail(false, result)) {
      return {
        satisfied: false,
        reason: extractToolFailureTextFromResult(result),
        stopReasonHint: "tool_error",
      };
    }
    return { satisfied: true };
  }

  if (step.stepType === "subagent_task") {
    return assessSubagentDependencySatisfaction(step, result);
  }

  return { satisfied: true };
}

function assessSubagentDependencySatisfaction(
  step: PipelinePlannerSubagentStep,
  result: string,
): ExecutionKernelDependencyState {
  if (result.startsWith("SKIPPED:")) {
    const reason = result.slice("SKIPPED:".length).trim();
    return {
      satisfied: false,
      reason:
        reason.length > 0
          ? reason
          : `Sub-agent step "${step.name}" was skipped`,
      stopReasonHint: "validation_error",
    };
  }

  try {
    const parsed = JSON.parse(result) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { satisfied: true };
    }
    const obj = parsed as Record<string, unknown>;
    const status = typeof obj.status === "string" ? obj.status : undefined;
    if (status === "delegation_fallback") {
      return { satisfied: true };
    }
    const error =
      typeof obj.error === "string" && obj.error.trim().length > 0
        ? obj.error.trim()
        : undefined;
    if (
      obj.success === false ||
      status === "failed" ||
      status === "cancelled" ||
      status === "needs_decomposition" ||
      status === "dependency_blocked"
    ) {
      return {
        satisfied: false,
        reason:
          error ??
          `Sub-agent step "${step.name}" returned unresolved status "${status ?? "unknown"}"`,
        stopReasonHint:
          toPipelineStopReasonHint(obj.stopReasonHint) ??
          (status === "cancelled" ? "cancelled" : "validation_error"),
      };
    }
    if (error) {
      return {
        satisfied: false,
        reason: error,
        stopReasonHint:
          toPipelineStopReasonHint(obj.stopReasonHint) ?? "validation_error",
      };
    }
  } catch {
    if (didToolCallFail(false, result)) {
      return {
        satisfied: false,
        reason: extractToolFailureTextFromResult(result),
        stopReasonHint: "tool_error",
      };
    }
  }

  return { satisfied: true };
}

function toPipelineStopReasonHint(
  value: unknown,
): PipelineStopReasonHint | undefined {
  return value === "validation_error" ||
      value === "provider_error" ||
      value === "authentication_error" ||
      value === "rate_limited" ||
      value === "timeout" ||
      value === "tool_error" ||
      value === "budget_exceeded" ||
      value === "no_progress" ||
      value === "cancelled"
    ? value
    : undefined;
}

export function buildDependencyBlockedError(
  stepName: string,
  blockedDependencies: readonly {
    stepName: string;
    reason: string;
    stopReasonHint: PipelineStopReasonHint;
  }[],
): string {
  const renderedDependencies = blockedDependencies
    .map(
      (dependency) =>
        `${dependency.stepName} (${dependency.stopReasonHint}): ${dependency.reason}`,
    )
    .join("; ");
  return `Planner step "${stepName}" was blocked by unmet dependencies: ${renderedDependencies}`;
}

export function buildDependencyBlockedResult(
  stepName: string,
  blockedDependencies: readonly {
    stepName: string;
    reason: string;
    stopReasonHint: PipelineStopReasonHint;
  }[],
  error: string,
  stopReasonHint: PipelineStopReasonHint,
): string {
  return JSON.stringify({
    status: "dependency_blocked",
    success: false,
    stepName,
    error,
    stopReasonHint,
    unmetDependencies: blockedDependencies.map((dependency) => ({
      stepName: dependency.stepName,
      reason: dependency.reason,
      stopReasonHint: dependency.stopReasonHint,
    })),
  });
}

export function mapDeterministicPipelineResultToNodeOutcome(
  stepName: string,
  outcome: PipelineResult,
): ExecutionKernelNodeOutcome {
  if (outcome.status === "halted") {
    return {
      status: "halted",
      error: outcome.error ?? `Deterministic step "${stepName}" halted`,
      stopReasonHint: outcome.stopReasonHint,
    };
  }
  if (outcome.status === "failed") {
    return {
      status: "failed",
      error: outcome.error ?? `Deterministic step "${stepName}" failed`,
      stopReasonHint: outcome.stopReasonHint ?? "tool_error",
    };
  }
  const result = outcome.context.results[stepName];
  if (typeof result === "string") {
    return { status: "completed", result };
  }
  return {
    status: "completed",
    result: JSON.stringify({
      status: outcome.status,
      result: result ?? null,
    }),
  };
}
