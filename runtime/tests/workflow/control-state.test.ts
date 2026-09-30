import { describe, expect, it } from "vitest";

import { WORKFLOW_PAUSE_PREFIX, workflowControlState } from "../../src/app-server/workflow/control-state.js";
import type { DurableRunEffect, DurableRunSuspension } from "../../src/state/run-durability.js";

const RUN_ID = "goal-1";
const REQUESTED_AT = "2026-09-30T10:00:00.000Z";
const PAUSED_AT = "2026-09-30T10:00:05.000Z";

function effect(overrides: {
  readonly stepId: string;
  readonly toolName?: string;
  readonly outcome?: DurableRunEffect["outcome"];
  readonly intentSequence: number;
  readonly resultSequence?: number;
  readonly callId?: string;
  readonly intentAt?: string;
}): DurableRunEffect {
  return {
    stepId: overrides.stepId,
    toolName: overrides.toolName ?? overrides.stepId,
    outcome: overrides.outcome,
    intentSequence: overrides.intentSequence,
    resultSequence: overrides.resultSequence,
    callId: overrides.callId ?? `call-${overrides.intentSequence}`,
    intentAt: overrides.intentAt ?? REQUESTED_AT,
  } as DurableRunEffect;
}

function pauseEffect(overrides: {
  readonly requestId: string;
  readonly intentSequence: number;
  readonly resultSequence?: number;
  readonly outcome?: DurableRunEffect["outcome"];
}): DurableRunEffect {
  return effect({
    stepId: `${WORKFLOW_PAUSE_PREFIX}${overrides.requestId}`,
    toolName: "workflow.control.pause",
    outcome: overrides.outcome,
    intentSequence: overrides.intentSequence,
    resultSequence: overrides.resultSequence,
    callId: overrides.requestId,
  });
}

function suspension(overrides: Partial<DurableRunSuspension> = {}): DurableRunSuspension {
  return {
    runId: RUN_ID,
    epoch: 1,
    eventId: overrides.eventId ?? "susp-1",
    reason: overrides.reason ?? "workflow_user_pause",
    suspendedAt: overrides.suspendedAt ?? PAUSED_AT,
    suspensionSequence: overrides.suspensionSequence ?? 1,
    resumeEventId: overrides.resumeEventId,
    resumeSequence: overrides.resumeSequence,
  } as DurableRunSuspension;
}

describe("workflowControlState", () => {
  it("is running when there is no pause request or active user pause", () => {
    expect(workflowControlState({
      runId: RUN_ID,
      effects: [effect({ stepId: "workflow.plan", outcome: "committed", intentSequence: 1, resultSequence: 2 })],
      suspensions: [suspension({ reason: "daemon_shutdown_idle" })],
      terminal: false,
    })).toEqual({ runId: RUN_ID, state: "running" });
  });

  it("projects pause_requested from the newest unconsumed pause effect", () => {
    expect(workflowControlState({
      runId: RUN_ID,
      effects: [
        pauseEffect({ requestId: "pause-old", intentSequence: 3 }),
        pauseEffect({ requestId: "pause-new", intentSequence: 5, resultSequence: 6, outcome: "committed" }),
        effect({
          stepId: "workflow.control.pause",
          toolName: "workflow.control.pause",
          intentSequence: 9,
        }),
      ],
      suspensions: [suspension({ resumeEventId: "resumed", resumeSequence: 4 })],
      terminal: false,
    })).toEqual({
      runId: RUN_ID,
      state: "pause_requested",
      requestId: "pause-new",
      requestedAt: REQUESTED_AT,
    });
  });

  it("projects paused with the latest completed stage after an unsettled user pause", () => {
    expect(workflowControlState({
      runId: RUN_ID,
      effects: [
        effect({ stepId: "workflow.intake", outcome: "committed", intentSequence: 1, resultSequence: 2 }),
        effect({ stepId: "workflow.plan#2", outcome: "committed", intentSequence: 3, resultSequence: 4 }),
        effect({ stepId: "workflow.implement", intentSequence: 5 }),
        pauseEffect({ requestId: "pause-1", intentSequence: 6 }),
      ],
      suspensions: [suspension({ eventId: "susp-active" })],
      terminal: false,
    })).toEqual({
      runId: RUN_ID,
      state: "paused",
      requestId: "pause-1",
      requestedAt: REQUESTED_AT,
      suspensionId: "susp-active",
      pausedAt: PAUSED_AT,
      afterStage: "workflow.plan#2",
    });
  });

  it("treats a terminal run as terminal even when a pause is still recorded", () => {
    expect(workflowControlState({
      runId: RUN_ID,
      effects: [pauseEffect({ requestId: "pause-1", intentSequence: 2 })],
      suspensions: [suspension()],
      terminal: true,
    })).toEqual({ runId: RUN_ID, state: "terminal" });
  });

  it("returns to running after a resume consumes the pause request", () => {
    expect(workflowControlState({
      runId: RUN_ID,
      effects: [pauseEffect({ requestId: "pause-1", intentSequence: 2, resultSequence: 3 })],
      suspensions: [suspension({ resumeEventId: "resumed", resumeSequence: 3 })],
      terminal: false,
    })).toEqual({ runId: RUN_ID, state: "running" });
  });
});
