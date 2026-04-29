import test from "node:test";
import assert from "node:assert/strict";

import { createWatchPlannerController } from "../../src/watch/agenc-watch-planner.mjs";

function createPlannerHarness() {
  const watchState = {
    sessionId: "sess-1",
    plannerDagPipelineId: null,
    plannerDagNote: null,
    plannerDagStatus: "idle",
    plannerDagUpdatedAt: 0,
    runPhase: "executing",
    runState: "running",
    activeRunStartedAtMs: 123,
  };
  const calls = [];
  const controller = createWatchPlannerController({
    watchState,
    plannerDagNodeCount: () => 2,
    sessionValuesMatch: (left, right) => left === right,
    hydratePlannerDagForLiveSession(input) {
      calls.push({ type: "hydrate", input });
    },
    ingestPlannerDag(payload) {
      calls.push({ type: "ingest", payload });
    },
    updatePlannerDagNode(input) {
      calls.push({ type: "update", input });
    },
    retirePlannerDagOpenNodes(status, note) {
      calls.push({ type: "retire", status, note });
    },
    sanitizeInlineText(value) {
      return String(value ?? "").trim();
    },
    describeToolStart(toolName) {
      return { title: `${toolName} started` };
    },
    describeToolResult(toolName, args, isError, result) {
      return { title: `${toolName} ${isError ? "failed" : "done"} ${String(result ?? "").trim()}`.trim() };
    },
  });
  return { controller, watchState, calls };
}

test("planner controller ignores mismatched session events", () => {
  const { controller, calls } = createPlannerHarness();

  const handled = controller.handlePlannerTraceEvent("planner_step_started", {
    sessionId: "other-session",
    stepName: "collect",
    tool: "system.bash",
  });

  assert.equal(handled, false);
  assert.equal(calls.length, 0);
});

test("planner controller updates nodes for started and finished steps", () => {
  const { controller, calls, watchState } = createPlannerHarness();

  assert.equal(
    controller.handlePlannerTraceEvent("planner_step_started", {
      sessionId: "sess-1",
      pipelineId: "pipe-1",
      stepName: "collect",
      tool: "system.bash",
      args: { command: "pwd" },
    }),
    true,
  );
  assert.equal(
    controller.handlePlannerTraceEvent("planner_step_finished", {
      sessionId: "sess-1",
      pipelineId: "pipe-1",
      stepName: "collect",
      tool: "system.bash",
      result: "ok",
    }),
    true,
  );

  assert.equal(watchState.plannerDagPipelineId, "pipe-1");
  assert.ok(
    calls.some((entry) => entry.type === "update" && entry.input.status === "running"),
  );
  assert.ok(
    calls.some((entry) => entry.type === "update" && entry.input.status === "completed"),
  );
});

test("planner controller closes the run on terminal planner completion", () => {
  const { controller, calls, watchState } = createPlannerHarness();

  controller.handlePlannerTraceEvent("planner_path_finished", {
    sessionId: "sess-1",
    stopReason: "completed",
    stopReasonDetail: "all done",
  });

  assert.equal(watchState.plannerDagStatus, "completed");
  assert.equal(watchState.runPhase, null);
  assert.equal(watchState.runState, "idle");
  assert.equal(watchState.activeRunStartedAtMs, null);
  assert.ok(
    calls.some((entry) => entry.type === "retire" && entry.status === "completed"),
  );
});

test("planner controller keeps truthful non-complete terminal states visible", () => {
  const { controller, calls, watchState } = createPlannerHarness();

  controller.handlePlannerTraceEvent("planner_path_finished", {
    sessionId: "sess-1",
    completionState: "needs_verification",
    stopReason: "completed",
    stopReasonDetail: "verification still required",
  });

  assert.equal(watchState.plannerDagStatus, "needs_verification");
  assert.equal(watchState.runPhase, null);
  assert.equal(watchState.runState, "needs_verification");
  assert.equal(watchState.activeRunStartedAtMs, null);
  assert.ok(
    calls.some(
      (entry) =>
        entry.type === "retire" && entry.status === "needs_verification",
    ),
  );
});

