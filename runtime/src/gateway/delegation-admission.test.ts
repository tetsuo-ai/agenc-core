import { describe, expect, it } from "vitest";

import { assessDelegationAdmission } from "./delegation-admission.js";

describe("assessDelegationAdmission", () => {
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

  it("denies parallel mutable writers that target the same artifact", () => {
    const workspaceRoot = "/tmp/project";
    const sharedArtifact = workspaceRoot + "/PLAN.md";
    const decision = assessDelegationAdmission({
      messageText: "Review PLAN.md in parallel and rewrite the same file twice.",
      totalSteps: 3,
      synthesisSteps: 1,
      steps: [
        {
          name: "review_plan",
          objective: "Inspect PLAN.md for issues.",
          acceptanceCriteria: ["Read PLAN.md and report grounded issues."],
          requiredToolCapabilities: ["system.readFile"],
          contextRequirements: [],
          executionContext: {
            workspaceRoot,
            allowedReadRoots: [workspaceRoot],
            allowedWriteRoots: [workspaceRoot],
            requiredSourceArtifacts: [sharedArtifact],
            targetArtifacts: [sharedArtifact],
            effectClass: "read_only",
          },
          maxBudgetHint: "5m",
          canRunParallel: true,
        },
        {
          name: "rewrite_plan",
          objective: "Rewrite PLAN.md with requested edits.",
          acceptanceCriteria: ["Update PLAN.md directly."],
          requiredToolCapabilities: ["system.writeFile"],
          contextRequirements: [],
          executionContext: {
            workspaceRoot,
            allowedReadRoots: [workspaceRoot],
            allowedWriteRoots: [workspaceRoot],
            requiredSourceArtifacts: [sharedArtifact],
            targetArtifacts: [sharedArtifact],
            effectClass: "filesystem_write",
          },
          maxBudgetHint: "10m",
          canRunParallel: true,
        },
        {
          name: "second_rewrite",
          objective: "Apply a second parallel rewrite to PLAN.md.",
          acceptanceCriteria: ["Also update PLAN.md directly."],
          requiredToolCapabilities: ["system.writeFile"],
          contextRequirements: [],
          executionContext: {
            workspaceRoot,
            allowedReadRoots: [workspaceRoot],
            allowedWriteRoots: [workspaceRoot],
            requiredSourceArtifacts: [sharedArtifact],
            targetArtifacts: [sharedArtifact],
            effectClass: "filesystem_write",
          },
          maxBudgetHint: "10m",
          canRunParallel: true,
        },
      ],
      edges: [],
      threshold: 0.5,
      maxFanoutPerTurn: 4,
      maxDepth: 4,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("shared_artifact_writer_inline");
    expect(decision.diagnostics.sharedPrimaryArtifact).toBe(sharedArtifact);
  });
});
