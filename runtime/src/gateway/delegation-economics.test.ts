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
});
