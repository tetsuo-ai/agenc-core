import test from "node:test";
import assert from "node:assert/strict";

import {
  formatOpenClaudePlanApproval,
  openClaudePlanToolName,
} from "../../src/watch/agenc-watch-openclaude-plan-presenters.mjs";

test("openClaudePlanToolName recognizes OpenClaude plan tools across payload shapes", () => {
  assert.equal(openClaudePlanToolName({ toolName: "ExitPlanMode" }), "ExitPlanMode");
  assert.equal(openClaudePlanToolName({ action: "AskUserQuestion" }), "AskUserQuestion");
  assert.equal(
    openClaudePlanToolName({ permission: { tool: "VerifyPlanExecutionTool" } }),
    "VerifyPlanExecutionTool",
  );
  assert.equal(openClaudePlanToolName({ input: { toolName: "EnterPlanMode" } }), "EnterPlanMode");
  assert.equal(openClaudePlanToolName({ toolName: "system.bash" }), null);
});

test("formatOpenClaudePlanApproval renders EnterPlanMode copy", () => {
  const rendered = formatOpenClaudePlanApproval({
    requestId: "enter-1",
    toolName: "EnterPlanMode",
  });

  assert.equal(rendered?.title, "Enter Plan Mode?");
  assert.match(rendered?.body, /explore and design an implementation approach/);
  assert.match(rendered?.body, /No code changes will be made until you approve the plan/);
  assert.match(rendered?.body, /\/approve enter-1 yes/);
  assert.equal(rendered?.tone, "purple");
});

test("formatOpenClaudePlanApproval renders ExitPlanMode plans and allowed prompts", () => {
  const rendered = formatOpenClaudePlanApproval({
    requestId: "exit-1",
    toolName: "ExitPlanMode",
    input: {
      plan: "# Plan\n\n- Build the watch renderer.",
      planFilePath: "/tmp/PLAN.md",
      allowedPrompts: [
        { tool: "system.editFile", prompt: "runtime/src/watch only" },
      ],
    },
  });

  assert.equal(rendered?.title, "Plan Ready for Approval");
  assert.match(rendered?.body, /Build the watch renderer/);
  assert.match(rendered?.body, /Plan file: \/tmp\/PLAN\.md/);
  assert.match(rendered?.body, /system\.editFile: runtime\/src\/watch only/);
  assert.match(rendered?.body, /Reject to revise the plan/);
});

test("formatOpenClaudePlanApproval renders VerifyPlanExecutionTool verdicts", () => {
  const rendered = formatOpenClaudePlanApproval({
    toolName: "VerifyPlanExecutionTool",
    status: "blocked",
    summary: "Missing verification evidence.",
    criteria: ["tests pass", "TUI shows plan approval"],
    evidence: ["node --test failed"],
  });

  assert.equal(rendered?.title, "Verify Plan Execution: blocked");
  assert.match(rendered?.body, /Missing verification evidence/);
  assert.match(rendered?.body, /tests pass/);
  assert.match(rendered?.body, /node --test failed/);
  assert.equal(rendered?.tone, "amber");
});
