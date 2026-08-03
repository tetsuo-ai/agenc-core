/** Bounded bridge from the frozen manifest contract to the pre-B3b runner. */

import type { WorkflowStepSpec } from "./workflow-runner.js";
import type { WorkflowInvocation } from "./workflow-invocation.js";
import type {
  NormalizedWorkflowDagDocument,
  WorkflowRef,
} from "./workflow-manifest-schema.js";

export const LEGACY_WORKFLOW_EXECUTION_MAX_CONCURRENCY = 16;

export interface LegacyWorkflowExecutionPlan {
  readonly maxConcurrency: number;
  readonly steps: readonly WorkflowStepSpec[];
}

export class WorkflowB3bRequiredError extends Error {
  readonly code = "WORKFLOW_B3B_REQUIRED";
  readonly feature: string;

  constructor(feature: string) {
    super(
      `workflow ${feature} requires the B3b scheduler and cannot execute through the legacy runner`,
    );
    this.name = "WorkflowB3bRequiredError";
    this.feature = feature;
  }
}

/**
 * Preserve one-epoch legacy DAG execution without pretending that the old
 * runner implements the v2 scheduler contract. The loader has already made
 * legacy references unambiguous and semantic validation has already proved
 * the graph. This bridge only restores their string representation.
 */
export function prepareLegacyWorkflowExecution(
  document: NormalizedWorkflowDagDocument,
  invocation: WorkflowInvocation,
): LegacyWorkflowExecutionPlan {
  if (document.sourceVersion !== 1) {
    throw new WorkflowB3bRequiredError("format-version 2 semantics");
  }
  if (
    invocation.args !== undefined &&
    Object.keys(invocation.args).length !== 0
  ) {
    throw new WorkflowB3bRequiredError("invocation overrides");
  }

  const steps = document.manifest.steps.map((step): WorkflowStepSpec => {
    if (step.inputs !== undefined && Object.keys(step.inputs).length !== 0) {
      throw new WorkflowB3bRequiredError("step inputs");
    }
    return Object.freeze({
      id: step.id,
      message: step.message,
      ...(step.task_name === undefined ? {} : { task_name: step.task_name }),
      ...(step.agent_type === undefined ? {} : { agent_type: step.agent_type }),
      ...(step.model === undefined ? {} : { model: step.model }),
      ...(step.isolation === undefined ? {} : { isolation: step.isolation }),
      ...(step.group === undefined ? {} : { group: step.group }),
      ...(step.after === undefined
        ? {}
        : {
            after: Object.freeze(step.after.map(referenceToLegacyName)),
          }),
    });
  });

  return Object.freeze({
    maxConcurrency: LEGACY_WORKFLOW_EXECUTION_MAX_CONCURRENCY,
    steps: Object.freeze(steps),
  });
}

function referenceToLegacyName(reference: WorkflowRef): string {
  return "step" in reference ? reference.step : reference.group;
}
