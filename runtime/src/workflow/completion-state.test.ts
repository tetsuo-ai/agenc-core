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
        completionContract: {
          taskClass: "scaffold_allowed",
          placeholdersAllowed: true,
          partialCompletionAllowed: true,
        },
      }),
    ).toBe("partial");
  });

  it("marks missing behavior harness as needs_verification when implementation progress exists", () => {
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
        verificationContract: {
          workspaceRoot: "/workspace",
          targetArtifacts: ["/workspace/src/shell.c"],
          acceptanceCriteria: [
            "Shell job-control behavior is verified with scenario coverage",
          ],
          completionContract: {
            taskClass: "artifact_only",
            placeholdersAllowed: false,
            partialCompletionAllowed: false,
          },
        },
      }),
    ).toBe("needs_verification");
  });

  it("uses the same completion semantics for planner and direct implementation when the workflow contract matches", () => {
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
      verificationContract: {
        workspaceRoot: "/workspace",
        targetArtifacts: ["/workspace/src/main.c"],
        verificationMode: "mutation_required" as const,
        completionContract: {
          taskClass: "artifact_only" as const,
          placeholdersAllowed: false,
          partialCompletionAllowed: false,
          placeholderTaxonomy: "implementation" as const,
        },
      },
      verifier: {
        performed: false,
        overall: "skipped" as const,
      },
    };

    expect(resolveWorkflowCompletionState(sharedInput)).toBe("completed");
    expect(
      resolveWorkflowCompletionState({
        ...sharedInput,
        verificationContract: {
          ...sharedInput.verificationContract,
          stepKind: "delegated_write",
        },
      }),
    ).toBe("completed");
  });

  it("keeps request-level multi-phase work partial when local verification passes but planner milestones remain", () => {
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
        verificationContract: {
          workspaceRoot: "/workspace",
          targetArtifacts: ["/workspace/src/main.c"],
          verificationMode: "mutation_required",
          requestCompletion: {
            requiredMilestones: [
              { id: "phase_1_impl", description: "Implement phase 1" },
              { id: "phase_2_verify", description: "Verify phase 2" },
            ],
          },
          completionContract: {
            taskClass: "build_required",
            placeholdersAllowed: false,
            partialCompletionAllowed: false,
            placeholderTaxonomy: "implementation",
          },
        },
        completedRequestMilestoneIds: ["phase_1_impl"],
        verifier: {
          performed: true,
          overall: "pass",
        },
      }),
    ).toBe("partial");
  });
});
