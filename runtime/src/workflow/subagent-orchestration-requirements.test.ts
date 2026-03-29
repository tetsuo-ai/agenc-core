import { describe, expect, it } from "vitest";

import {
  extractRequiredSubagentOrchestrationRequirements,
  resolveRequiredSubagentVerificationStepNames,
} from "./subagent-orchestration-requirements.js";

describe("resolveRequiredSubagentVerificationStepNames", () => {
  it("prefers the required reviewer children over the final writer for implicit multi-agent review requests", () => {
    const requirements = extractRequiredSubagentOrchestrationRequirements(
      "Read PLAN.md, create 6 agents with different roles to review architecture, QA, security, documentation, layout, and completeness, then update PLAN.md with the synthesized result.",
    );

    expect(requirements).toBeDefined();
    expect(
      resolveRequiredSubagentVerificationStepNames({
        requirements,
        candidates: [
          {
            name: "architecture_review",
            objective: "Review architecture alignment only.",
            role: "reviewer",
            artifactRelations: [
              {
                relationType: "read_dependency",
                artifactPath: "/tmp/project/PLAN.md",
              },
            ],
            executionContext: {
              stepKind: "delegated_review",
              effectClass: "read_only",
              verificationMode: "grounded_read",
              role: "reviewer",
              artifactRelations: [
                {
                  relationType: "read_dependency",
                  artifactPath: "/tmp/project/PLAN.md",
                },
              ],
            },
          },
          {
            name: "qa_review",
            objective: "Review QA and test coverage only.",
            role: "reviewer",
            executionContext: {
              stepKind: "delegated_review",
              effectClass: "read_only",
              verificationMode: "grounded_read",
              role: "reviewer",
            },
          },
          {
            name: "security_review",
            objective: "Review security risks only.",
            role: "reviewer",
            executionContext: {
              stepKind: "delegated_review",
              effectClass: "read_only",
              verificationMode: "grounded_read",
              role: "reviewer",
            },
          },
          {
            name: "documentation_review",
            objective: "Review documentation clarity only.",
            role: "reviewer",
            executionContext: {
              stepKind: "delegated_review",
              effectClass: "read_only",
              verificationMode: "grounded_read",
              role: "reviewer",
            },
          },
          {
            name: "layout_review",
            objective: "Review directory layout alignment only.",
            role: "reviewer",
            executionContext: {
              stepKind: "delegated_review",
              effectClass: "read_only",
              verificationMode: "grounded_read",
              role: "reviewer",
            },
          },
          {
            name: "completeness_review",
            objective: "Review completeness and gaps only.",
            role: "reviewer",
            executionContext: {
              stepKind: "delegated_review",
              effectClass: "read_only",
              verificationMode: "grounded_read",
              role: "reviewer",
            },
          },
          {
            name: "rewrite_plan",
            objective: "Update PLAN.md with the synthesized result.",
            role: "writer",
            artifactRelations: [
              {
                relationType: "write_owner",
                artifactPath: "/tmp/project/PLAN.md",
              },
            ],
            executionContext: {
              stepKind: "delegated_write",
              effectClass: "filesystem_write",
              verificationMode: "mutation_required",
              targetArtifacts: ["/tmp/project/PLAN.md"],
              role: "writer",
              artifactRelations: [
                {
                  relationType: "write_owner",
                  artifactPath: "/tmp/project/PLAN.md",
                },
              ],
            },
          },
        ],
      }),
    ).toEqual([
      "qa_review",
      "security_review",
      "architecture_review",
      "documentation_review",
      "layout_review",
      "completeness_review",
    ]);
  });

  it("prefers typed reviewer roles over misleading review-flavored writer text", () => {
    const requirements = extractRequiredSubagentOrchestrationRequirements(
      "Read PLAN.md, create 2 agents with different roles to review architecture and QA, then update PLAN.md with the result.",
    );

    const selected = resolveRequiredSubagentVerificationStepNames({
      requirements,
      candidates: [
        {
          name: "architecture_review",
          objective: "Review architecture alignment only.",
          role: "reviewer",
          executionContext: {
            stepKind: "delegated_review",
            effectClass: "read_only",
            verificationMode: "grounded_read",
            role: "reviewer",
          },
        },
        {
          name: "rewrite_plan",
          objective:
            "Review all findings carefully and then update PLAN.md with the synthesized result.",
          role: "writer",
          artifactRelations: [
            {
              relationType: "write_owner",
              artifactPath: "/tmp/project/PLAN.md",
            },
          ],
          executionContext: {
            stepKind: "delegated_write",
            effectClass: "filesystem_write",
            verificationMode: "mutation_required",
            targetArtifacts: ["/tmp/project/PLAN.md"],
            role: "writer",
            artifactRelations: [
              {
                relationType: "write_owner",
                artifactPath: "/tmp/project/PLAN.md",
              },
            ],
          },
        },
        {
          name: "qa_review",
          objective: "Review QA coverage only.",
          role: "reviewer",
          executionContext: {
            stepKind: "delegated_review",
            effectClass: "read_only",
            verificationMode: "grounded_read",
            role: "reviewer",
          },
        },
      ],
    });

    expect(selected).toHaveLength(2);
    expect(selected).toEqual(
      expect.arrayContaining(["architecture_review", "qa_review"]),
    );
  });
});
