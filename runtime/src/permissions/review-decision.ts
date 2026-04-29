/**
 * ReviewDecision — user's answer to an approval prompt.
 *
 * Hand-port of codex runtime `protocol/src/protocol.rs:3600-3654`
 * (T11 Wave 1, Agent C).
 *
 * This file is the single canonical location for the `ReviewDecision`
 * type in the codex runtime. `runtime/src/tools/orchestrator.ts`
 * re-exports from here; nothing else in the runtime owns its own copy.
 *
 * Shape notes:
 *   - The original codex runtime enum is serde `snake_case` tagged, meaning
 *     `ReviewDecision::Approved` serializes as `"approved"` and
 *     `ReviewDecision::ApprovedExecpolicyAmendment { .. }` as
 *     `{ "approved_execpolicy_amendment": { .. } }`. AgenC models the
 *     Rust enum as a discriminated `{ kind }` tagged union so TypeScript
 *     callers can pattern-match exhaustively.
 *   - `approved_execpolicy_amendment` carries an opaque
 *     `ExecPolicyAmendment`. T11 Wave 1 does NOT port the execpolicy
 *     internals, so the amendment is typed as opaque JSON. A later
 *     wave can swap in a real schema without touching callers.
 *   - `network_policy_amendment` carries the host rule the user chose
 *     to persist (allow/deny). The AgenC network-approval tranche will
 *     land the full resolver; for now this only needs to round-trip.
 *   - `to_opaque_string()` lives here (as `reviewDecisionOpaqueString`)
 *     so telemetry stays stable across call sites.
 *
 * @module
 */

// ─────────────────────────────────────────────────────────────────────
// Opaque payloads — T11 Wave 1 does not deserialize into these, it
// only transports them through approval flows.
// ─────────────────────────────────────────────────────────────────────

/** Opaque execpolicy amendment shape. Full schema lands in a later wave. */
export type ExecPolicyAmendment = Readonly<Record<string, unknown>>;

/** Action selected by the user for a persisted host rule. */
export type NetworkPolicyRuleAction = "allow" | "deny";

/**
 * Minimal host rule carrier. The real network-policy resolver (AgenC
 * network-approval tranche) will expand this — T11 only needs enough
 * to round-trip allow/deny answers through the approval cache + UI.
 */
export interface NetworkPolicyAmendment {
  readonly action: NetworkPolicyRuleAction;
  readonly host: string;
  readonly port?: number;
  readonly protocol?: string;
}

// ─────────────────────────────────────────────────────────────────────
// ReviewDecision — 7 variants, AgenC behavior.
// ─────────────────────────────────────────────────────────────────────

export type ReviewDecision =
  | { readonly kind: "approved" }
  | {
      readonly kind: "approved_execpolicy_amendment";
      readonly proposed_execpolicy_amendment: ExecPolicyAmendment;
    }
  | { readonly kind: "approved_for_session" }
  | {
      readonly kind: "network_policy_amendment";
      readonly amendment: NetworkPolicyAmendment;
    }
  | { readonly kind: "denied" }
  | { readonly kind: "timed_out" }
  | { readonly kind: "abort" };

// ─────────────────────────────────────────────────────────────────────
// Convenience constructors — keep call sites short and typed.
// ─────────────────────────────────────────────────────────────────────

export const APPROVED: ReviewDecision = { kind: "approved" };
export const APPROVED_FOR_SESSION: ReviewDecision = {
  kind: "approved_for_session",
};
export const DENIED: ReviewDecision = { kind: "denied" };
export const TIMED_OUT: ReviewDecision = { kind: "timed_out" };
export const ABORT: ReviewDecision = { kind: "abort" };

export function approvedExecpolicyAmendment(
  amendment: ExecPolicyAmendment,
): ReviewDecision {
  return {
    kind: "approved_execpolicy_amendment",
    proposed_execpolicy_amendment: amendment,
  };
}

export function networkPolicyAmendment(
  amendment: NetworkPolicyAmendment,
): ReviewDecision {
  return { kind: "network_policy_amendment", amendment };
}

// ─────────────────────────────────────────────────────────────────────
// Predicates.
// ─────────────────────────────────────────────────────────────────────

/**
 * Does the decision count as an allow (proceed with the tool call)?
 *
 * AgenC behavior: approvals come in three positive flavors —
 *   - `approved` (one-shot)
 *   - `approved_for_session` (cache for the rest of the session)
 *   - `approved_execpolicy_amendment` (persist a rule)
 *
 * `network_policy_amendment` is **not** a decision on the current
 * request; it's an out-of-band policy change. Whether the current
 * request proceeds depends on the action (allow/deny).
 */
export function reviewDecisionIsAllow(decision: ReviewDecision): boolean {
  switch (decision.kind) {
    case "approved":
    case "approved_for_session":
    case "approved_execpolicy_amendment":
      return true;
    case "network_policy_amendment":
      return decision.amendment.action === "allow";
    case "denied":
    case "timed_out":
    case "abort":
      return false;
    default: {
      const _exhaustive: never = decision;
      void _exhaustive;
      return false;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// Opaque string — stable telemetry labels.
// ─────────────────────────────────────────────────────────────────────

/**
 * Stable, PII-free string form of a decision. Ports codex runtime
 * `ReviewDecision::to_opaque_string()` (protocol.rs:3635-3653).
 *
 * These strings appear in metrics labels and logs. Do not rename or
 * the downstream dashboards break.
 */
export function reviewDecisionOpaqueString(decision: ReviewDecision): string {
  switch (decision.kind) {
    case "approved":
      return "approved";
    case "approved_for_session":
      return "approved_for_session";
    case "approved_execpolicy_amendment":
      return "approved_with_amendment";
    case "network_policy_amendment":
      return decision.amendment.action === "allow"
        ? "approved_with_network_policy_allow"
        : "denied_with_network_policy_deny";
    case "denied":
      return "denied";
    case "timed_out":
      return "timed_out";
    case "abort":
      return "abort";
    default: {
      const _exhaustive: never = decision;
      void _exhaustive;
      return "unknown";
    }
  }
}
