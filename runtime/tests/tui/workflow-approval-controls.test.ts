import { describe, expect, it, vi } from "vitest";
import { createWorkflowApprovalControls } from "../../src/tui/workflow-approval-controls.js";
import type { PendingToolApproval } from "../../src/app-server/protocol/index.js";
import type { AgenCDaemonTuiClient } from "../../src/tui/daemon-session.js";
import { setPlanApprovalChoice, takePlanApprovalChoice } from "../../src/tui/plan-approval-choice.js";
import { APPROVED, APPROVED_FOR_SESSION, DENIED, ABORT } from "../../src/permissions/review-decision.js";
import { createDaemonTuiSessionFixture } from "../helpers/daemon-tui-session.js";

const pending: PendingToolApproval = {
  ownerRunId: "wf-owner",
  sessionId: "child-one",
  requestId: "opaque-request",
  toolName: "exec_command",
  input: { command: "node --test" },
};

function fixture(requests: readonly PendingToolApproval[] = [pending]) {
  const request = vi.fn(async (method: string) => method === "permission.list"
    ? { permissions: [], pendingRequests: requests }
    : { requestId: pending.requestId, decision: "approved" });
  return {
    request,
    controls: createWorkflowApprovalControls({ request } as unknown as AgenCDaemonTuiClient),
    signal: new AbortController().signal,
  };
}

describe("workflow approval transport", () => {
  it("uses the captured daemon connection through the production TUI bridge", async () => {
    const { request, signal } = fixture();
    const bridge = createDaemonTuiSessionFixture({
      baseSession: { conversationId: "unrelated-active-session", services: {} },
      sessionId: "active-daemon-session",
      clientId: "tui-client",
      client: { request, subscribeToSessionEvents: () => () => {} } as unknown as AgenCDaemonTuiClient,
    });
    const activeSessionId = bridge.conversationId;
    expect(activeSessionId).toBe("active-daemon-session");
    expect(await bridge.workflowApprovalControls.list("wf-owner", signal)).toEqual([pending]);
    expect(request).toHaveBeenCalledWith("permission.list", { sessionId: "wf-owner" }, { signal });
    expect(bridge.conversationId).toBe(activeSessionId);
  });

  it.each([APPROVED, APPROVED_FOR_SESSION, DENIED])("routes $kind to the workflow owner, never the active or child session", async (decision) => {
    const { controls, request, signal } = fixture();
    expect(await controls.respond(pending, decision, "response", signal)).toBe(true);
    expect(request.mock.calls[0]).toEqual(["permission.list", { sessionId: "wf-owner" }, { signal }]);
    expect(request.mock.calls[1]?.[1]).toMatchObject({ sessionId: "wf-owner", requestId: "opaque-request" });
    expect(request.mock.calls[1]?.[0]).toBe(decision.kind === "denied" ? "tool.deny" : "tool.approve");
  });

  it.each([
    [{ ...pending, ownerRunId: "wf-other" }],
    [pending, pending],
  ])("rejects wrong-owner or duplicate snapshots without a decision", async (...requests) => {
    const { controls, request, signal } = fixture(requests);
    await expect(controls.list("wf-owner", signal)).rejects.toThrow("inconsistent");
    expect(request).toHaveBeenCalledOnce();
  });

  it.each([[], [{ ...pending, input: { command: "rm -rf /workspace" } }], [{ ...pending, sessionId: "another-child" }]])("does not decide a stale or changed request", async (...requests) => {
    const { controls, request, signal } = fixture(requests);
    expect(await controls.respond(pending, APPROVED, "response", signal)).toBe(false);
    expect(request).toHaveBeenCalledOnce();
  });

  it("dismissal and cancelled panels send no RPC", async () => {
    const { controls, request, signal } = fixture();
    expect(await controls.respond(pending, ABORT, "response", signal)).toBe(false);
    expect(await controls.respond(pending, APPROVED, "response", AbortSignal.abort())).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });

  it("rechecks cancellation after a pending-list response", async () => {
    const controller = new AbortController();
    const { controls, request } = fixture();
    request.mockImplementationOnce(async () => {
      controller.abort();
      return { permissions: [], pendingRequests: [pending] };
    });
    await expect(controls.respond(pending, APPROVED, "response", controller.signal)).rejects.toThrow();
    expect(request).toHaveBeenCalledOnce();
  });

  it("serializes duplicate decisions and uses only the matching modal response key", async () => {
    const plan = { ...pending, toolName: "ExitPlanMode" };
    const { controls, request, signal } = fixture([plan]);
    setPlanApprovalChoice("matching", { action: "approve", mode: "default" });
    setPlanApprovalChoice("unrelated", { action: "approve", mode: "acceptEdits" });
    const first = controls.respond(plan, APPROVED, "matching", signal);
    const duplicate = controls.respond(plan, APPROVED, "duplicate", signal);
    expect(await first).toBe(true);
    expect(await duplicate).toBe(false);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]?.[1]).toMatchObject({ exitPlan: { action: "approve", mode: "default" } });
    expect(takePlanApprovalChoice("unrelated")).toEqual({ action: "approve", mode: "acceptEdits" });
  });
});
