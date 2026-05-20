import { describe, expect, test, afterEach } from "vitest";

import {
  buildPlanPromptPermissionUpdates,
  clearExitPlanModeApprovalsForTest,
  consumeExitPlanModeApproval,
  parseExitPlanAllowedPrompts,
  recordExitPlanModeApproval,
  targetPermissionModeForPlanApproval,
} from "../../src/planning/exit-plan-approval.js";

describe("exit plan approval helpers", () => {
  afterEach(() => clearExitPlanModeApprovalsForTest());

  test("parses only complete non-empty allowed prompt entries", () => {
    expect(
      parseExitPlanAllowedPrompts([
        { tool: " Bash ", prompt: " npm test " },
        { tool: "", prompt: "missing tool" },
        { tool: "Read", prompt: "" },
        null,
        "bad",
      ]),
    ).toEqual([{ tool: "Bash", prompt: "npm test" }]);
    expect(parseExitPlanAllowedPrompts({ tool: "Bash" })).toEqual([]);
  });

  test("builds frozen session permission updates from allowed prompts", () => {
    const updates = buildPlanPromptPermissionUpdates([
      { tool: "Bash", prompt: "npm test" },
      { tool: "Read", prompt: "inspect files" },
    ]);

    expect(updates).toEqual([
      {
        type: "addRules",
        destination: "session",
        behavior: "allow",
        rules: [
          { toolName: "Bash", ruleContent: "npm test" },
          { toolName: "Read", ruleContent: "inspect files" },
        ],
      },
    ]);
    expect(Object.isFrozen(updates)).toBe(true);
    expect(Object.isFrozen(updates[0].rules)).toBe(true);
    expect(buildPlanPromptPermissionUpdates([])).toEqual([]);
  });

  test("maps approval mode requests back to permission modes", () => {
    expect(targetPermissionModeForPlanApproval("acceptEdits", "plan")).toBe("acceptEdits");
    expect(targetPermissionModeForPlanApproval("bypassPermissions", "plan")).toBe("bypassPermissions");
    expect(targetPermissionModeForPlanApproval("auto", "plan")).toBe("auto");
    expect(targetPermissionModeForPlanApproval("default", "acceptEdits")).toBe("acceptEdits");
    expect(targetPermissionModeForPlanApproval(undefined, "plan")).toBe("default");
    expect(targetPermissionModeForPlanApproval(undefined, undefined)).toBe("default");
  });

  test("records, consumes, and clears approvals by call id", () => {
    const approval = { action: "approve" as const, plan: "ship it" };

    recordExitPlanModeApproval("", approval);
    expect(consumeExitPlanModeApproval({ __callId: "" })).toBeNull();

    recordExitPlanModeApproval("call-1", approval);
    expect(consumeExitPlanModeApproval({ __callId: 42 })).toBeNull();
    expect(consumeExitPlanModeApproval({ __callId: "call-1" })).toEqual(approval);
    expect(consumeExitPlanModeApproval({ __callId: "call-1" })).toBeNull();

    recordExitPlanModeApproval("call-2", { action: "revise", feedback: "change tests" });
    clearExitPlanModeApprovalsForTest();
    expect(consumeExitPlanModeApproval({ __callId: "call-2" })).toBeNull();
  });
});
