import { describe, expect, test, afterEach } from "vitest";

import {
  buildPlanPromptPermissionUpdates,
  clearExitPlanModeApprovalsForTest,
  consumeExitPlanModeApproval,
  EXIT_PLAN_APPROVED_PLAN_ARG,
  exitPlanApprovedPlan,
  injectedExitPlanApprovedPlan,
  parseExitPlanAllowedPrompts,
  recordExitPlanModeApproval,
  samePlanText,
} from "../../src/planning/exit-plan-approval.js";

describe("exit plan approval helpers", () => {
  afterEach(() => clearExitPlanModeApprovalsForTest());

  test("parses only complete non-empty allowed prompt entries", () => {
    expect(
      parseExitPlanAllowedPrompts([
        { tool: " system.bash ", prompt: " npm test " },
        { tool: "", prompt: "missing tool" },
        { tool: "FileRead", prompt: "" },
        null,
        "bad",
      ]),
    ).toEqual([{ tool: "system.bash", prompt: "npm test" }]);
    expect(parseExitPlanAllowedPrompts({ tool: "system.bash" })).toEqual([]);
  });

  test("builds frozen session permission updates from allowed prompts", () => {
    const updates = buildPlanPromptPermissionUpdates([
      { tool: "system.bash", prompt: "npm test" },
      { tool: "FileRead", prompt: "inspect files" },
    ]);

    expect(updates).toEqual([
      {
        type: "addRules",
        destination: "session",
        behavior: "allow",
        rules: [
          { toolName: "system.bash", ruleContent: "npm test" },
          { toolName: "FileRead", ruleContent: "inspect files" },
        ],
      },
    ]);
    expect(Object.isFrozen(updates)).toBe(true);
    expect(Object.isFrozen(updates[0].rules)).toBe(true);
    expect(buildPlanPromptPermissionUpdates([])).toEqual([]);
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

  // Contract test #1: the record→consume round-trip the plan-approval UI relies
  // on. The choice recorded daemon-side under `requestId` must be consumable
  // under the tool's `__callId` (which equals requestId end-to-end), exactly
  // once, and the approve/revise mapping must survive untouched.
  test("plan-approval round-trip consumes the recorded approval exactly once", () => {
    const callId = "call-acceptEdits";
    recordExitPlanModeApproval(callId, {
      action: "approve",
      mode: "acceptEdits",
    });
    // __callId === the recorded requestId → consume finds it.
    expect(consumeExitPlanModeApproval({ __callId: callId })).toEqual({
      action: "approve",
      mode: "acceptEdits",
    });
    // Consumed: a second consume returns null (the record is deleted on take).
    expect(consumeExitPlanModeApproval({ __callId: callId })).toBeNull();

    // The revise mapping round-trips unchanged so execute() stays in plan mode.
    recordExitPlanModeApproval("call-revise", {
      action: "revise",
      feedback: "tighten the rollback step",
    });
    expect(consumeExitPlanModeApproval({ __callId: "call-revise" })).toEqual({
      action: "revise",
      feedback: "tighten the rollback step",
    });
  });

  test("exitPlanApprovedPlan keeps only a non-blank plan string", () => {
    expect(exitPlanApprovedPlan({})).toEqual({ plan: null });
    expect(exitPlanApprovedPlan({ plan: "   " })).toEqual({ plan: null });
    expect(exitPlanApprovedPlan({ plan: 12 })).toEqual({ plan: null });
    const shown = exitPlanApprovedPlan({ plan: "# Plan\n" });
    expect(shown).toEqual({ plan: "# Plan\n" });
    expect(Object.isFrozen(shown)).toBe(true);
  });

  test("injectedExitPlanApprovedPlan accepts only the hidden runtime snapshot", () => {
    const args: Record<string, unknown> = { plan: "model-supplied" };
    expect(injectedExitPlanApprovedPlan(args)).toBeUndefined();

    args[EXIT_PLAN_APPROVED_PLAN_ARG] = { plan: "enumerable" };
    expect(injectedExitPlanApprovedPlan(args)).toBeUndefined();

    Object.defineProperty(args, EXIT_PLAN_APPROVED_PLAN_ARG, {
      value: { plan: "# Shown\n" },
      enumerable: false,
      configurable: true,
    });
    expect(injectedExitPlanApprovedPlan(args)).toEqual({ plan: "# Shown\n" });

    Object.defineProperty(args, EXIT_PLAN_APPROVED_PLAN_ARG, {
      value: { plan: null },
      enumerable: false,
      configurable: true,
    });
    expect(injectedExitPlanApprovedPlan(args)).toEqual({ plan: null });

    Object.defineProperty(args, EXIT_PLAN_APPROVED_PLAN_ARG, {
      value: { plan: 1 },
      enumerable: false,
      configurable: true,
    });
    expect(injectedExitPlanApprovedPlan(args)).toBeUndefined();
  });

  test("samePlanText treats no plan and a blank plan as one thing", () => {
    expect(samePlanText(null, "")).toBe(true);
    expect(samePlanText(null, "   ")).toBe(true);
    expect(samePlanText("# Plan\n", "# Plan\n")).toBe(true);
    expect(samePlanText("# Plan\n", "# Plan\n- extra\n")).toBe(false);
    expect(samePlanText("# Plan", "# Plan ")).toBe(false);
    expect(samePlanText("# Plan\n", null)).toBe(false);
  });
});
