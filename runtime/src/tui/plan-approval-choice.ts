/**
 * TUI-side side-channel carrying the user's plan-mode approval choice from the
 * PlanApprovalOverlay (React render) to the approval RPC bridge
 * (maybeBridgeDaemonApproval in daemon-session.ts).
 *
 * The overlay resolves the permission request as APPROVED and stashes the
 * chosen ExitPlan payload here, keyed by the request's callId. The bridge takes
 * it back out when sending `tool.approve` so the daemon can record it via
 * recordExitPlanModeApproval(requestId, …) before resolving the deferred tool.
 *
 * requestId (daemon) === payload.callId (TUI) === the request's id, so keying by
 * callId is the correct mapping end-to-end.
 *
 * Self-contained: no React, no daemon imports beyond the shared payload shape.
 */

/**
 * Mirrors the wire-level ExitPlanApprovalPayload (protocol/index.ts). Kept as a
 * local interface so this module has no app-server import edge. The index
 * signature keeps it assignable to the daemon RPC's JsonObject params without
 * importing the protocol type.
 */
export interface PlanApprovalChoice {
  readonly action: "approve" | "revise";
  readonly mode?: "acceptEdits" | "default";
  readonly applyAllowedPrompts?: boolean;
  readonly clearContext?: boolean;
  readonly feedback?: string;
  readonly [key: string]:
    | string
    | boolean
    | undefined;
}

const choices = new Map<string, PlanApprovalChoice>();

export function setPlanApprovalChoice(
  callId: string,
  choice: PlanApprovalChoice,
): void {
  if (callId.length === 0) return;
  choices.set(callId, choice);
}

export function takePlanApprovalChoice(
  callId: string,
): PlanApprovalChoice | undefined {
  const choice = choices.get(callId);
  choices.delete(callId);
  return choice;
}

export function clearPlanApprovalChoicesForTest(): void {
  choices.clear();
}
