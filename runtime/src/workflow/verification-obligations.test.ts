import { describe, expect, it } from "vitest";
import { deriveVerificationObligations } from "./verification-obligations.js";

describe("verification-obligations", () => {
  it("derives build and behavior requirements from an explicit completion contract", () => {
    const obligations = deriveVerificationObligations({
      workspaceRoot: "/tmp/project",
      requiredSourceArtifacts: ["/tmp/project/PLAN.md"],
      targetArtifacts: ["/tmp/project/src/main.c"],
      verificationMode: "mutation_required",
      completionContract: {
        taskClass: "behavior_required",
        placeholdersAllowed: false,
        partialCompletionAllowed: false,
      },
    });

    expect(obligations).toMatchObject({
      workspaceRoot: "/tmp/project",
      verificationMode: "mutation_required",
      requiresMutationEvidence: true,
      requiresSourceArtifactReads: true,
      requiresTargetAuthorization: true,
      requiresBuildVerification: true,
      requiresBehaviorVerification: true,
      requiresReviewVerification: false,
      placeholdersAllowed: false,
      partialCompletionAllowed: false,
      completionContract: {
        taskClass: "behavior_required",
        placeholdersAllowed: false,
        partialCompletionAllowed: false,
      },
    });
  });

  it("uses scaffold compatibility defaults for delegated scaffold steps", () => {
    const obligations = deriveVerificationObligations({
      workspaceRoot: "/tmp/project",
      targetArtifacts: ["/tmp/project/src"],
      stepKind: "delegated_scaffold",
      verificationMode: "mutation_required",
    });

    expect(obligations).toMatchObject({
      requiresMutationEvidence: true,
      placeholderTaxonomy: "scaffold",
      placeholdersAllowed: true,
      partialCompletionAllowed: true,
      completionContract: {
        taskClass: "scaffold_allowed",
        placeholdersAllowed: true,
        partialCompletionAllowed: true,
      },
    });
  });

  it("uses review compatibility defaults for delegated review steps", () => {
    const obligations = deriveVerificationObligations({
      workspaceRoot: "/tmp/project",
      requiredSourceArtifacts: ["/tmp/project/PLAN.md"],
      stepKind: "delegated_review",
      verificationMode: "grounded_read",
    });

    expect(obligations).toMatchObject({
      requiresMutationEvidence: false,
      requiresSourceArtifactReads: true,
      requiresBuildVerification: false,
      requiresBehaviorVerification: false,
      requiresReviewVerification: true,
      placeholderTaxonomy: "implementation",
      placeholdersAllowed: false,
      partialCompletionAllowed: false,
      completionContract: {
        taskClass: "review_required",
        placeholdersAllowed: false,
        partialCompletionAllowed: false,
      },
    });
  });

  it("treats behavior-like acceptance criteria as behavior verification requirements", () => {
    const obligations = deriveVerificationObligations({
      workspaceRoot: "/tmp/project",
      targetArtifacts: ["/tmp/project/src/shell.c"],
      acceptanceCriteria: [
        "Shell job-control behavior is verified with scenario coverage",
      ],
      verificationMode: "mutation_required",
      completionContract: {
        taskClass: "artifact_only",
        placeholdersAllowed: false,
        partialCompletionAllowed: false,
      },
    });

    expect(obligations).toMatchObject({
      requiresBuildVerification: true,
      requiresBehaviorVerification: true,
      placeholderTaxonomy: "implementation",
      completionContract: {
        taskClass: "artifact_only",
      },
    });
  });

  it("treats current-workspace alignment criteria as workspace inspection requirements", () => {
    const obligations = deriveVerificationObligations({
      workspaceRoot: "/tmp/project",
      requiredSourceArtifacts: ["/tmp/project/PLAN.md"],
      targetArtifacts: ["/tmp/project/PLAN.md"],
      acceptanceCriteria: [
        "PLAN.md reflects the current workspace layout and recent directory changes accurately.",
      ],
      verificationMode: "mutation_required",
      completionContract: {
        taskClass: "artifact_only",
        placeholdersAllowed: false,
        partialCompletionAllowed: false,
      },
    });

    expect(obligations).toMatchObject({
      requiresWorkspaceInspectionEvidence: true,
      requiresSourceArtifactReads: true,
      completionContract: {
        taskClass: "artifact_only",
      },
    });
  });

  it("waives local workspace inspection when upstream dependency evidence already satisfied it", () => {
    const obligations = deriveVerificationObligations({
      workspaceRoot: "/tmp/project",
      requiredSourceArtifacts: ["/tmp/project/PLAN.md"],
      targetArtifacts: ["/tmp/project/PLAN.md"],
      inheritedEvidence: {
        workspaceInspectionSatisfied: true,
        sourceSteps: ["qa_review", "layout_review"],
      },
      acceptanceCriteria: [
        "PLAN.md reflects the current workspace layout and recent directory changes accurately.",
      ],
      verificationMode: "mutation_required",
      completionContract: {
        taskClass: "artifact_only",
        placeholdersAllowed: false,
        partialCompletionAllowed: false,
      },
    });

    expect(obligations).toMatchObject({
      requiresWorkspaceInspectionEvidence: false,
      requiresSourceArtifactReads: true,
      completionContract: {
        taskClass: "artifact_only",
      },
    });
  });

  it("allows grounded no-ops when every required source artifact is also a tracked target", () => {
    const obligations = deriveVerificationObligations({
      workspaceRoot: "/tmp/project",
      requiredSourceArtifacts: ["/tmp/project/AGENC.md"],
      targetArtifacts: ["/tmp/project/AGENC.md"],
      completionContract: {
        taskClass: "artifact_only",
        placeholdersAllowed: false,
        partialCompletionAllowed: false,
        placeholderTaxonomy: "documentation",
      },
    });

    expect(obligations).toMatchObject({
      verificationMode: "mutation_required",
      requiresMutationEvidence: true,
      requiresSourceArtifactReads: true,
      allowsGroundedNoop: true,
      completionContract: {
        taskClass: "artifact_only",
      },
    });
  });

  it("preserves explicit repair placeholder taxonomy from the completion contract", () => {
    const obligations = deriveVerificationObligations({
      workspaceRoot: "/tmp/project",
      targetArtifacts: ["/tmp/project/src/jobs.c"],
      verificationMode: "mutation_required",
      completionContract: {
        taskClass: "artifact_only",
        placeholdersAllowed: false,
        partialCompletionAllowed: false,
        placeholderTaxonomy: "repair",
      },
    });

    expect(obligations).toMatchObject({
      placeholderTaxonomy: "repair",
      completionContract: {
        placeholderTaxonomy: "repair",
      },
    });
  });

  it("uses documentation placeholder defaults for delegated documentation writes", () => {
    const obligations = deriveVerificationObligations({
      workspaceRoot: "/tmp/project",
      targetArtifacts: ["/tmp/project/PLAN.md"],
      stepKind: "delegated_write",
      verificationMode: "mutation_required",
    });

    expect(obligations).toMatchObject({
      requiresMutationEvidence: true,
      placeholderTaxonomy: "documentation",
      placeholdersAllowed: false,
      partialCompletionAllowed: false,
      completionContract: {
        taskClass: "artifact_only",
        placeholderTaxonomy: "documentation",
      },
    });
  });

  it("infers documentation taxonomy for explicit artifact-only contracts on doc targets", () => {
    const obligations = deriveVerificationObligations({
      workspaceRoot: "/tmp/project",
      targetArtifacts: ["/tmp/project/PLAN.md"],
      verificationMode: "mutation_required",
      completionContract: {
        taskClass: "artifact_only",
        placeholdersAllowed: false,
        partialCompletionAllowed: false,
      },
    });

    expect(obligations).toMatchObject({
      placeholderTaxonomy: "documentation",
      completionContract: {
        taskClass: "artifact_only",
      },
    });
  });
});
