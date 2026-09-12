import { describe, expect, it } from "vitest";
import {
  isWorkflowApprovalSession,
  markWorkflowApprovalSession,
  WorkflowApprovalFailure,
  workflowApprovalFailureCause,
  workflowApprovalFailureFromMetadata,
} from "../../src/permissions/approval-failure.js";

describe("workflow approval failure", () => {
  it("reconstructs failures only from denied or timed-out metadata", () => {
    expect(workflowApprovalFailureFromMetadata(null)).toBeUndefined();
    expect(workflowApprovalFailureFromMetadata({ decision: "approved", source: "user" })).toBeUndefined();
    expect(workflowApprovalFailureFromMetadata({ decision: "denied" })).toBeUndefined();

    const denied = workflowApprovalFailureFromMetadata({
      decision: "denied",
      source: "resolver",
      reason: "blocked",
    });
    expect(denied).toBeInstanceOf(WorkflowApprovalFailure);
    expect(denied?.stopReason).toBe("policy_denied");
    expect(denied?.message).toContain("blocked");

    const timeout = workflowApprovalFailureFromMetadata({
      decision: "timed_out",
      source: "user",
      reason: 12,
    });
    expect(timeout?.stopReason).toBe("approval_required");
    expect(timeout?.message).not.toMatch(/12/u);

    const defaultDeny = workflowApprovalFailureFromMetadata({
      decision: "denied",
      source: "default_deny",
    });
    expect(defaultDeny?.stopReason).toBe("approval_required");
  });

  it("walks nested causes without looping on cycles", () => {
    const failure = new WorkflowApprovalFailure({ decision: "denied", source: "resolver" });
    const wrapped = new Error("outer", { cause: new Error("mid", { cause: failure }) });
    expect(workflowApprovalFailureCause(wrapped)).toBe(failure);
    expect(workflowApprovalFailureCause(new Error("plain"))).toBeUndefined();
    expect(workflowApprovalFailureCause("string")).toBeUndefined();

    const cyclic = new Error("cycle");
    cyclic.cause = cyclic;
    expect(workflowApprovalFailureCause(cyclic)).toBeUndefined();
  });

  it("tracks workflow approval sessions until the mark is released", () => {
    const session = {};
    expect(isWorkflowApprovalSession(undefined)).toBe(false);
    expect(isWorkflowApprovalSession(session)).toBe(false);
    const release = markWorkflowApprovalSession(session);
    expect(isWorkflowApprovalSession(session)).toBe(true);
    release();
    expect(isWorkflowApprovalSession(session)).toBe(false);
  });
});
