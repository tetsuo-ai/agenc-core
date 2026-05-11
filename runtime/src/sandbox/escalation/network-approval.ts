/**
 * Network-approval ENFORCEMENT layer.
 *
 * Converts approval verdicts into sandbox-mode bits at child-process
 * spawn. The DECISION counterpart lives at
 * `permissions/network-approval.ts` — it caches approvals, dedups
 * concurrent requests, and invokes the approval resolver.
 *
 * Both sides derive from codex `core/src/network_policy_decision.rs`; // branding-scan: allow upstream source citation
 * the split mirrors codex's policy/enforcement separation. // branding-scan: allow upstream source citation
 *
 * @module
 */

import {
  hostApprovalKeyToString,
  type ApprovalPolicy,
  type HostApprovalKey,
  type NetworkApprovalContext,
  type NetworkApprovalHook,
  type NetworkApprovalResolver,
  type NetworkApprovalService,
  type NetworkDecision,
  type PersistNetworkPolicyAmendment,
  type SandboxPolicy,
} from "../../permissions/network-approval.js";

export type NetworkApprovalGate =
  | { readonly kind: "allowed" }
  | { readonly kind: "denied"; readonly reason: string };

export interface ManagedNetworkApprovalOptions {
  readonly service: NetworkApprovalService;
  readonly key: HostApprovalKey;
  readonly sandboxPolicy: SandboxPolicy;
  readonly approvalPolicy: ApprovalPolicy;
  readonly resolver?: NetworkApprovalResolver;
  readonly hooks?: ReadonlyArray<NetworkApprovalHook>;
  readonly persistAmendment?: PersistNetworkPolicyAmendment;
  readonly onAmendmentPersistError?: (err: unknown) => void;
  readonly signal?: AbortSignal;
}

export function networkApprovalSandboxGate(
  sandboxPolicy: SandboxPolicy,
  approvalPolicy: ApprovalPolicy,
): NetworkApprovalGate {
  if (
    sandboxPolicy.kind === "danger_full_access" ||
    sandboxPolicy.kind === "external_sandbox"
  ) {
    return { kind: "denied", reason: "not_allowed_in_sandbox_mode" };
  }
  if (approvalPolicy === "never") {
    return { kind: "denied", reason: "approval_policy_never" };
  }
  return { kind: "allowed" };
}

export async function requestManagedNetworkApprovalForSandbox(
  opts: ManagedNetworkApprovalOptions,
): Promise<NetworkDecision> {
  const gate = networkApprovalSandboxGate(opts.sandboxPolicy, opts.approvalPolicy);
  if (gate.kind === "denied") {
    return { kind: "deny", reason: gate.reason };
  }
  return await opts.service.requestNetworkApproval({
    key: opts.key,
    sandboxPolicy: opts.sandboxPolicy,
    approvalPolicy: opts.approvalPolicy,
    ...(opts.resolver !== undefined ? { resolver: opts.resolver } : {}),
    ...(opts.hooks !== undefined ? { hooks: opts.hooks } : {}),
    ...(opts.persistAmendment !== undefined
      ? { persistAmendment: opts.persistAmendment }
      : {}),
    ...(opts.onAmendmentPersistError !== undefined
      ? { onAmendmentPersistError: opts.onAmendmentPersistError }
      : {}),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  });
}

export function managedNetworkApprovalContext(
  key: HostApprovalKey,
): NetworkApprovalContext & { readonly cacheKey: string } {
  const host = key.host.trim().toLowerCase().replace(/\.$/u, "");
  const normalized = { ...key, host };
  return {
    host,
    protocol: normalized.protocol,
    port: normalized.port,
    target: `${normalized.protocol}://${host}:${normalized.port}`,
    cacheKey: hostApprovalKeyToString(normalized),
  };
}

export function networkDecisionFromApprovalGate(
  gate: NetworkApprovalGate,
): NetworkDecision {
  return gate.kind === "allowed"
    ? { kind: "allow" }
    : { kind: "deny", reason: gate.reason };
}
