import { describe, expect, it } from "vitest";

import {
  assessDelegationAdmission,
  assessDirectDelegationAdmission,
} from "./delegation-admission.js";

describe("assessDelegationAdmission", () => {
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
            stepKind: "delegated_execution",
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
            stepKind: "delegated_execution",
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
