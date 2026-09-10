import { describe, expect, test } from "vitest";
import { approvalResponseKey, bindApprovalResponseKey, clearApprovalResponseKey } from "../../src/permissions/approval-response-key.js";
import { consumeExitPlanModeApproval, recordExitPlanModeApproval } from "../../src/planning/exit-plan-approval.js";
import { recordAskUserQuestionResponse, takeAskUserQuestionUpdatedInput } from "../../src/tools/ask-user-question/tool.js";

describe("approval response identity", () => {
  test("identical child call IDs cannot consume each other's plan decisions", () => {
    const firstSession = {};
    const secondSession = {};
    const firstKey = bindApprovalResponseKey(firstSession, "shared-call");
    const secondKey = bindApprovalResponseKey(secondSession, "shared-call");
    expect(firstKey).not.toBe(secondKey);
    expect(bindApprovalResponseKey(firstSession, "shared-call")).toBe(firstKey);
    recordExitPlanModeApproval(firstKey, { action: "approve", mode: "default" });
    recordExitPlanModeApproval(secondKey, { action: "revise", feedback: "keep planning" });
    expect(consumeExitPlanModeApproval({ __callId: approvalResponseKey(firstSession, "shared-call") })).toMatchObject({ action: "approve", mode: "default" });
    expect(consumeExitPlanModeApproval({ __callId: approvalResponseKey(secondSession, "shared-call") })).toMatchObject({ action: "revise" });
    clearApprovalResponseKey(firstSession, "shared-call");
    clearApprovalResponseKey(secondSession, "shared-call");
  });

  test("cleanup drops both response types without consuming another session's entry", () => {
    const session = {};
    const key = bindApprovalResponseKey(session, "call");
    recordExitPlanModeApproval(key, { action: "approve" });
    recordAskUserQuestionResponse(key, { questions: [], answers: { choice: "yes" } });
    recordExitPlanModeApproval("call", { action: "revise" });
    clearApprovalResponseKey(session, "call");
    expect(consumeExitPlanModeApproval({ __callId: key })).toBeNull();
    expect(takeAskUserQuestionUpdatedInput(key)).toBeNull();
    expect(consumeExitPlanModeApproval({ __callId: "call" })).toMatchObject({ action: "revise" });
    expect(approvalResponseKey(session, "call")).toBe("call");
    clearApprovalResponseKey(session, "call");
  });
});
