import test from "node:test";
import assert from "node:assert/strict";

import { createWatchSubagentController } from "../../src/watch/agenc-watch-subagents.mjs";

function createSubagentHarness() {
  const watchState = {
    sessionId: "sess-1",
    activeSubagentProgressByParentToolCallId: new Map(),
    parentToolCallIdBySubagentSession: new Map(),
  };
  const recentSubagentLifecycleFingerprints = new Map();
  const subagentLiveActivity = new Map();
  const calls = [];
  const planSteps = new Map();

  function ensureStep(input = {}) {
    const key = `${input.stepName ?? "step"}|${input.subagentSessionId ?? "child"}`;
    if (!planSteps.has(key)) {
      planSteps.set(key, {
        stepName: input.stepName ?? null,
        objective: input.objective ?? null,
        subagentSessionId: input.subagentSessionId ?? null,
        status: "planned",
        note: "",
      });
    }
    return planSteps.get(key);
  }

  const controller = createWatchSubagentController({
    watchState,
    recentSubagentLifecycleFingerprints,
    subagentLiveActivity,
    resetDelegatedWatchState(state) {
      state.resetCalled = true;
    },
    plannerDagNodeCount: () => 2,
    hydratePlannerDagForLiveSession(input) {
      calls.push({ type: "hydrate", input });
    },
    updateSubagentPlanStep(input) {
      const step = ensureStep(input);
      if (input.status) {
        step.status = input.status;
      }
      if (input.note) {
        step.note = String(input.note);
      }
      calls.push({ type: "updateStep", input });
      return step;
    },
    ensureSubagentPlanStep(input) {
      return ensureStep(input);
    },
    planStepDisplayName(step) {
      return step.stepName || "Delegated child";
    },
    compactSessionToken(value) {
      return String(value ?? "").slice(0, 6);
    },
    sanitizeInlineText(value) {
      return String(value ?? "").trim();
    },
    truncate(value) {
      return String(value ?? "");
    },
    pushEvent(kind, title, body, tone, metadata) {
      calls.push({ type: "event", kind, title, body, tone, metadata });
    },
    setTransientStatus(status) {
      calls.push({ type: "status", status });
    },
    requestRunInspect(reason) {
      calls.push({ type: "inspect", reason });
    },
    describeToolStart(toolName) {
      return { title: `${toolName} start`, body: "tool body", tone: "yellow" };
    },
    describeToolResult(toolName) {
      return { title: `${toolName} done`, body: "tool result", tone: "green" };
    },
    descriptorEventMetadata(descriptor, metadata) {
      return { ...descriptor, ...metadata };
    },
    shouldSuppressToolTranscript() {
      return false;
    },
    shouldSuppressToolActivity() {
      return false;
    },
    rememberSubagentToolArgs(state, subagentSessionId, toolName, args) {
      calls.push({ type: "rememberArgs", subagentSessionId, toolName, args });
    },
    readSubagentToolArgs() {
      return { command: "pwd" };
    },
    clearSubagentToolArgs(state, subagentSessionId, toolName) {
      calls.push({ type: "clearArgs", subagentSessionId, toolName: toolName ?? null });
    },
    replaceLatestSubagentToolEvent() {
      return false;
    },
    clearSubagentHeartbeatEvents(subagentSessionId) {
      calls.push({ type: "clearHeartbeat", subagentSessionId });
    },
    compactPathForDisplay(value) {
      return value;
    },
    formatShellCommand(command) {
      return command ? String(command) : null;
    },
    currentDisplayObjective(value) {
      return value;
    },
    backgroundToolSurfaceLabel(toolName) {
      return `tool ${toolName}`;
    },
    retirePlannerDagOpenNodes(status, note) {
      calls.push({ type: "retireDagNodes", status, note });
    },
    firstMeaningfulLine(value) {
      return typeof value === "string" ? value.split("\n").find(Boolean) ?? null : null;
    },
    tryPrettyJson(value) {
      return JSON.stringify(value);
    },
  });

  return {
    controller,
    watchState,
    calls,
    subagentLiveActivity,
  };
}

test("subagent controller resets delegated watch state through the extracted seam", () => {
  const { controller, watchState } = createSubagentHarness();

  controller.resetDelegationState();

  assert.equal(watchState.resetCalled, true);
});

