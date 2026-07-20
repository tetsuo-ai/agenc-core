import { describe, expect, it } from "vitest";

import type { DurableRunEffect } from "../../src/state/run-durability.js";
import {
  deriveStageProjection,
  finalizeIdempotencyKey,
  intakeIdempotencyKey,
  parseWorkflowStepId,
  stagePrerequisitesMet,
  stageStepId,
  verifyAgentStepId,
  verifyCommandIdempotencyKey,
  verifyCommandStepId,
  worktreeIdempotencyKey,
} from "../../src/app-server/workflow/steps.js";

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

describe("workflow step ids", () => {
  it("suffixes attempts and keeps the first attempt bare", () => {
    expect(stageStepId("workflow.implement", 1)).toBe("workflow.implement");
    expect(stageStepId("workflow.implement", 2)).toBe("workflow.implement#2");
    expect(verifyCommandStepId(3, 1)).toBe("workflow.verify.cmd.3");
    expect(verifyCommandStepId(3, 2)).toBe("workflow.verify.cmd.3#2");
    expect(verifyAgentStepId(1)).toBe("workflow.verify.agent");
    expect(verifyAgentStepId(4)).toBe("workflow.verify.agent#4");
  });

  it("rejects invalid attempts and indexes", () => {
    expect(() => stageStepId("workflow.plan", 0)).toThrow(RangeError);
    expect(() => verifyCommandStepId(0, 1)).toThrow(RangeError);
  });

  it("round-trips every generated id through the parser", () => {
    expect(parseWorkflowStepId("workflow.implement#2")).toEqual({
      stage: "workflow.implement",
      attempt: 2,
      role: "stage",
    });
    expect(parseWorkflowStepId("workflow.verify.cmd.3#2")).toEqual({
      stage: "workflow.verify",
      attempt: 2,
      role: "verify_command",
      commandIndex: 3,
    });
    expect(parseWorkflowStepId("workflow.verify.agent")).toEqual({
      stage: "workflow.verify",
      attempt: 1,
      role: "verify_agent",
    });
    expect(parseWorkflowStepId("workflow.intake")).toEqual({
      stage: "workflow.intake",
      attempt: 1,
      role: "stage",
    });
  });

  it("returns undefined for foreign or malformed step ids", () => {
    expect(parseWorkflowStepId("tool:turn-1:call-1")).toBeUndefined();
    expect(parseWorkflowStepId("workflow.unknown")).toBeUndefined();
    expect(parseWorkflowStepId("workflow.implement#1")).toBeUndefined();
    expect(parseWorkflowStepId("workflow.implement#x")).toBeUndefined();
    expect(parseWorkflowStepId("workflow.verify.cmd.x")).toBeUndefined();
  });
});

describe("workflow idempotency keys", () => {
  it("derives content-addressed keys per D3", () => {
    expect(intakeIdempotencyKey("sha256:abc")).toBe("sha256:abc");
    expect(worktreeIdempotencyKey("m5-run1", "deadbeef")).toBe(
      "m5-run1@deadbeef",
    );
    const commandKey = verifyCommandIdempotencyKey("npm test", "tree-1");
    expect(commandKey).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(commandKey).toBe(verifyCommandIdempotencyKey("npm test", "tree-1"));
    expect(commandKey).not.toBe(
      verifyCommandIdempotencyKey("npm test", "tree-2"),
    );
    const finalizeKey = finalizeIdempotencyKey("sha256:p", "base");
    expect(finalizeKey).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(finalizeKey).not.toBe(finalizeIdempotencyKey("sha256:q", "base"));
  });

  it("separates key domains so identical inputs cannot collide", () => {
    expect(verifyCommandIdempotencyKey("a", "b")).not.toBe(
      finalizeIdempotencyKey("a", "b"),
    );
  });
});