test("planner controller tracks plan lifecycle and approval completion", () => {
  const { controller, calls, watchState } = createPlannerHarness();

  assert.equal(
    controller.handlePlannerTraceEvent("plan_started", {
      turnId: "turn-1",
      planItemId: "plan-1",
      title: "Audit parity gaps",
    }),
    true,
  );
  assert.equal(
    controller.handlePlannerTraceEvent("plan_delta", {
      turnId: "turn-1",
      planItemId: "plan-1",
      delta: "1. Inspect OpenClaude renderer behavior\n",
    }),
    true,
  );
  assert.equal(
    controller.handlePlannerTraceEvent("plan_item_completed", {
      turnId: "turn-1",
      planItemId: "plan-1",
      finalText: "1. Inspect\n2. Patch\n3. Test",
    }),
    true,
  );

  assert.equal(watchState.plannerDagStatus, "planned");
  assert.equal(watchState.runPhase, "planning");
  assert.equal(watchState.runState, "needs_approval");
  assert.ok(
    calls.some(
      (entry) =>
        entry.type === "update" &&
        entry.input.stepName === "plan-1" &&
        entry.input.status === "running",
    ),
  );
  assert.ok(
    calls.some(
      (entry) =>
        entry.type === "update" &&
        entry.input.stepName === "plan-1" &&
        entry.input.status === "completed",
    ),
  );

  assert.equal(
    controller.handlePlannerTraceEvent("plan_approval_requested", {
      requestId: "approval-1",
      planLengthChars: 1234,
      allowedPromptCount: 1,
      planFilePath: "/tmp/agenc/plans/session.md",
    }),
    true,
  );
  assert.equal(watchState.plannerDagStatus, "blocked");
  assert.equal(watchState.runState, "needs_approval");
  assert.match(watchState.plannerDagNote, /awaiting user approval/);
  assert.match(watchState.plannerDagNote, /1234 chars/);

  assert.equal(
    controller.handlePlannerTraceEvent("plan_approval_completed", {
      requestId: "approval-1",
      outcome: "approved",
      durationMs: 25,
    }),
    true,
  );
  assert.equal(watchState.plannerDagStatus, "completed");
  assert.equal(watchState.runPhase, null);
  assert.equal(watchState.runState, "idle");
  assert.equal(watchState.activeRunStartedAtMs, null);
  assert.ok(
    calls.some((entry) => entry.type === "retire" && entry.status === "completed"),
  );
});

test("planner controller keeps rejected plan approval visible for revision", () => {
  const { controller, calls, watchState } = createPlannerHarness();

  assert.equal(
    controller.handlePlannerTraceEvent("plan_approval_completed", {
      requestId: "approval-2",
      outcome: "denied",
      feedback: "Add rollback details",
    }),
    true,
  );

  assert.equal(watchState.plannerDagStatus, "blocked");
  assert.equal(watchState.runPhase, "planning");
  assert.equal(watchState.runState, "planning");
  assert.match(watchState.plannerDagNote, /plan rejected/);
  assert.match(watchState.plannerDagNote, /Add rollback details/);
  assert.ok(
    calls.some(
      (entry) =>
        entry.type === "update" &&
        entry.input.tool === "ExitPlanMode" &&
        entry.input.status === "blocked",
    ),
  );
});

test("planner controller summarizes AskUserQuestion and verification states", () => {
  const { controller, calls, watchState } = createPlannerHarness();

  assert.equal(
    controller.handlePlannerTraceEvent("ask_user_question_requested", {
      toolInput: {
        questions: [
          {
            header: "Approach",
            question: "Which renderer should be ported?",
            options: [
              { label: "OpenClaude", description: "Match upstream" },
              { label: "Local", description: "Keep current" },
            ],
          },
        ],
      },
    }),
    true,
  );

  assert.equal(watchState.plannerDagStatus, "blocked");
  assert.equal(watchState.runState, "needs_answer");
  assert.match(watchState.plannerDagNote, /1 question/);
  assert.match(watchState.plannerDagNote, /Approach/);

  assert.equal(
    controller.handlePlannerTraceEvent("ask_user_question_answered", {
      answerSummary: "Use OpenClaude renderer semantics",
    }),
    true,
  );
  assert.equal(watchState.runState, "planning");

  assert.equal(
    controller.handlePlannerTraceEvent("verify_plan_execution_completed", {
      status: "failed",
      summary: "implementation missed the approval copy",
    }),
    true,
  );

  assert.equal(watchState.plannerDagStatus, "failed");
  assert.equal(watchState.runPhase, null);
  assert.equal(watchState.runState, "failed");
  assert.match(watchState.plannerDagNote, /verification failed/);
  assert.ok(
    calls.some(
      (entry) =>
        entry.type === "update" &&
        entry.input.tool === "VerifyPlanExecution" &&
        entry.input.status === "failed",
    ),
  );
});