test("subagent controller ignores duplicate lifecycle events", () => {
  const { controller, calls } = createSubagentHarness();
  const payload = {
    subagentSessionId: "child-1",
    traceId: "trace-1",
    data: {
      stepName: "collect",
      objective: "inspect repo",
    },
  };

  assert.equal(controller.handleSubagentLifecycleMessage("subagents.started", payload), true);
  assert.equal(controller.handleSubagentLifecycleMessage("subagents.started", payload), true);

  assert.equal(
    calls.filter((entry) => entry.type === "event" && entry.kind === "subagent").length,
    1,
  );
});

test("subagent controller records tool activity and inspect requests", () => {
  const { controller, calls, subagentLiveActivity } = createSubagentHarness();

  controller.handleSubagentLifecycleMessage("subagents.tool.executing", {
    subagentSessionId: "child-1",
    toolName: "system.bash",
    data: {
      stepName: "collect",
      objective: "inspect repo",
      args: { command: "pwd" },
    },
  });

  assert.equal(subagentLiveActivity.get("child-1"), "system.bash start");
  assert.ok(calls.some((entry) => entry.type === "rememberArgs"));
  assert.ok(calls.some((entry) => entry.type === "inspect" && entry.reason === "subagents.tool.executing"));
  assert.ok(
    calls.some((entry) => entry.type === "event" && entry.kind === "subagent tool"),
  );
});

test("subagent controller preserves rich completion truth on synthesized results", () => {
  const { controller, calls } = createSubagentHarness();

  controller.handleSubagentLifecycleMessage("subagents.synthesized", {
    subagentSessionId: "child-2",
    data: {
      stepName: "verify",
      objective: "finish verification",
      completionState: "needs_verification",
      stopReason: "completed",
      stopReasonDetail: "workflow verifier still required",
      toolCalls: 2,
    },
  });

  assert.ok(
    calls.some(
      (entry) =>
        entry.type === "updateStep" &&
        entry.input.status === "needs_verification",
    ),
  );
  assert.ok(
    calls.some(
      (entry) =>
        entry.type === "retireDagNodes" &&
        entry.status === "needs_verification" &&
        entry.note === "workflow verifier still required",
    ),
  );
  assert.ok(
    calls.some(
      (entry) =>
        entry.type === "status" &&
        entry.status === "child synthesis: needs verification",
    ),
  );
  assert.ok(
    calls.some(
      (entry) =>
        entry.type === "event" &&
        entry.kind === "subagent" &&
        entry.body.includes("completion state: needs verification"),
    ),
  );
});

test("subagent controller upserts activeSubagentProgress keyed by parentToolCallId", () => {
  const { controller, watchState } = createSubagentHarness();

  controller.handleSubagentLifecycleMessage("subagents.progress", {
    subagentSessionId: "child-prog-1",
    data: {
      parentToolCallId: "parent-call-xyz",
      progress: {
        toolUseCount: 3,
        tokenCount: 4200,
        lastToolName: "system.bash",
        recentActivities: [{ toolName: "system.bash", ts: 1 }],
        elapsedMs: 900,
      },
    },
  });

  const entry = controller.getActiveSubagentProgress("parent-call-xyz");
  assert.ok(entry);
  assert.equal(entry.toolUseCount, 3);
  assert.equal(entry.lastToolName, "system.bash");
  assert.equal(entry.subagentSessionId, "child-prog-1");
  assert.equal(
    watchState.parentToolCallIdBySubagentSession.get("child-prog-1"),
    "parent-call-xyz",
  );
});

test("subagent controller clears activeSubagentProgress on terminal events", () => {
  const { controller } = createSubagentHarness();

  controller.handleSubagentLifecycleMessage("subagents.progress", {
    subagentSessionId: "child-term",
    data: {
      parentToolCallId: "parent-call-term",
      progress: {
        toolUseCount: 1,
        tokenCount: 10,
        lastToolName: "system.stat",
        recentActivities: [],
        elapsedMs: 5,
      },
    },
  });
  assert.ok(controller.getActiveSubagentProgress("parent-call-term"));

  controller.handleSubagentLifecycleMessage("subagents.completed", {
    subagentSessionId: "child-term",
    data: { output: "done" },
  });
  assert.equal(controller.getActiveSubagentProgress("parent-call-term"), null);
});

test("subagent controller ignores progress events without parentToolCallId", () => {
  const { controller } = createSubagentHarness();

  controller.handleSubagentLifecycleMessage("subagents.progress", {
    subagentSessionId: "child-heartbeat",
    data: {
      // heartbeat-only emit (no progress object, no parentToolCallId)
      elapsedMs: 500,
      objective: "wait",
    },
  });

  assert.equal(controller.getActiveSubagentProgress("parent-nope"), null);
});
