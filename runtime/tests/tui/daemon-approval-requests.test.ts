import { describe, expect, it } from "vitest";

import { DaemonApprovalRequests } from "../../src/tui/daemon-approval-requests.js";

describe("DaemonApprovalRequests", () => {
  it("settles permission decisions by requestId, then requestEventId, then callId", () => {
    const approvals = new DaemonApprovalRequests(8);
    const byRequest = approvals.begin({ callId: "req-1", toolCallId: "call-1" })!;
    const byEvent = approvals.begin({ callId: "req-2", toolCallId: "call-2" })!;
    const byCall = approvals.begin({ callId: "req-3" })!;

    expect(approvals.settleEvent("permission_decision", { requestId: "req-1" })).toBe(true);
    expect(byRequest.signal.aborted).toBe(true);
    expect(approvals.settleEvent("permission_decision", { requestEventId: "req-2" })).toBe(true);
    expect(byEvent.signal.aborted).toBe(true);
    expect(approvals.settleEvent("permission_decision", { callId: "req-3" })).toBe(true);
    expect(byCall.signal.aborted).toBe(true);
    expect(approvals.begin({ callId: "req-1" })).toBeUndefined();
  });

  it("prefers requestId over older identifiers on the same decision", () => {
    const approvals = new DaemonApprovalRequests(8);
    const target = approvals.begin({ callId: "req-target", toolCallId: "call-target" })!;
    const other = approvals.begin({ callId: "req-other", toolCallId: "call-other" })!;

    approvals.settleEvent("permission_decision", {
      requestId: "req-target",
      requestEventId: "req-other",
      callId: "req-other",
    });
    expect(target.signal.aborted).toBe(true);
    expect(other.signal.aborted).toBe(false);
  });

  it("fences tool completion to the same owner and known turn", () => {
    const approvals = new DaemonApprovalRequests(8);
    const parent = approvals.begin({
      callId: "parent-req",
      toolCallId: "shared-call",
      turnId: "turn-1",
    })!;
    const child = approvals.begin({
      callId: "child-req",
      toolCallId: "shared-call",
      sourceConversationId: "child",
      turnId: "turn-1",
    })!;

    approvals.settleEvent("tool_call_completed", { callId: "shared-call" }, "turn-2");
    expect(parent.signal.aborted).toBe(false);
    expect(child.signal.aborted).toBe(false);

    approvals.settleEvent("tool_call_completed", { callId: "shared-call" }, "turn-1");
    expect(parent.signal.aborted).toBe(true);
    expect(child.signal.aborted).toBe(false);
  });

  it("still settles older permission cards that never carried turn identity", () => {
    const approvals = new DaemonApprovalRequests(8);
    const legacy = approvals.begin({ callId: "legacy-req", toolCallId: "shared-call" })!;

    approvals.settleEvent("tool_call_completed", { callId: "shared-call" }, "turn-1");
    expect(legacy.signal.aborted).toBe(true);
  });

  it("forgets the oldest settled occurrence once the replay window fills", () => {
    const approvals = new DaemonApprovalRequests(2);
    for (const id of ["a", "b", "c"]) {
      expect(approvals.begin({ callId: id })).toBeDefined();
      approvals.settleEvent("permission_decision", { requestId: id });
    }

    expect(approvals.begin({ callId: "a" })).toBeDefined();
    expect(approvals.begin({ callId: "b" })).toBeUndefined();
    expect(approvals.begin({ callId: "c" })).toBeUndefined();
  });

  it("releases only the matching controller and refuses new cards after close", () => {
    const approvals = new DaemonApprovalRequests(4);
    const current = approvals.begin({ callId: "live" })!;
    expect(approvals.release("live", new AbortController())).toBe(false);
    expect(current.signal.aborted).toBe(false);
    expect(approvals.release("live", current)).toBe(true);

    approvals.begin({ callId: "closing" });
    approvals.close();
    expect(approvals.begin({ callId: "after-close" })).toBeUndefined();
    expect(approvals.settleEvent("permission_decision", { requestId: "closing" })).toBe(true);
  });
});
