export interface ApprovalFailureMetadata {
  readonly decision: string;
  readonly source: string;
}

const workflowApprovalSessions = new WeakSet<object>();

export function markWorkflowApprovalSession(session: object): () => void {
  workflowApprovalSessions.add(session);
  return () => workflowApprovalSessions.delete(session);
}

export function isWorkflowApprovalSession(session: object | undefined): boolean {
  return session !== undefined && workflowApprovalSessions.has(session);
}

export class WorkflowApprovalFailure extends Error {
  readonly stopReason: "approval_required" | "policy_denied";

  constructor(readonly approvalFailure: ApprovalFailureMetadata) {
    super(
      `Workflow tool approval ${approvalFailure.decision} (${approvalFailure.source}).`,
    );
    this.name = "WorkflowApprovalFailure";
    this.stopReason =
      approvalFailure.source === "default_deny" ||
        approvalFailure.decision === "timed_out"
      ? "approval_required"
      : "policy_denied";
  }
}

export function workflowApprovalFailureFromMetadata(
  value: unknown,
): WorkflowApprovalFailure | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const metadata = value as Record<string, unknown>;
  if (
    (metadata.decision !== "denied" && metadata.decision !== "timed_out") ||
    typeof metadata.source !== "string"
  ) {
    return undefined;
  }
  return new WorkflowApprovalFailure({
    decision: metadata.decision,
    source: metadata.source,
  });
}

export function workflowApprovalFailureCause(
  error: unknown,
): WorkflowApprovalFailure | undefined {
  let current = error;
  const seen = new Set<Error>();
  while (current instanceof Error && !seen.has(current)) {
    if (current instanceof WorkflowApprovalFailure) return current;
    seen.add(current);
    current = current.cause;
  }
  return undefined;
}