describe("deriveStageProjection", () => {
  it("is pending with zero attempts when the stage never began", () => {
    const projection = deriveStageProjection("workflow.plan", []);
    expect(projection).toMatchObject({
      status: "pending",
      attempts: 0,
      latestStepId: "workflow.plan",
    });
  });

  it("reports intent-without-result as running", () => {
    const projection = deriveStageProjection("workflow.plan", [
      effect("workflow.plan", undefined),
    ]);
    expect(projection.status).toBe("running");
    expect(projection.attempts).toBe(1);
  });

  it("projects only the latest attempt and counts attempts", () => {
    const projection = deriveStageProjection("workflow.implement", [
      effect("workflow.implement", "failed"),
      effect("workflow.implement#2", "committed", {
        stage: "workflow.implement",
        attempt: 2,
      }),
    ]);
    expect(projection.status).toBe("committed");
    expect(projection.attempts).toBe(2);
    expect(projection.latestStepId).toBe("workflow.implement#2");
    expect(projection.verdictPassed).toBe(true);
  });

  it("keeps the verify stage running until its agent row exists", () => {
    const projection = deriveStageProjection("workflow.verify", [
      effect("workflow.verify.cmd.1", "committed", {
        command: { exitCode: 0, timedOut: false },
      }),
    ]);
    expect(projection.status).toBe("running");
  });

  it("passes the verify verdict only for exit-0 commands plus VERDICT PASS", () => {
    const passing = deriveStageProjection("workflow.verify", [
      effect("workflow.verify.cmd.1", "committed", {
        command: { exitCode: 0, timedOut: false },
      }),
      effect("workflow.verify.agent", "committed", { verdict: "PASS" }),
    ]);
    expect(passing.status).toBe("committed");
    expect(passing.verdict).toBe("PASS");
    expect(passing.verdictPassed).toBe(true);

    const failingCommand = deriveStageProjection("workflow.verify", [
      effect("workflow.verify.cmd.1", "committed", {
        command: { exitCode: 1, timedOut: false },
      }),
      effect("workflow.verify.agent", "committed", { verdict: "PASS" }),
    ]);
    expect(failingCommand.verdictPassed).toBe(false);

    const failingVerdict = deriveStageProjection("workflow.verify", [
      effect("workflow.verify.cmd.1", "committed", {
        command: { exitCode: 0, timedOut: false },
      }),
      effect("workflow.verify.agent", "committed", { verdict: "FAIL" }),
    ]);
    expect(failingVerdict.verdictPassed).toBe(false);
  });

  it("maps review blockers to a rejected verdict", () => {
    const rejected = deriveStageProjection("workflow.review", [
      effect("workflow.review", "committed", {
        review: { blockerCount: 2 },
      }),
    ]);
    expect(rejected.verdict).toBe("rejected");
    expect(rejected.verdictPassed).toBe(false);

    const approved = deriveStageProjection("workflow.review", [
      effect("workflow.review", "committed", {
        review: { blockerCount: 0 },
      }),
    ]);
    expect(approved.verdict).toBe("approved");
    expect(approved.verdictPassed).toBe(true);
  });

  it("dominance order: running > unknown > cancelled > failed", () => {
    expect(
      deriveStageProjection("workflow.verify", [
        effect("workflow.verify.cmd.1", "failed"),
        effect("workflow.verify.agent", undefined),
      ]).status,
    ).toBe("running");
    expect(
      deriveStageProjection("workflow.verify", [
        effect("workflow.verify.cmd.1", "unknown_outcome"),
        effect("workflow.verify.agent", "failed"),
      ]).status,
    ).toBe("unknown_outcome");
  });
});

describe("stagePrerequisitesMet", () => {
  it("gates verify on a committed implement", () => {
    const withoutImplement = [
      effect("workflow.intake", "committed"),
      effect("workflow.worktree", "committed"),
      effect("workflow.plan", "committed"),
      effect("workflow.implement", "failed"),
    ];
    expect(stagePrerequisitesMet("workflow.verify", withoutImplement)).toBe(
      false,
    );
    const withImplement = [
      ...withoutImplement,
      effect("workflow.implement#2", "committed"),
    ];
    expect(stagePrerequisitesMet("workflow.verify", withImplement)).toBe(true);
  });

  it("gates review on a PASSING verify verdict, not just a committed one", () => {
    const base = [
      effect("workflow.intake", "committed"),
      effect("workflow.worktree", "committed"),
      effect("workflow.plan", "committed"),
      effect("workflow.implement", "committed"),
      effect("workflow.verify.cmd.1", "committed", {
        command: { exitCode: 0, timedOut: false },
      }),
    ];
    expect(
      stagePrerequisitesMet("workflow.review", [
        ...base,
        effect("workflow.verify.agent", "committed", { verdict: "FAIL" }),
      ]),
    ).toBe(false);
    expect(
      stagePrerequisitesMet("workflow.review", [
        ...base,
        effect("workflow.verify.agent", "committed", { verdict: "PASS" }),
      ]),
    ).toBe(true);
  });

  it("intake has no prerequisites", () => {
    expect(stagePrerequisitesMet("workflow.intake", [])).toBe(true);
  });
});
