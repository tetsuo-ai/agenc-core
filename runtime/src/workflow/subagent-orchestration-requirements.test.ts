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
            executionContext: {
              stepKind: "delegated_review",
              effectClass: "read_only",
              verificationMode: "grounded_read",
            },
          },
          {
            name: "qa_review",
            objective: "Review QA and test coverage only.",
            executionContext: {
              stepKind: "delegated_review",
              effectClass: "read_only",
              verificationMode: "grounded_read",
            },
          },
          {
            name: "security_review",
            objective: "Review security risks only.",
            executionContext: {
              stepKind: "delegated_review",
              effectClass: "read_only",
              verificationMode: "grounded_read",
            },
          },
          {
            name: "documentation_review",
            objective: "Review documentation clarity only.",
            executionContext: {
              stepKind: "delegated_review",
              effectClass: "read_only",
              verificationMode: "grounded_read",
            },
          },
          {
            name: "layout_review",
            objective: "Review directory layout alignment only.",
            executionContext: {
              stepKind: "delegated_review",
              effectClass: "read_only",
              verificationMode: "grounded_read",
            },
          },
          {
            name: "completeness_review",
            objective: "Review completeness and gaps only.",
            executionContext: {
              stepKind: "delegated_review",
              effectClass: "read_only",
              verificationMode: "grounded_read",
            },
          },
          {
            name: "rewrite_plan",
            objective: "Update PLAN.md with the synthesized result.",
            executionContext: {
              stepKind: "delegated_write",
              effectClass: "filesystem_write",
              verificationMode: "mutation_required",
              targetArtifacts: ["/tmp/project/PLAN.md"],
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
});
