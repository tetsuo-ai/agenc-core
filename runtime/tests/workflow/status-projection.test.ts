import { describe, expect, it } from "vitest";

import type {
  DurableRunEffect,
  DurableRunTerminalRecord,
} from "../../src/state/run-durability.js";
import { projectWorkflowStatus } from "../../src/app-server/workflow/status-projection.js";

let seq = 0;
function effect(
  stepId: string,
  outcome: DurableRunEffect["outcome"] | undefined,
  evidence?: unknown,
): DurableRunEffect {
  seq += 1;
  return {
    runId: "run-1",
    stepId,
    epoch: 1,
    sessionId: "session-1",
    callId: stepId,
    toolName: stepId,
    recoveryCategory: "idempotent",
    intentDigest: `sha256:${stepId}`,
    intentEventId: `evt-${seq}`,
    intentSequence: seq,
    intentAt: "2026-07-20T00:00:00.000Z",
    ...(outcome !== undefined ? { outcome } : {}),
    ...(evidence !== undefined ? { evidence } : {}),
    reviewStatus: "none",
  };
}

function terminal(
  status: DurableRunTerminalRecord["status"],
  stopReason: string | null,
): DurableRunTerminalRecord {
  return {
    runId: "run-1",
    epoch: 1,
    status,
    exitCode: status === "completed" ? 0 : 1,
    stopReason,
    finalMessage: null,
    usage: null,
    lastSequence: 99,
    finishedAt: "2026-07-20T01:00:00.000Z",
    eventId: "evt-terminal",
  };
}

const ARTIFACT = {
  step: { runId: "run-1", stepId: "workflow.finalize" },
  role: "patch" as const,
  digest: `sha256:${"a".repeat(64)}` as const,
  bytes: 10,
  storagePath: `cas://sha256/${"a".repeat(64)}`,
  recordedAt: "2026-07-20T00:30:00.000Z",
};

describe("projectWorkflowStatus", () => {
  it("emits one entry per fixed pipeline stage, in order", () => {
    const status = projectWorkflowStatus({ runId: "run-1", effects: [] });
    expect(status.steps.map((step) => step.stage)).toEqual([
      "workflow.intake",
      "workflow.worktree",
      "workflow.plan",
      "workflow.implement",
      "workflow.verify",
      "workflow.review",
      "workflow.finalize",
    ]);
    expect(status.steps.every((step) => step.status === "pending")).toBe(true);
    expect(status.terminal).toBeUndefined();
    expect(status.stopReason).toBeUndefined();
  });

  it("keeps downstream stages pending while a live run may still retry", () => {
    const status = projectWorkflowStatus({
      runId: "run-1",
      effects: [
        effect("workflow.intake", "committed"),
        effect("workflow.worktree", "committed"),
        effect("workflow.plan", "failed"),
      ],
    });
    expect(status.steps[2]).toMatchObject({ status: "failed", attempts: 1 });
    expect(status.steps[3].status).toBe("pending");
  });

  it("marks never-started stages blocked once a non-completed terminal exists", () => {
    const status = projectWorkflowStatus({
      runId: "run-1",
      effects: [
        effect("workflow.intake", "committed"),
        effect("workflow.worktree", "committed"),
        effect("workflow.plan", "failed"),
      ],
      terminal: terminal("failed", "step_retries_exhausted"),
    });
    expect(status.steps[3].status).toBe("blocked");
    expect(status.steps[6].status).toBe("blocked");
    expect(status.stopReason).toBe("step_retries_exhausted");
    expect(status.terminal).toMatchObject({
      status: "failed",
      stopReason: "step_retries_exhausted",
    });
  });

  it("surfaces attempts, verdicts, and artifact pointers", () => {
    const status = projectWorkflowStatus({
      runId: "run-1",
      effects: [
        effect("workflow.intake", "committed"),
        effect("workflow.worktree", "committed"),
        effect("workflow.plan", "committed"),
        effect("workflow.implement", "committed"),
        effect("workflow.verify.cmd.1", "committed", {
          command: { exitCode: 1, timedOut: false },
        }),
        effect("workflow.verify.agent", "committed", { verdict: "FAIL" }),
        effect("workflow.implement#2", "committed"),
        effect("workflow.verify.cmd.1#2", "committed", {
          command: { exitCode: 0, timedOut: false },
        }),
        effect("workflow.verify.agent#2", "committed", {
          verdict: "PASS",
          artifacts: [ARTIFACT],
        }),
      ],
    });
    const implement = status.steps[3];
    expect(implement).toMatchObject({
      stepId: "workflow.implement#2",
      attempts: 2,
      status: "committed",
    });
    const verify = status.steps[4];
    expect(verify).toMatchObject({
      stepId: "workflow.verify.agent#2",
      attempts: 2,
      status: "committed",
      verdict: "PASS",
    });
    expect(verify.artifacts).toEqual([ARTIFACT]);
  });

  it("passes only frozen workflow stop reasons through stopReason", () => {
    const custom = projectWorkflowStatus({
      runId: "run-1",
      effects: [effect("workflow.intake", "committed")],
      terminal: terminal("failed", "something_else"),
    });
    expect(custom.stopReason).toBeUndefined();
    expect(custom.terminal?.stopReason).toBe("something_else");
  });

  it("reports running for an intent-without-result step", () => {
    const status = projectWorkflowStatus({
      runId: "run-1",
      effects: [
        effect("workflow.intake", "committed"),
        effect("workflow.worktree", undefined),
      ],
    });
    expect(status.steps[1].status).toBe("running");
  });
});
