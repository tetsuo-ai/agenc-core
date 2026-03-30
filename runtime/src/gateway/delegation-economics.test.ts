import { describe, expect, it } from "vitest";

import { deriveDelegationEconomics } from "./delegation-economics.js";

describe("deriveDelegationEconomics", () => {
  it("derives artifact ownership from typed write_owner relations instead of artifact mentions", () => {
    const planPath = "/tmp/project/PLAN.md";
    const economics = deriveDelegationEconomics({
      messageText:
        "Review PLAN.md from multiple angles, then update PLAN.md with the synthesized result.",
      steps: [
        {
          name: "review_plan",
          objective: "Review PLAN.md carefully and suggest changes to PLAN.md",
          inputContract: "Read PLAN.md and return grounded findings only.",
          acceptanceCriteria: ["Grounded findings for PLAN.md are returned."],
          requiredToolCapabilities: ["system.readFile"],
          contextRequirements: [],
          executionContext: {
            version: "v1",
            workspaceRoot: "/tmp/project",
            allowedReadRoots: ["/tmp/project"],
            allowedWriteRoots: ["/tmp/project"],
            requiredSourceArtifacts: [planPath],
            effectClass: "read_only",
            verificationMode: "grounded_read",
            stepKind: "delegated_review",
            role: "reviewer",
            artifactRelations: [
              {
                relationType: "read_dependency",
                artifactPath: planPath,
              },
            ],
          },
          maxBudgetHint: "2m",
          canRunParallel: true,
        },
        {
          name: "write_plan",
          objective: "Update PLAN.md with the synthesized findings",
          inputContract: "Grounded reviewer findings are provided for PLAN.md.",
          acceptanceCriteria: ["PLAN.md is updated with the synthesized findings."],
          requiredToolCapabilities: ["system.readFile", "system.writeFile"],
          contextRequirements: [],
          executionContext: {
            version: "v1",
            workspaceRoot: "/tmp/project",
            allowedReadRoots: ["/tmp/project"],
            allowedWriteRoots: ["/tmp/project"],
            requiredSourceArtifacts: [planPath],
            targetArtifacts: [planPath],
            effectClass: "filesystem_write",
            verificationMode: "mutation_required",
            stepKind: "delegated_write",
            role: "writer",
            artifactRelations: [
              {
                relationType: "read_dependency",
                artifactPath: planPath,
              },
              {
                relationType: "write_owner",
                artifactPath: planPath,
              },
            ],
          },
          maxBudgetHint: "3m",
          canRunParallel: false,
        },
      ],
      edges: [{ from: "review_plan", to: "write_plan" }],
    });

    expect(economics.stepAnalyses.map((analysis) => analysis.ownedArtifacts)).toEqual([
      [],
      [planPath],
    ]);
    expect(
      economics.stepAnalyses.map((analysis) => analysis.referencedArtifacts),
    ).toEqual([[planPath], [planPath]]);
    expect(economics.explicitOwnershipCoverage).toBe(0.5);
  });

  it("treats validator follow-up shell steps with verification_subject relations as non-writer work", () => {
    const workspaceRoot = "/tmp/agenc-shell";
    const sourceDir = `${workspaceRoot}/src`;
    const economics = deriveDelegationEconomics({
      messageText:
        "Implement Phase 1 from PLAN.md, then run the Phase 1 tests before moving on.",
      steps: [
        {
          name: "implement_phase_1",
          objective: "Implement Phase 1 exactly as specified in PLAN.md.",
          inputContract: "PLAN.md plus the existing source tree.",
          acceptanceCriteria: ["Phase 1 source artifacts are implemented."],
          requiredToolCapabilities: [
            "system.readFile",
            "system.writeFile",
            "system.bash",
          ],
          contextRequirements: [],
          executionContext: {
            version: "v1",
            workspaceRoot,
            allowedReadRoots: [workspaceRoot],
            allowedWriteRoots: [workspaceRoot],
            requiredSourceArtifacts: [`${workspaceRoot}/PLAN.md`],
            targetArtifacts: [sourceDir],
            effectClass: "filesystem_write",
            verificationMode: "mutation_required",
            stepKind: "delegated_write",
            role: "writer",
            artifactRelations: [
              {
                relationType: "read_dependency",
                artifactPath: `${workspaceRoot}/PLAN.md`,
              },
              {
                relationType: "write_owner",
                artifactPath: sourceDir,
              },
            ],
          },
          maxBudgetHint: "30m",
          canRunParallel: false,
        },
        {
          name: "test_phase_1",
          objective: "Run the Phase 1 tests and report grounded failures only.",
          inputContract: "Implemented Phase 1 artifacts plus PLAN.md test requirements.",
          acceptanceCriteria: ["All Phase 1 tests pass."],
          requiredToolCapabilities: ["system.bash", "system.readFile"],
          contextRequirements: ["implement_phase_1"],
          executionContext: {
            version: "v1",
            workspaceRoot,
            allowedReadRoots: [workspaceRoot],
            allowedWriteRoots: [workspaceRoot],
            requiredSourceArtifacts: [`${workspaceRoot}/PLAN.md`],
            targetArtifacts: [workspaceRoot],
            effectClass: "shell",
            verificationMode: "deterministic_followup",
            stepKind: "delegated_validation",
            role: "validator",
            artifactRelations: [
              {
                relationType: "read_dependency",
                artifactPath: `${workspaceRoot}/PLAN.md`,
              },
              {
                relationType: "verification_subject",
                artifactPath: sourceDir,
              },
            ],
          },
          maxBudgetHint: "15m",
          canRunParallel: false,
        },
      ],
      edges: [{ from: "implement_phase_1", to: "test_phase_1" }],
    });

    expect(economics.stepAnalyses.map((analysis) => analysis.mutable)).toEqual([
      true,
      false,
    ]);
    expect(
      economics.stepAnalyses.map((analysis) => analysis.shellObservationOnly),
    ).toEqual([false, true]);
    expect(
      economics.stepAnalyses.map((analysis) => analysis.ownedArtifacts),
    ).toEqual([[sourceDir], []]);
    expect(
      economics.stepAnalyses.map((analysis) => analysis.referencedArtifacts),
    ).toEqual([
      [`${workspaceRoot}/PLAN.md`, sourceDir],
      [`${workspaceRoot}/PLAN.md`, sourceDir],
    ]);
  });
});
