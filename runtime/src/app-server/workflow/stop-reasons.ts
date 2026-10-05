import { AdmissionDeniedError } from "../../budget/admission-client.js";
import type { AdmissionJournalEvent } from "../../budget/admission-types.js";

/** Internal evidence keeps the dimension while the public stop stays budget_exhausted. */
export type WorkflowBoundStopReason =
  | "budget_exhausted"
  | "token_budget_exhausted"
  | "cost_budget_exhausted"
  | "deadline_exceeded";

export type WorkflowChildStopReason = WorkflowBoundStopReason | "approval_required" | "policy_denied";

export function isWorkflowChildStopReason(reason: unknown): reason is WorkflowChildStopReason {
  return typeof reason === "string" && Object.hasOwn(STOP_MESSAGES, reason);
}

const STOP_MESSAGES: Record<WorkflowChildStopReason, string> = {
  budget_exhausted: "The Goal stopped because the next action could not fit within the remaining budget.",
  token_budget_exhausted: "The Goal stopped because the next action could not fit within the remaining token budget.",
  cost_budget_exhausted: "The Goal stopped because the next action could not fit within the remaining cost budget.",
  deadline_exceeded: "The Goal stopped because its deadline was reached.",
  approval_required: "The Goal stopped because a required approval was not received. Please try again and approve the requested action.",
  policy_denied: "The Goal stopped because a required action was denied. Review the permissions before trying again.",
};

export function workflowStopMessage(reason: WorkflowChildStopReason): string {
  return STOP_MESSAGES[reason];
}

function boundReason(reason: string | undefined): WorkflowBoundStopReason | undefined {
  if (reason !== undefined && /(?:^|:)deadline_expired(?:_|$)/.test(reason)) return "deadline_exceeded";
  if (reason === "budget_exceeded" || reason === "allocation_blocked" || reason === "unpriced_under_hard_cap") {
    return "budget_exhausted";
  }
  return undefined;
}

/** Use the admission authority's recorded dimension, never a provider-facing cost label. */
export function workflowAdmissionStopReason(
  error: unknown,
  latestEvent?: AdmissionJournalEvent,
): WorkflowBoundStopReason | undefined {
  if (latestEvent !== undefined && (latestEvent.event === "denied" || latestEvent.event === "cancelled")) {
    const reason = boundReason(latestEvent.reason);
    if (reason === "budget_exhausted" && latestEvent.reason === "budget_exceeded") {
      if (latestEvent.details?.budgetDimension === "tokens") return "token_budget_exhausted";
      if (latestEvent.details?.budgetDimension === "cost") return "cost_budget_exhausted";
    }
    if (reason !== undefined) return reason;
  }
  const seen = new Set<unknown>();
  let candidate = error;
  while (candidate instanceof Error && !seen.has(candidate)) {
    seen.add(candidate);
    if (candidate instanceof AdmissionDeniedError) return boundReason(candidate.reason);
    candidate = candidate.cause;
  }
  return undefined;
}
