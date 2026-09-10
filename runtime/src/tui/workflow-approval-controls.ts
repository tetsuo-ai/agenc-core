import type { AgenCDaemonResultByMethod, JsonObject, PendingToolApproval } from "../app-server/protocol/index.js";
import type { ReviewDecision } from "../permissions/review-decision.js";
import { reviewDecisionIsAllow } from "../permissions/review-decision.js";
import { takeAskUserQuestionUpdatedInput } from "../tools/ask-user-question/tool.js";
import { takePlanApprovalChoice } from "./plan-approval-choice.js";

interface WorkflowApprovalTransport {
  request<Method extends "permission.list" | "tool.approve" | "tool.deny">(
    method: Method,
    params: JsonObject,
    options: { readonly signal: AbortSignal },
  ): Promise<AgenCDaemonResultByMethod[Method]>;
}

export interface WorkflowApprovalControls {
  list(ownerRunId: string, signal: AbortSignal): Promise<readonly PendingToolApproval[]>;
  respond(
    request: PendingToolApproval,
    decision: ReviewDecision,
    responseKey: string,
    signal: AbortSignal,
  ): Promise<boolean>;
}

export function sameWorkflowApproval(left: PendingToolApproval, right: PendingToolApproval): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function createWorkflowApprovalControls(client: WorkflowApprovalTransport): WorkflowApprovalControls {
  const responding = new Set<string>();
  const list = async (ownerRunId: string, signal: AbortSignal): Promise<readonly PendingToolApproval[]> => {
    signal.throwIfAborted();
    const result = await client.request("permission.list", { sessionId: ownerRunId }, { signal });
    signal.throwIfAborted();
    const pending = result.pendingRequests ?? [];
    const identities = new Set<string>();
    for (const request of pending) {
      if (
        request.ownerRunId !== ownerRunId ||
        typeof request.requestId !== "string" || request.requestId.length === 0 ||
        typeof request.sessionId !== "string" || request.sessionId.length === 0 ||
        typeof request.toolName !== "string" || request.toolName.length === 0 ||
        identities.has(request.requestId)
      ) {
        throw new Error("The daemon returned inconsistent workflow approval identities.");
      }
      identities.add(request.requestId);
    }
    return structuredClone(pending);
  };
  return {
    list,
    async respond(request, decision, responseKey, signal) {
      const exitPlan = takePlanApprovalChoice(responseKey);
      const askUserQuestionInput = takeAskUserQuestionUpdatedInput(responseKey);
      if (signal.aborted || decision.kind === "abort") return false;
      const identity = JSON.stringify([request.ownerRunId, request.requestId]);
      if (responding.has(identity)) return false;
      responding.add(identity);
      try {
        const pending = await list(request.ownerRunId, signal);
        if (!pending.some((current) => sameWorkflowApproval(current, request))) return false;
        signal.throwIfAborted();
        if (reviewDecisionIsAllow(decision)) {
          await client.request("tool.approve", {
            sessionId: request.ownerRunId,
            requestId: request.requestId,
            scope: decision.kind === "approved_for_session" ? "session" : "once",
            ...(exitPlan !== undefined ? { exitPlan } : request.toolName === "ExitPlanMode" ? { exitPlan: { action: "revise" } } : {}),
            ...(askUserQuestionInput === null ? {} : { askUserQuestionInput: askUserQuestionInput as unknown as JsonObject }),
          }, { signal });
        } else {
          await client.request("tool.deny", {
            sessionId: request.ownerRunId,
            requestId: request.requestId,
            reason: decision.kind,
          }, { signal });
        }
        return true;
      } finally {
        responding.delete(identity);
      }
    },
  };
}
