export interface WorkflowRequestMilestone {
  readonly id: string;
  readonly description: string;
}

export interface WorkflowRequestCompletionContract {
  readonly requiredMilestones: readonly WorkflowRequestMilestone[];
}

export interface WorkflowRequestCompletionStatus {
  readonly requiredMilestones: readonly WorkflowRequestMilestone[];
  readonly satisfiedMilestoneIds: readonly string[];
  readonly remainingMilestones: readonly WorkflowRequestMilestone[];
}

export function resolveWorkflowRequestCompletionStatus(params: {
  readonly contract?: WorkflowRequestCompletionContract;
  readonly completedMilestoneIds?: readonly string[];
}): WorkflowRequestCompletionStatus | undefined {
  const requiredMilestones =
    params.contract?.requiredMilestones.filter((milestone) =>
      typeof milestone.id === "string" &&
      milestone.id.trim().length > 0 &&
      typeof milestone.description === "string" &&
      milestone.description.trim().length > 0
    ) ?? [];
  if (requiredMilestones.length === 0) {
    return undefined;
  }

  const completedIds = new Set(
    (params.completedMilestoneIds ?? [])
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
  );
  const satisfiedMilestoneIds = requiredMilestones
    .map((milestone) => milestone.id.trim())
    .filter((id, index, ids) => completedIds.has(id) && ids.indexOf(id) === index);
  const remainingMilestones = requiredMilestones.filter((milestone) =>
    !completedIds.has(milestone.id.trim())
  );

  return {
    requiredMilestones,
    satisfiedMilestoneIds,
    remainingMilestones,
  };
}
