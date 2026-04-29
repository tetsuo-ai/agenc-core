import { describe, expect, test } from "vitest";
import {
  APPROVED,
  APPROVED_FOR_SESSION,
  ABORT,
  DENIED,
  TIMED_OUT,
  approvedExecpolicyAmendment,
  networkPolicyAmendment,
  reviewDecisionIsAllow,
  reviewDecisionOpaqueString,
  type ReviewDecision,
} from "./review-decision.js";

describe("ReviewDecision — 7 tagged variants", () => {
  test("constructors produce the right kinds", () => {
    expect(APPROVED).toEqual({ kind: "approved" });
    expect(APPROVED_FOR_SESSION).toEqual({ kind: "approved_for_session" });
    expect(DENIED).toEqual({ kind: "denied" });
    expect(TIMED_OUT).toEqual({ kind: "timed_out" });
    expect(ABORT).toEqual({ kind: "abort" });
  });

  test("approvedExecpolicyAmendment carries the opaque payload", () => {
    const amendment = { rule: "allow-cargo-test" } as const;
    const d = approvedExecpolicyAmendment(amendment);
    expect(d.kind).toBe("approved_execpolicy_amendment");
    if (d.kind === "approved_execpolicy_amendment") {
      expect(d.proposed_execpolicy_amendment).toBe(amendment);
    }
  });

  test("networkPolicyAmendment round-trips host rule", () => {
    const d = networkPolicyAmendment({
      action: "deny",
      host: "evil.example",
      port: 443,
    });
    expect(d.kind).toBe("network_policy_amendment");
    if (d.kind === "network_policy_amendment") {
      expect(d.amendment).toEqual({
        action: "deny",
        host: "evil.example",
        port: 443,
      });
    }
  });
});

describe("reviewDecisionIsAllow", () => {
  test("all approve-shaped decisions → true", () => {
    expect(reviewDecisionIsAllow(APPROVED)).toBe(true);
    expect(reviewDecisionIsAllow(APPROVED_FOR_SESSION)).toBe(true);
    expect(
      reviewDecisionIsAllow(approvedExecpolicyAmendment({ rule: "x" })),
    ).toBe(true);
  });

  test("all deny-shaped decisions → false", () => {
    expect(reviewDecisionIsAllow(DENIED)).toBe(false);
    expect(reviewDecisionIsAllow(TIMED_OUT)).toBe(false);
    expect(reviewDecisionIsAllow(ABORT)).toBe(false);
  });

  test("network policy amendment tracks the action field", () => {
    const allow: ReviewDecision = networkPolicyAmendment({
      action: "allow",
      host: "ok.example",
    });
    const deny: ReviewDecision = networkPolicyAmendment({
      action: "deny",
      host: "blocked.example",
    });
    expect(reviewDecisionIsAllow(allow)).toBe(true);
    expect(reviewDecisionIsAllow(deny)).toBe(false);
  });
});

describe("reviewDecisionOpaqueString — stable telemetry labels", () => {
  test("approved → 'approved'", () => {
    expect(reviewDecisionOpaqueString(APPROVED)).toBe("approved");
  });

  test("approved_for_session → 'approved_for_session'", () => {
    expect(reviewDecisionOpaqueString(APPROVED_FOR_SESSION)).toBe(
      "approved_for_session",
    );
  });

  test("approved_execpolicy_amendment → 'approved_with_amendment'", () => {
    expect(
      reviewDecisionOpaqueString(approvedExecpolicyAmendment({ rule: "y" })),
    ).toBe("approved_with_amendment");
  });

  test("network_policy_amendment splits by action", () => {
    expect(
      reviewDecisionOpaqueString(
        networkPolicyAmendment({ action: "allow", host: "a.example" }),
      ),
    ).toBe("approved_with_network_policy_allow");
    expect(
      reviewDecisionOpaqueString(
        networkPolicyAmendment({ action: "deny", host: "b.example" }),
      ),
    ).toBe("denied_with_network_policy_deny");
  });

  test("denied / timed_out / abort → stable strings", () => {
    expect(reviewDecisionOpaqueString(DENIED)).toBe("denied");
    expect(reviewDecisionOpaqueString(TIMED_OUT)).toBe("timed_out");
    expect(reviewDecisionOpaqueString(ABORT)).toBe("abort");
  });
});
