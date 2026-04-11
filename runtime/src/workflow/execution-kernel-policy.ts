/**
 * Execution kernel dependency policy — collapsed stub (Cut 1.1).
 *
 * Replaces the previous 242-LOC dependency-satisfaction evaluator
 * tied to the deleted planner DAG. Subagent orchestrator + workflow
 * execution-kernel still call into these functions; they now return
 * permissive defaults that mark every dependency as satisfied.
 *
 * @module
 */

import type {
  PipelinePlannerStep,
  PipelineResult,
} from "./pipeline.js";
import type {
  ExecutionKernelDependencyState,
  ExecutionKernelNodeOutcome,
} from "./execution-kernel-types.js";

export function assessPlannerDependencySatisfaction(
  _step: PipelinePlannerStep,
  _result: string,
): ExecutionKernelDependencyState {
  return { satisfied: true };
}

export function buildDependencyBlockedError(
  stepName: string,
  blockedDependencies: readonly unknown[],
): string {
  return `Step "${stepName}" blocked by unsatisfied dependencies: ${blockedDependencies.length}`;
}

export function buildDependencyBlockedResult(
  stepName: string,
  _blockedDependencies: readonly unknown[],
  _error?: unknown,
  _stopReasonHint?: unknown,
): string {
  return `Step "${stepName}" blocked by unsatisfied dependencies`;
}

export function mapDeterministicPipelineResultToNodeOutcome(
  _stepName: string,
  outcome: PipelineResult,
): ExecutionKernelNodeOutcome {
  const outcomeString =
    typeof outcome === "string"
      ? outcome
      : JSON.stringify(outcome);
  return {
    status: "completed",
    result: outcomeString,
  };
}
