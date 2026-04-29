export interface WorkflowRequestMilestone {
  readonly id: string;
  readonly description: string;
}

export interface WorkflowRequestCompletionContract {
  readonly requiredMilestones: readonly WorkflowRequestMilestone[];
}

interface WorkflowRequestCompletionStatus {
  readonly requiredMilestones: readonly WorkflowRequestMilestone[];
  readonly satisfiedMilestoneIds: readonly string[];
  readonly remainingMilestones: readonly WorkflowRequestMilestone[];
}

export function normalizeWorkflowRequestMilestones(
  contract?: WorkflowRequestCompletionContract,
): readonly WorkflowRequestMilestone[] {
  return (
    contract?.requiredMilestones
      .map((milestone) => {
        const id =
          typeof milestone.id === "string" ? milestone.id.trim() : "";
        const description =
          typeof milestone.description === "string"
            ? milestone.description.trim()
            : "";
        return id.length > 0 && description.length > 0
          ? { id, description }
          : undefined;
      })
      .filter((milestone): milestone is WorkflowRequestMilestone => milestone !== undefined) ?? []
  );
}

export function resolveWorkflowRequestCompletionStatus(params: {
  readonly contract?: WorkflowRequestCompletionContract;
  readonly completedMilestoneIds?: readonly string[];
}): WorkflowRequestCompletionStatus | undefined {
  const requiredMilestones = normalizeWorkflowRequestMilestones(params.contract);
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
