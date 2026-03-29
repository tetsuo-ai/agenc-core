import { describe, expect, it } from "vitest";

import {
  assessDelegationAdmission,
  assessDirectDelegationAdmission,
} from "./delegation-admission.js";

describe("assessDelegationAdmission", () => {
  it("allows multiple read-only reviewers plus one writer on the same planning artifact when ownership is relation-scoped", () => {
    const planPath = "/tmp/project/PLAN.md";
    const decision = assessDelegationAdmission({
      messageText:
        "Read PLAN.md from multiple angles, synthesize the findings, then update PLAN.md with the result.",
      totalSteps: 5,
      synthesisSteps: 1,
      explicitDelegationRequested: true,
      steps: [
        {
          name: "architecture_review",
          objective: "Review PLAN.md for architecture issues",
          inputContract: "Read PLAN.md and return grounded architecture findings.",
          acceptanceCriteria: ["Architecture findings are grounded in PLAN.md."],
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
          name: "security_review",
          objective: "Review PLAN.md for security gaps",
          inputContract: "Read PLAN.md and return grounded security findings.",
          acceptanceCriteria: ["Security findings are grounded in PLAN.md."],
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
          name: "qa_review",
          objective: "Review PLAN.md for QA coverage gaps",
          inputContract: "Read PLAN.md and return grounded QA findings.",
          acceptanceCriteria: ["QA findings are grounded in PLAN.md."],
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
          name: "final_writer",
          objective: "Update PLAN.md with the synthesized reviewer findings",
          inputContract:
            "Grounded reviewer findings have been provided; update PLAN.md only.",
          acceptanceCriteria: ["PLAN.md includes the synthesized reviewer findings."],
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
      edges: [
        { from: "architecture_review", to: "final_writer" },
        { from: "security_review", to: "final_writer" },
        { from: "qa_review", to: "final_writer" },
      ],
      threshold: 0,
      maxFanoutPerTurn: 4,
      maxDepth: 4,
    });

    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe("approved");
    expect(decision.shape).toBe("bounded_sequential_handoff");
    expect(decision.stepAdmissions.map((entry) => entry.ownedArtifacts)).toEqual([
      [],
      [],
      [],
      [planPath],
    ]);
  });

  it("denies shared-primary-artifact plans when multiple mutable child steps target the same file", () => {
    const decision = assessDelegationAdmission({
      messageText:
        "Review PLAN.md from multiple angles, update PLAN.md in parallel, then synthesize the result.",
      totalSteps: 4,
      synthesisSteps: 1,
      steps: [
        {
          name: "architecture_writer",
          objective: "Update PLAN.md with architecture feedback",
          inputContract: "Write the architecture changes into PLAN.md",
          acceptanceCriteria: ["PLAN.md includes architecture updates"],
          requiredToolCapabilities: ["system.writeFile"],
          contextRequirements: [],
          executionContext: {
            version: "v1",
            workspaceRoot: "/tmp/project",
            allowedReadRoots: ["/tmp/project"],
            allowedWriteRoots: ["/tmp/project"],
            requiredSourceArtifacts: ["/tmp/project/PLAN.md"],
            targetArtifacts: ["/tmp/project/PLAN.md"],
            effectClass: "filesystem_write",
            verificationMode: "mutation_required",
            stepKind: "delegated_write",
            role: "writer",
            artifactRelations: [
              {
                relationType: "read_dependency",
                artifactPath: "/tmp/project/PLAN.md",
              },
              {
                relationType: "write_owner",
                artifactPath: "/tmp/project/PLAN.md",
              },
            ],
          },
          maxBudgetHint: "3m",
          canRunParallel: true,
        },
        {
          name: "security_writer",
          objective: "Update PLAN.md with security feedback",
          inputContract: "Write the security changes into PLAN.md",
          acceptanceCriteria: ["PLAN.md includes security updates"],
          requiredToolCapabilities: ["system.writeFile"],
          contextRequirements: [],
          executionContext: {
            version: "v1",
            workspaceRoot: "/tmp/project",
            allowedReadRoots: ["/tmp/project"],
            allowedWriteRoots: ["/tmp/project"],
            requiredSourceArtifacts: ["/tmp/project/PLAN.md"],
            targetArtifacts: ["/tmp/project/PLAN.md"],
            effectClass: "filesystem_write",
            verificationMode: "mutation_required",
            stepKind: "delegated_write",
            role: "writer",
            artifactRelations: [
              {
                relationType: "read_dependency",
                artifactPath: "/tmp/project/PLAN.md",
              },
              {
                relationType: "write_owner",
                artifactPath: "/tmp/project/PLAN.md",
              },
            ],
          },
          maxBudgetHint: "3m",
          canRunParallel: true,
        },
      ],
      edges: [],
      threshold: 0,
      maxFanoutPerTurn: 4,
      maxDepth: 4,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("shared_artifact_writer_inline");
    expect(decision.diagnostics).toMatchObject({
      sharedPrimaryArtifact: "/tmp/project/PLAN.md",
    });
    expect(decision.stepAdmissions.map((entry) => entry.ownedArtifacts)).toEqual([
      ["/tmp/project/PLAN.md"],
      ["/tmp/project/PLAN.md"],
    ]);
  });

  it("keeps owned artifacts as structural runtime data for safe disjoint branches", () => {
    const decision = assessDelegationAdmission({
      messageText:
        "Implement the parser in one branch and the docs in another, then summarize.",
      totalSteps: 3,
      synthesisSteps: 1,
      steps: [
        {
          name: "parser_branch",
          objective: "Implement the parser",
          inputContract: "Update src/parser.c only",
          acceptanceCriteria: ["src/parser.c compiles"],
          requiredToolCapabilities: ["system.writeFile"],
          contextRequirements: [],
          executionContext: {
            version: "v1",
            workspaceRoot: "/tmp/project",
            allowedReadRoots: ["/tmp/project"],
            allowedWriteRoots: ["/tmp/project"],
            requiredSourceArtifacts: ["/tmp/project/src/parser.c"],
            targetArtifacts: ["/tmp/project/src/parser.c"],
            effectClass: "filesystem_write",
            verificationMode: "mutation_required",
            stepKind: "delegated_execution",
          },
          maxBudgetHint: "4m",
          canRunParallel: true,
        },
        {
          name: "docs_branch",
          objective: "Update the guide",
          inputContract: "Update docs/AGENC.md only",
          acceptanceCriteria: ["docs/AGENC.md reflects the parser work"],
          requiredToolCapabilities: ["system.writeFile"],
          contextRequirements: [],
          executionContext: {
            version: "v1",
            workspaceRoot: "/tmp/project",
            allowedReadRoots: ["/tmp/project"],
            allowedWriteRoots: ["/tmp/project"],
            requiredSourceArtifacts: ["/tmp/project/docs/AGENC.md"],
            targetArtifacts: ["/tmp/project/docs/AGENC.md"],
            effectClass: "filesystem_write",
            verificationMode: "mutation_required",
            stepKind: "delegated_execution",
          },
          maxBudgetHint: "4m",
          canRunParallel: true,
        },
      ],
      edges: [],
      threshold: 0,
      maxFanoutPerTurn: 4,
      maxDepth: 4,
    });

    expect(decision.allowed).toBe(true);
    expect(decision.stepAdmissions.map((entry) => entry.ownedArtifacts)).toEqual([
      ["/tmp/project/src/parser.c"],
      ["/tmp/project/docs/AGENC.md"],
    ]);
  });

  it("rejects parent-safe read-only inspection handoffs even when planner context is larger", () => {
    const decision = assessDelegationAdmission({
      messageText:
        "Repair git if needed, then inspect the workspace state and tell me what is there.",
      totalSteps: 4,
      synthesisSteps: 1,
      steps: [
        {
          name: "repair_git_and_check_state",
          objective:
            "Repair git repository defect if needed by initializing it, then check current workspace state via listing files, git status, and reading README",
          inputContract:
            "Return grounded workspace state with file listing, git status, and README summary",
          acceptanceCriteria: [
            "Git repository is initialized if missing",
            "Workspace root entries are listed",
            "Current git status is reported",
            "README content is summarized from grounded evidence",
          ],
          requiredToolCapabilities: [
            "system.bash",
            "system.readFile",
            "system.listDir",
          ],
          contextRequirements: ["repo_context"],
          executionContext: {
            version: "v1",
            workspaceRoot: "/tmp/project",
            allowedReadRoots: ["/tmp/project"],
            allowedWriteRoots: ["/tmp/project"],
            requiredSourceArtifacts: ["/tmp/project/README.md"],
            effectClass: "read_only",
            verificationMode: "grounded_read",
            stepKind: "delegated_review",
          },
          maxBudgetHint: "2m",
          canRunParallel: false,
        },
      ],
      edges: [],
      threshold: 0,
      maxFanoutPerTurn: 4,
      maxDepth: 4,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("single_hop_request");
    expect(decision.diagnostics).toMatchObject({
      parentSafeReadOnlyInspection: true,
    });
  });

  it("keeps explicitly requested read-only delegation admissible", () => {
    const decision = assessDelegationAdmission({
      messageText:
        "Delegate deeper research into the flaky logs, inspect the workspace state, and report the findings.",
      totalSteps: 3,
      synthesisSteps: 1,
      explicitDelegationRequested: true,
      steps: [
        {
          name: "inspect_logs",
          objective:
            "Inspect flaky test logs and workspace state, then report grounded findings",
          inputContract:
            "Return grounded findings from the inspected logs and files",
          acceptanceCriteria: [
            "Observed timeout clusters are grounded in the logs",
          ],
          requiredToolCapabilities: ["system.readFile", "system.listDir"],
          contextRequirements: ["ci_logs"],
          executionContext: {
            version: "v1",
            workspaceRoot: "/tmp/project",
            allowedReadRoots: ["/tmp/project"],
            allowedWriteRoots: ["/tmp/project"],
            requiredSourceArtifacts: ["/tmp/project/logs/flaky.log"],
            effectClass: "read_only",
            verificationMode: "grounded_read",
            stepKind: "delegated_research",
          },
          maxBudgetHint: "2m",
          canRunParallel: false,
        },
      ],
      edges: [],
      threshold: 0,
      maxFanoutPerTurn: 4,
      maxDepth: 4,
    });

    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe("approved");
    expect(decision.shape).toBe("test_triage");
  });

  it("allows user-mandated multi-agent reviewer cardinality to bypass the generic fanout veto", () => {
    const decision = assessDelegationAdmission({
      messageText:
        "Read PLAN.md, create 2 agents with different roles to review architecture and QA, then update PLAN.md with the synthesized result.",
      totalSteps: 3,
      synthesisSteps: 1,
      explicitDelegationRequested: true,
      steps: [
        {
          name: "architecture_review",
          objective:
            "Review architecture alignment against the current repo and PLAN.md",
          inputContract:
            "Return grounded architecture findings for the final PLAN.md update.",
          acceptanceCriteria: [
            "Architecture findings are grounded in the repo and PLAN.md",
          ],
          requiredToolCapabilities: ["system.readFile", "system.listDir"],
          contextRequirements: ["repo_context", "read_plan_md"],
          executionContext: {
            version: "v1",
            workspaceRoot: "/tmp/project",
            allowedReadRoots: ["/tmp/project"],
            allowedWriteRoots: ["/tmp/project"],
            requiredSourceArtifacts: ["/tmp/project/PLAN.md"],
            effectClass: "read_only",
            verificationMode: "grounded_read",
            stepKind: "delegated_review",
          },
          maxBudgetHint: "2m",
          canRunParallel: false,
        },
        {
          name: "qa_review",
          objective:
            "Review QA and testing gaps against the current repo and PLAN.md",
          inputContract:
            "Return grounded QA findings for the final PLAN.md update.",
          acceptanceCriteria: [
            "QA findings are grounded in the repo and PLAN.md",
          ],
          requiredToolCapabilities: ["system.readFile", "system.listDir"],
          contextRequirements: ["repo_context", "read_plan_md"],
          executionContext: {
            version: "v1",
            workspaceRoot: "/tmp/project",
            allowedReadRoots: ["/tmp/project"],
            allowedWriteRoots: ["/tmp/project"],
            requiredSourceArtifacts: ["/tmp/project/PLAN.md"],
            effectClass: "read_only",
            verificationMode: "grounded_read",
            stepKind: "delegated_review",
          },
          maxBudgetHint: "2m",
          canRunParallel: false,
        },
      ],
      edges: [],
      threshold: 0,
      maxFanoutPerTurn: 1,
      maxDepth: 4,
    });

    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe("approved");
  });

  it("keeps explicit execute_with_agent read-only introspection delegation compatible", () => {
    const decision = assessDirectDelegationAdmission({
      input: {
        objective:
          "Inspect the local workspace, list files, run git status, and read README before reporting back.",
        inputContract:
          "Return a grounded state check for the current repo.",
        acceptanceCriteria: [
          "Workspace root entries are listed",
          "Git status is reported",
          "README summary is grounded in observed content",
        ],
        requiredToolCapabilities: [
          "system.bash",
          "system.readFile",
          "system.listDir",
        ],
        timeoutMs: 120_000,
      },
      threshold: 0,
    });

    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe("approved");
    expect(decision.diagnostics).toMatchObject({
      explicitDelegationCompatibilityOverride: true,
    });
  });
});
