import type { DelegationDecompositionSignal } from "../gateway/delegation-scope.js";
import type {
  Pipeline,
  PipelineExecutionOptions,
  PipelinePlannerStep,
  PipelineResult,
  PipelineStopReasonHint,
} from "./pipeline.js";
import type {
  WorkflowCompletionState,
  WorkflowDependencyStateKind,
  WorkflowResolutionSemantics,
} from "./completion-state.js";

export const EXECUTION_KERNEL_STEP_STATES = [
  "queued",
  "ready",
  "running",
  "blocked_on_approval",
  "blocked_on_dependency",
  "retry_pending",
  "completed",
  "failed",
  "resumed",
  "compensated",
] as const;

export type ExecutionKernelStepState =
  typeof EXECUTION_KERNEL_STEP_STATES[number];

export const EXECUTION_KERNEL_NODE_OUTCOME_STATUSES = [
  "completed",
  "failed",
  "halted",
] as const;

export type ExecutionKernelNodeOutcomeStatus =
  typeof EXECUTION_KERNEL_NODE_OUTCOME_STATUSES[number];

export interface ExecutionKernelStepStateChange {
  readonly type: "step_state_changed";
  readonly pipelineId: string;
  readonly stepName: string;
  readonly stepIndex: number;
  readonly state: ExecutionKernelStepState;
  readonly previousState?: ExecutionKernelStepState;
  readonly tool?: string;
  readonly args?: Record<string, unknown>;
  readonly reason?: string;
  readonly blockingDependencies?: readonly string[];
}

export interface ExecutionKernelDependencyState {
  readonly kind: WorkflowDependencyStateKind;
  readonly completionState: WorkflowCompletionState;
  readonly dependencySatisfied: boolean;
  readonly terminal: boolean;
  readonly verifierClosed: boolean;
  readonly semantics: WorkflowResolutionSemantics;
  readonly reason?: string;
  readonly stopReasonHint?: PipelineStopReasonHint;
}

export type ExecutionKernelNodeOutcome =
  | { readonly status: "completed"; readonly result: string }
  | {
    readonly status: "failed";
    readonly error: string;
    readonly stopReasonHint?: PipelineStopReasonHint;
    readonly decomposition?: DelegationDecompositionSignal;
    readonly result?: string;
  }
  | {
    readonly status: "halted";
    readonly error?: string;
    readonly stopReasonHint?: PipelineStopReasonHint;
  };

export interface ExecutionKernelRuntimeNode {
  readonly step: PipelinePlannerStep;
  readonly dependencies: ReadonlySet<string>;
  readonly orderIndex: number;
}

export interface ExecutionKernelPlannerDelegate {
  readonly executeNode: (
    step: PipelinePlannerStep,
    pipeline: Pipeline,
    results: Record<string, string>,
    options: PipelineExecutionOptions | undefined,
    signal?: AbortSignal,
  ) => Promise<ExecutionKernelNodeOutcome>;
  readonly assessDependencySatisfaction: (
    step: PipelinePlannerStep,
    result: string,
  ) => ExecutionKernelDependencyState;
  readonly isExclusiveNode: (step: PipelinePlannerStep) => boolean;
  readonly resolveTraceToolName?: (
    step: PipelinePlannerStep,
  ) => string | undefined;
  readonly buildTraceArgs?: (
    step: PipelinePlannerStep,
  ) => Record<string, unknown> | undefined;
  readonly onStepDependencyBlocked?: (input: {
    step: PipelinePlannerStep;
    pipeline: Pipeline;
    blockedDependencies: readonly {
      stepName: string;
      reason: string;
      stopReasonHint: PipelineStopReasonHint;
    }[];
    error: string;
  }) => void;
  readonly validatePipeline?: (pipeline: Pipeline) => string | null;
  readonly resolveMaxParallelism?: (pipeline: Pipeline) => number;
}

export interface ExecutionKernel extends Pick<ExecutionKernelPlannerDelegate, never> {
  execute(
    pipeline: Pipeline,
    startFrom?: number,
    options?: PipelineExecutionOptions,
  ): Promise<PipelineResult>;
}
