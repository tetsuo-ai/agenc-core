import { describe, expect, it } from "vitest";

import {
  resolvePipelineCompletionState,
  resolveWorkflowCompletionState,
} from "./completion-state.js";

describe("completion-state", () => {
  it("marks failed pipelines with completed work as partial", () => {
    expect(
      resolvePipelineCompletionState({
        status: "failed",
        completedSteps: 2,
      }),
    ).toBe("partial");
  });

  it("marks halted pipelines as blocked", () => {
    expect(
      resolvePipelineCompletionState({
        status: "halted",
        completedSteps: 1,
      }),
    ).toBe("blocked");
  });

  it("marks partial progress honestly when execution stops after grounded work", () => {
    expect(
      resolveWorkflowCompletionState({
        stopReason: "validation_error",
        toolCalls: [
          {
            name: "system.writeFile",
            args: { path: "/workspace/README.md" },
            result: JSON.stringify({ ok: true }),
            isError: false,
          },
        ],
      }),
    ).toBe("partial");
  });

  it("marks missing behavior harness as partial when implementation progress exists", () => {
    expect(
      resolveWorkflowCompletionState({
        stopReason: "validation_error",
        validationCode: "missing_behavior_harness",
        toolCalls: [
          {
            name: "system.writeFile",
            args: { path: "/workspace/src/shell.c" },
            result: JSON.stringify({ ok: true }),
            isError: false,
          },
        ],
        requiresVerification: true,
        verificationSatisfied: false,
      }),
    ).toBe("partial");
  });

  it("uses the same completion semantics for planner and direct implementation when verification is not required", () => {
    const sharedInput = {
      stopReason: "completed",
      toolCalls: [
        {
          name: "system.writeFile",
          args: { path: "/workspace/src/main.c" },
            result: JSON.stringify({ ok: true }),
            isError: false,
          },
        ],
      requiresVerification: false,
      verificationSatisfied: false,
    };

    expect(resolveWorkflowCompletionState(sharedInput)).toBe("completed");
    expect(resolveWorkflowCompletionState({ ...sharedInput })).toBe("completed");
  });

  it("returns needs_verification when an implementation turn still requires verifier confirmation", () => {
    expect(
      resolveWorkflowCompletionState({
        stopReason: "completed",
        toolCalls: [
          {
            name: "system.writeFile",
            args: { path: "/workspace/src/runner.js" },
            result: JSON.stringify({ ok: true }),
            isError: false,
          },
        ],
        requiresVerification: true,
        verificationSatisfied: false,
      }),
    ).toBe("needs_verification");
  });

  it("keeps behavior-required work completed when verification is skipped on a normal turn", () => {
    expect(
      resolveWorkflowCompletionState({
        stopReason: "completed",
        toolCalls: [
          {
            name: "system.writeFile",
            args: { path: "/workspace/src/runner.js" },
            result: JSON.stringify({ ok: true }),
            isError: false,
          },
        ],
        requiresVerification: false,
        verificationSatisfied: false,
      }),
    ).toBe("completed");
  });

  it("keeps runtime-required work completed when verifier is skipped on a normal turn", () => {
    expect(
      resolveWorkflowCompletionState({
        stopReason: "completed",
        toolCalls: [
          {
            name: "system.writeFile",
            args: { path: "/workspace/src/runner.js" },
            result: JSON.stringify({ ok: true }),
            isError: false,
          },
        ],
        requiresVerification: false,
        verificationSatisfied: false,
      }),
    ).toBe("completed");
  });

  it("keeps request-level multi-phase work completed when planner milestones remain advisory", () => {
    expect(
      resolveWorkflowCompletionState({
        stopReason: "completed",
        toolCalls: [
          {
            name: "system.writeFile",
            args: { path: "/workspace/src/main.c" },
            result: JSON.stringify({ ok: true }),
            isError: false,
          },
          {
            name: "system.bash",
            args: { command: "ctest" },
            result: JSON.stringify({ stdout: "ok", stderr: "", exitCode: 0 }),
            isError: false,
          },
        ],
        requiresVerification: true,
        verificationSatisfied: true,
      }),
    ).toBe("completed");
  });

  it("does not downgrade a completed turn when verifier telemetry is red", () => {
    expect(
      resolveWorkflowCompletionState({
        stopReason: "completed",
        toolCalls: [
          {
            name: "system.writeFile",
            args: { path: "/workspace/src/main.c" },
            result: JSON.stringify({ ok: true }),
            isError: false,
          },
        ],
        requiresVerification: false,
        verificationSatisfied: false,
      }),
    ).toBe("completed");
  });
});
