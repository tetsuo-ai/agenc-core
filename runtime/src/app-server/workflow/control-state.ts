import type { RunWorkflowControlState } from "../protocol/index.js";
import type { DurableRunEffect, DurableRunSuspension } from "../../state/run-durability.js";

export const WORKFLOW_PAUSE_PREFIX = "workflow.control.pause.";

/** Pure projection of journal-backed requests and same-epoch suspensions. */
export function workflowControlState(input: {
  readonly runId: string;
  readonly effects: readonly DurableRunEffect[];
  readonly suspensions: readonly DurableRunSuspension[];
  readonly terminal: boolean;
}): RunWorkflowControlState {
  if (input.terminal) return { runId: input.runId, state: "terminal" };
  const suspension = [...input.suspensions].reverse().find(item => item.reason === "workflow_user_pause");
  const resumedThrough = Math.max(0, ...input.suspensions.map(item => item.resumeSequence ?? 0));
  const request = input.effects.filter(effect => effect.stepId.startsWith(WORKFLOW_PAUSE_PREFIX)
    && effect.toolName === "workflow.control.pause" && (effect.outcome === "committed" || effect.outcome === undefined)
    && (effect.resultSequence ?? effect.intentSequence) > resumedThrough)
    .sort((a, b) => b.intentSequence - a.intentSequence)[0];
  const details = request === undefined ? {} : { requestId: request.callId, requestedAt: request.intentAt };
  if (suspension !== undefined && suspension.resumeEventId === undefined) {
    const stages = input.effects.filter(effect => /^workflow\.(intake|worktree|plan|implement|verify|review)(#\d+)?$/.test(effect.stepId)
      && effect.outcome !== undefined).sort((a,b) => (b.resultSequence ?? 0) - (a.resultSequence ?? 0));
    return { runId: input.runId, state: "paused", ...details,
      suspensionId: suspension.eventId, pausedAt: suspension.suspendedAt,
      ...(stages[0] !== undefined ? { afterStage: stages[0].stepId } : {}) };
  }
  return { runId: input.runId, state: request === undefined ? "running" : "pause_requested", ...details };
}
