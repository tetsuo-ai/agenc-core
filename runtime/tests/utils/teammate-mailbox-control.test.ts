import { describe, expect, test } from "vitest";

import {
  createShutdownApprovedMessage,
  createShutdownRejectedMessage,
  createShutdownRequestMessage,
  isPlanApprovalRequest,
  isPlanApprovalResponse,
  isShutdownApproved,
  isShutdownRejected,
  isShutdownRequest,
  isStructuredProtocolMessage,
  isTeamPermissionUpdate,
} from "../../src/utils/teammateMailbox.js";

const PLAN_REQUEST = {
  type: "plan_approval_request",
  from: "worker-a",
  timestamp: "2026-09-30T10:00:00.000Z",
  planFilePath: "/tmp/plan.md",
  planContent: "# Plan\nDo the work.",
  requestId: "plan-1",
} as const;

const PLAN_RESPONSE = {
  type: "plan_approval_response",
  requestId: "plan-1",
  approved: true,
  timestamp: "2026-09-30T10:00:01.000Z",
} as const;

const TEAM_PERMISSION = {
  type: "team_permission_update",
  permissionUpdate: {
    type: "addRules",
    rules: [{ toolName: "system.bash", ruleContent: "ls" }],
    behavior: "allow",
    destination: "session",
  },
  directoryPath: "/workspace",
  toolName: "system.bash",
} as const;

describe("teammate mailbox shutdown and plan control", () => {
  test("round-trips shutdown request, approval, and rejection envelopes", () => {
    const request = createShutdownRequestMessage({
      requestId: "shut-1",
      from: "team-lead",
      reason: "task complete",
    });
    const approved = createShutdownApprovedMessage({
      requestId: "shut-1",
      from: "worker-a",
      paneId: "pane-1",
    });
    const rejected = createShutdownRejectedMessage({
      requestId: "shut-1",
      from: "worker-a",
      reason: "still writing",
    });

    expect(isShutdownRequest(JSON.stringify(request))).toEqual(request);
    expect(isShutdownApproved(JSON.stringify(approved))).toEqual(approved);
    expect(isShutdownRejected(JSON.stringify(rejected))).toEqual(rejected);
  });

  test("round-trips plan approval request and response used by the inbox poller", () => {
    expect(isPlanApprovalRequest(JSON.stringify(PLAN_REQUEST))).toEqual(
      PLAN_REQUEST,
    );
    expect(isPlanApprovalResponse(JSON.stringify(PLAN_RESPONSE))).toEqual(
      PLAN_RESPONSE,
    );
  });

  test("rejects plaintext, invalid JSON, cross-type envelopes, and incomplete control fields", () => {
    expect(isShutdownRequest("please shut down")).toBeNull();
    expect(isShutdownRequest("{not-json")).toBeNull();
    expect(
      isShutdownRequest(JSON.stringify({ type: "shutdown_approved" })),
    ).toBeNull();
    expect(
      isShutdownRequest(
        JSON.stringify({ type: "shutdown_request", requestId: "shut-1" }),
      ),
    ).toBeNull();

    expect(isPlanApprovalRequest("approve this plan")).toBeNull();
    expect(
      isPlanApprovalRequest(JSON.stringify({ type: "plan_approval_response" })),
    ).toBeNull();
    expect(
      isPlanApprovalRequest(
        JSON.stringify({ ...PLAN_REQUEST, planFilePath: 12 }),
      ),
    ).toBeNull();

    expect(isShutdownApproved("ok")).toBeNull();
    expect(isShutdownRejected(JSON.stringify({ type: "shutdown_request" }))).toBeNull();
    expect(
      isPlanApprovalResponse(JSON.stringify({ type: "plan_approval_request" })),
    ).toBeNull();
  });

  test("accepts a team permission broadcast and keeps it out of raw LLM context", () => {
    expect(isTeamPermissionUpdate(JSON.stringify(TEAM_PERMISSION))).toEqual(
      TEAM_PERMISSION,
    );
    expect(isTeamPermissionUpdate("allow bash")).toBeNull();
    expect(isTeamPermissionUpdate("{not-json")).toBeNull();
    expect(
      isTeamPermissionUpdate(JSON.stringify({ type: "permission_request" })),
    ).toBeNull();

    expect(isStructuredProtocolMessage(JSON.stringify(PLAN_REQUEST))).toBe(true);
    expect(isStructuredProtocolMessage(JSON.stringify(PLAN_RESPONSE))).toBe(true);
    expect(
      isStructuredProtocolMessage(
        JSON.stringify(createShutdownRequestMessage({
          requestId: "shut-1",
          from: "team-lead",
        })),
      ),
    ).toBe(true);
    expect(isStructuredProtocolMessage(JSON.stringify(TEAM_PERMISSION))).toBe(
      true,
    );
    expect(isStructuredProtocolMessage("worker finished the review")).toBe(
      false,
    );
  });
});
