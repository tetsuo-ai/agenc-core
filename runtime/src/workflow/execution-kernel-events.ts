import type {
  PipelineExecutionEvent,
  PipelineExecutionOptions,
} from "./pipeline.js";
import type {
  ExecutionKernelStepState,
  ExecutionKernelStepStateChange,
} from "./execution-kernel-types.js";

interface EmitStepStateChangeParams {
  readonly options?: PipelineExecutionOptions;
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

export function emitStepStateChange(
  params: EmitStepStateChangeParams,
): void {
  const payload: ExecutionKernelStepStateChange = {
    type: "step_state_changed",
    pipelineId: params.pipelineId,
    stepName: params.stepName,
    stepIndex: params.stepIndex,
    state: params.state,
    ...(params.previousState ? { previousState: params.previousState } : {}),
    ...(params.tool ? { tool: params.tool } : {}),
    ...(params.args ? { args: params.args } : {}),
    ...(params.reason ? { reason: params.reason } : {}),
    ...(params.blockingDependencies
      ? { blockingDependencies: params.blockingDependencies }
      : {}),
  };
  params.options?.onEvent?.(payload satisfies PipelineExecutionEvent);
}

