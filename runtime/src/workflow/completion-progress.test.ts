import { describe, expect, it } from "vitest";
import {
  deriveWorkflowProgressSnapshot,
  mergeWorkflowProgressSnapshots,
} from "./completion-progress.js";

describe("completion-progress", () => {
  it("derives reusable verification evidence without adding verifier-only requirements", () => {
    const snapshot = deriveWorkflowProgressSnapshot({
      stopReason: "completed",
      completionState: "needs_verification",
      toolCalls: [
        {
          name: "system.bash",
          args: { command: "make test" },
          result: JSON.stringify({
            stdout: "ok",
            stderr: "",
            exitCode: 0,
            __agencVerification: {
              category: "build",
              repoLocal: true,
              command: "make test",
            },
          }),
          isError: false,
        },
      ],
      verificationContract: {
        workspaceRoot: "/workspace",
        targetArtifacts: ["/workspace/src/main.c"],
        verificationMode: "mutation_required",
        completionContract: {
          taskClass: "build_required",
          placeholdersAllowed: false,
          partialCompletionAllowed: false,
          placeholderTaxonomy: "implementation",
        },
      },
      updatedAt: 10,
    });

    expect(snapshot).toMatchObject({
      completionState: "needs_verification",
      satisfiedRequirements: ["build_verification"],
      remainingRequirements: [],
      reusableEvidence: [
        expect.objectContaining({
          requirement: "build_verification",
          summary: "make test",
        }),
      ],
    });
  });

  it("merges resumable progress without silently upgrading partial work to completed", () => {
    const previous = deriveWorkflowProgressSnapshot({
      stopReason: "completed",
      completionState: "needs_verification",
      toolCalls: [
        {
          name: "system.bash",
          args: { command: "ctest" },
          result: JSON.stringify({
            stdout: "ok",
            stderr: "",
            exitCode: 0,
            __agencVerification: {
              category: "build",
              repoLocal: true,
              command: "ctest",
            },
          }),
          isError: false,
        },
      ],
      verificationContract: {
        workspaceRoot: "/workspace",
        targetArtifacts: ["/workspace/src/main.c"],
        verificationMode: "mutation_required",
        completionContract: {
          taskClass: "build_required",
          placeholdersAllowed: false,
          partialCompletionAllowed: false,
          placeholderTaxonomy: "implementation",
        },
      },
      updatedAt: 5,
    });
    const next = {
      completionState: "completed" as const,
      stopReason: "completed" as const,
      requiredRequirements: ["workflow_verifier_pass"] as const,
      satisfiedRequirements: ["workflow_verifier_pass"] as const,
      remainingRequirements: [] as const,
      reusableEvidence: [] as const,
      updatedAt: 20,
      contractFingerprint: previous?.contractFingerprint,
    };

    const merged = mergeWorkflowProgressSnapshots({
      previous,
      next,
    });

    expect(merged).toMatchObject({
      completionState: "completed",
      satisfiedRequirements: expect.arrayContaining([
        "build_verification",
      ]),
      remainingRequirements: [],
    });
    expect(merged?.reusableEvidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          requirement: "build_verification",
          summary: "ctest",
        }),
      ]),
    );
  });

  it("produces the same progress requirements for equivalent direct and planner implementation contracts", () => {
    const direct = deriveWorkflowProgressSnapshot({
      stopReason: "completed",
      completionState: "needs_verification",
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
        verificationMode: "mutation_required",
        completionContract: {
          taskClass: "artifact_only",
          placeholdersAllowed: false,
          partialCompletionAllowed: false,
          placeholderTaxonomy: "implementation",
        },
      },
      updatedAt: 20,
    });
    const planner = deriveWorkflowProgressSnapshot({
      stopReason: "completed",
      completionState: "needs_verification",
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
        verificationMode: "mutation_required",
        stepKind: "delegated_write",
        completionContract: {
          taskClass: "artifact_only",
          placeholdersAllowed: false,
          partialCompletionAllowed: false,
          placeholderTaxonomy: "implementation",
        },
      },
      updatedAt: 20,
    });

    expect(direct).toMatchObject({
      requiredRequirements: [],
      remainingRequirements: [],
    });
    expect(planner).toMatchObject({
      requiredRequirements: [],
      remainingRequirements: [],
    });
  });

  it("reuses progress across equivalent direct and planner contracts even when step metadata differs", () => {
    const previous = deriveWorkflowProgressSnapshot({
      stopReason: "completed",
      completionState: "needs_verification",
      toolCalls: [
        {
          name: "system.bash",
          args: { command: "npm test" },
          result: JSON.stringify({
            stdout: "ok",
            stderr: "",
            exitCode: 0,
            __agencVerification: {
              category: "build",
              repoLocal: true,
              command: "npm test",
            },
          }),
          isError: false,
        },
      ],
      verificationContract: {
        workspaceRoot: "/workspace",
        targetArtifacts: ["/workspace/PLAN.md"],
        verificationMode: "mutation_required",
        completionContract: {
          taskClass: "artifact_only",
          placeholdersAllowed: false,
          partialCompletionAllowed: false,
          placeholderTaxonomy: "documentation",
        },
      },
      updatedAt: 10,
    });
    const next = deriveWorkflowProgressSnapshot({
      stopReason: "completed",
      completionState: "completed",
      toolCalls: [],
      verificationContract: {
        workspaceRoot: "/workspace",
        targetArtifacts: ["/workspace/PLAN.md"],
        verificationMode: "mutation_required",
        stepKind: "delegated_write",
        completionContract: {
          taskClass: "artifact_only",
          placeholdersAllowed: false,
          partialCompletionAllowed: false,
          placeholderTaxonomy: "documentation",
        },
      },
      updatedAt: 20,
    });

    const merged = mergeWorkflowProgressSnapshots({ previous, next });

    expect(merged).toMatchObject({
      completionState: "completed",
      satisfiedRequirements: expect.arrayContaining(["build_verification"]),
      remainingRequirements: [],
    });
  });

  it("drops prior verifier evidence when a new contract fingerprint targets a different task family", () => {
    const previous = deriveWorkflowProgressSnapshot({
      stopReason: "completed",
      completionState: "needs_verification",
      toolCalls: [
        {
          name: "system.bash",
          args: { command: "npm test" },
          result: JSON.stringify({
            stdout: "ok",
            stderr: "",
            exitCode: 0,
            __agencVerification: {
              category: "build",
              repoLocal: true,
              command: "npm test",
            },
          }),
          isError: false,
        },
      ],
      verificationContract: {
        workspaceRoot: "/workspace",
        targetArtifacts: ["/workspace/src/main.c"],
        verificationMode: "mutation_required",
        completionContract: {
          taskClass: "build_required",
          placeholdersAllowed: false,
          partialCompletionAllowed: false,
          placeholderTaxonomy: "implementation",
        },
      },
      updatedAt: 10,
    });
    const next = deriveWorkflowProgressSnapshot({
      stopReason: "completed",
      completionState: "completed",
      toolCalls: [
        {
          name: "system.writeFile",
          args: { path: "/workspace/PLAN.md" },
          result: JSON.stringify({ ok: true }),
          isError: false,
        },
      ],
      verificationContract: {
        workspaceRoot: "/workspace",
        targetArtifacts: ["/workspace/PLAN.md"],
        verificationMode: "mutation_required",
        completionContract: {
          taskClass: "artifact_only",
          placeholdersAllowed: false,
          partialCompletionAllowed: false,
          placeholderTaxonomy: "documentation",
        },
      },
      updatedAt: 20,
    });

    const merged = mergeWorkflowProgressSnapshots({ previous, next });

    expect(merged).toMatchObject({
      completionState: "completed",
      requiredRequirements: [],
      satisfiedRequirements: [],
      remainingRequirements: [],
    });
    expect(merged?.reusableEvidence).toEqual([]);
  });

  it("does not reuse verifier evidence when either snapshot is missing a contract fingerprint", () => {
    const previous = {
      ...deriveWorkflowProgressSnapshot({
        stopReason: "completed",
        completionState: "needs_verification",
        toolCalls: [
          {
            name: "system.bash",
            args: { command: "npm test" },
            result: JSON.stringify({
              stdout: "ok",
              stderr: "",
              exitCode: 0,
              __agencVerification: {
                category: "build",
                repoLocal: true,
                command: "npm test",
              },
            }),
            isError: false,
          },
        ],
        verificationContract: {
          workspaceRoot: "/workspace",
          targetArtifacts: ["/workspace/src/main.c"],
          verificationMode: "mutation_required",
          completionContract: {
            taskClass: "build_required",
            placeholdersAllowed: false,
            partialCompletionAllowed: false,
            placeholderTaxonomy: "implementation",
          },
        },
        updatedAt: 5,
      }),
      contractFingerprint: undefined,
    };
    const next = {
      completionState: "completed" as const,
      stopReason: "completed" as const,
      requiredRequirements: [] as const,
      satisfiedRequirements: [] as const,
      remainingRequirements: [] as const,
      reusableEvidence: [] as const,
      updatedAt: 15,
      contractFingerprint: undefined,
    };

    const merged = mergeWorkflowProgressSnapshots({ previous, next });

    expect(merged).toMatchObject({
      completionState: "completed",
      satisfiedRequirements: [],
      remainingRequirements: [],
    });
    expect(merged?.reusableEvidence).toEqual([]);
  });

  it("keeps reusable evidence but does not preserve verifier-only carryover when a later snapshot blocks", () => {
    const previous = deriveWorkflowProgressSnapshot({
      stopReason: "completed",
      completionState: "needs_verification",
      toolCalls: [
        {
          name: "system.bash",
          args: { command: "npm test" },
          result: JSON.stringify({
            stdout: "ok",
            stderr: "",
            exitCode: 0,
            __agencVerification: {
              category: "build",
              repoLocal: true,
              command: "npm test",
            },
          }),
          isError: false,
        },
      ],
      verificationContract: {
        workspaceRoot: "/workspace",
        targetArtifacts: ["/workspace/src/main.c"],
        verificationMode: "mutation_required",
        completionContract: {
          taskClass: "build_required",
          placeholdersAllowed: false,
          partialCompletionAllowed: false,
          placeholderTaxonomy: "implementation",
        },
      },
      updatedAt: 5,
    });
    const next = {
      completionState: "blocked" as const,
      stopReason: "validation_error" as const,
      stopReasonDetail: "Verification artifacts are still missing",
      requiredRequirements: [] as const,
      satisfiedRequirements: [] as const,
      remainingRequirements: [] as const,
      reusableEvidence: [] as const,
      updatedAt: 15,
      contractFingerprint: previous.contractFingerprint,
    };

    const merged = mergeWorkflowProgressSnapshots({
      previous,
      next,
    });

    expect(merged).toMatchObject({
      completionState: "blocked",
      remainingRequirements: [],
      stopReason: "validation_error",
      stopReasonDetail: "Verification artifacts are still missing",
    });
    expect(merged?.reusableEvidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          requirement: "build_verification",
          summary: "npm test",
        }),
      ]),
    );
  });

  it("tracks remaining request milestones separately from local verification requirements", () => {
    const snapshot = deriveWorkflowProgressSnapshot({
      stopReason: "completed",
      completionState: "partial",
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
        verificationMode: "mutation_required",
        requestCompletion: {
          requiredMilestones: [
            { id: "phase_1", description: "Finish phase 1" },
            { id: "phase_2", description: "Finish phase 2" },
          ],
        },
        completionContract: {
          taskClass: "artifact_only",
          placeholdersAllowed: false,
          partialCompletionAllowed: false,
          placeholderTaxonomy: "implementation",
        },
      },
      completedRequestMilestoneIds: ["phase_1"],
      updatedAt: 30,
    });

    expect(snapshot).toMatchObject({
      requiredRequirements: ["request_milestones"],
      remainingRequirements: ["request_milestones"],
      satisfiedMilestoneIds: ["phase_1"],
      remainingMilestones: [
        { id: "phase_2", description: "Finish phase 2" },
      ],
    });
  });
});
