import {
  reviewDecisionIsAllow,
  type ExecPolicyAmendment,
  type NetworkPolicyAmendment,
  type ReviewDecision,
} from "../../permissions/review-decision.js";
import type { AdditionalSandboxPermissions } from "./sandboxing.js";

/**
 * The permission named on an approval request whose approval runs the call
 * without the OS sandbox after the sandbox refused it. The approval journal's
 * `request_permissions` event lists it next to `tool.use`, and the daemon's
 * `event.permission_request` passes that list on, so every client can show
 * the request as that question instead of an ordinary tool approval.
 */
export const RUN_WITHOUT_SANDBOX_PERMISSION = "run_without_sandbox";

/** Whether a projected permission list asks to run a call without the sandbox. */
export function permissionsRunWithoutSandbox(permissions: unknown): boolean {
  return Array.isArray(permissions) &&
    permissions.includes(RUN_WITHOUT_SANDBOX_PERMISSION);
}

export type NetworkApprovalProtocol =
  | "http"
  | "https"
  | "socks5-tcp"
  | "socks5-udp";

export interface NetworkApprovalContext {
  readonly host: string;
  readonly protocol: NetworkApprovalProtocol;
}

export interface ParsedApprovalCommand {
  readonly command: readonly string[];
  readonly matchedPrefix?: readonly string[];
  readonly usedComplexParsing?: boolean;
}

export type AvailableApprovalDecision =
  | { readonly kind: "approved" }
  | { readonly kind: "approved_for_session" }
  | {
      readonly kind: "approved_execpolicy_amendment";
      readonly proposed_execpolicy_amendment: ExecPolicyAmendment;
    }
  | {
      readonly kind: "network_policy_amendment";
      readonly amendment: NetworkPolicyAmendment;
    }
  | { readonly kind: "abort" };

export interface ExecApprovalRequestEvent {
  readonly callId: string;
  readonly approvalId?: string;
  readonly turnId?: string;
  readonly cwd?: string;
  readonly command: readonly string[];
  readonly parsedCommand?: ParsedApprovalCommand;
  readonly reason?: string;
  readonly networkApprovalContext?: NetworkApprovalContext;
  readonly additionalPermissions?: AdditionalSandboxPermissions;
  readonly proposedExecPolicyAmendment?: ExecPolicyAmendment;
  readonly proposedNetworkPolicyAmendments?: readonly NetworkPolicyAmendment[];
  readonly availableDecisions?: readonly AvailableApprovalDecision[];
}

export function effectiveApprovalId(event: ExecApprovalRequestEvent): string {
  return event.approvalId ?? event.callId;
}

export function effectiveAvailableApprovalDecisions(
  event: ExecApprovalRequestEvent,
): readonly AvailableApprovalDecision[] {
  return event.availableDecisions ?? defaultAvailableApprovalDecisions(event);
}

export function defaultAvailableApprovalDecisions(
  event: Pick<
    ExecApprovalRequestEvent,
    | "networkApprovalContext"
    | "additionalPermissions"
    | "proposedExecPolicyAmendment"
    | "proposedNetworkPolicyAmendments"
  >,
): readonly AvailableApprovalDecision[] {
  if (event.networkApprovalContext !== undefined) {
    const decisions: AvailableApprovalDecision[] = [
      { kind: "approved" },
      { kind: "approved_for_session" },
    ];
    const allowAmendment = event.proposedNetworkPolicyAmendments?.find(
      (amendment) => amendment.action === "allow",
    );
    if (allowAmendment !== undefined) {
      decisions.push({
        kind: "network_policy_amendment",
        amendment: allowAmendment,
      });
    }
    decisions.push({ kind: "abort" });
    return decisions;
  }

  if (event.additionalPermissions !== undefined) {
    return [{ kind: "approved" }, { kind: "abort" }];
  }

  const decisions: AvailableApprovalDecision[] = [{ kind: "approved" }];
  if (event.proposedExecPolicyAmendment !== undefined) {
    decisions.push({
      kind: "approved_execpolicy_amendment",
      proposed_execpolicy_amendment: event.proposedExecPolicyAmendment,
    });
  }
  decisions.push({ kind: "abort" });
  return decisions;
}

export function reviewDecisionAllowsEscalation(
  decision: ReviewDecision,
): boolean {
  return reviewDecisionIsAllow(decision);
}

export function availableDecisionKinds(
  decisions: readonly AvailableApprovalDecision[],
): readonly string[] {
  return decisions.map((decision) => decision.kind);
}
