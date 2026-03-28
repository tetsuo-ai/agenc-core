import { describe, expect, it } from "vitest";
import {
  buildEffectiveContextRequirements,
  classifyDelegatedScopeTrustSignal,
  estimateContractShapedToolBudgetFloor,
  resolveSubagentToolBudgetPerRequest,
  resolvePlannerStepWorkingDirectory,
  stepRequiresStructuredDelegatedFilesystemScope,
} from "./subagent-failure-classification.js";

describe("subagent-failure-classification", () => {
  it("refuses execution-envelope workspace aliases as live working-directory inputs", () => {
    const result = resolvePlannerStepWorkingDirectory(
      {
        name: "review_plan",
        stepType: "subagent_task",
        objective: "Review PLAN.md",
        inputContract: "Read PLAN.md and return findings",
        acceptanceCriteria: ["3-5 findings"],
        requiredToolCapabilities: ["system.readFile"],
        contextRequirements: [],
        executionContext: {
          version: "v1",
          workspaceRoot: "/workspace",
          allowedReadRoots: ["/workspace", "/home/tetsuo/git/AgenC/agenc-core"],
          allowedWriteRoots: ["/workspace"],
          requiredSourceArtifacts: ["/workspace/PLAN.md"],
          targetArtifacts: ["/workspace/TODO.MD"],
          allowedTools: ["system.readFile"],
          effectClass: "read_only",
          verificationMode: "grounded_read",
          stepKind: "delegated_review",
        },
        maxBudgetHint: "2m",
        canRunParallel: true,
      },
      {
        id: "planner:test:alias",
        createdAt: Date.now(),
        context: { results: {} },
        steps: [],
        plannerContext: {
          parentRequest: "Review PLAN.md",
          history: [],
          memory: [],
          toolOutputs: [],
          workspaceRoot: "/home/tetsuo/git/AgenC/agenc-core",
        },
      },
      "/tmp/not-the-root",
    );

    expect(result).toBeUndefined();
  });

  it("does not fall back to planner workspace roots when the step lacks an execution envelope", () => {
    const result = resolvePlannerStepWorkingDirectory(
      {
        name: "review_plan",
        stepType: "subagent_task",
        objective: "Review PLAN.md",
        inputContract: "Read PLAN.md and return findings",
        acceptanceCriteria: ["3-5 findings"],
        requiredToolCapabilities: ["system.readFile"],
        contextRequirements: ["repo_context"],
        maxBudgetHint: "2m",
        canRunParallel: true,
      },
      {
        id: "planner:test",
        createdAt: Date.now(),
        context: { results: {} },
        steps: [],
        plannerContext: {
          parentRequest: "Review PLAN.md",
          history: [],
          memory: [],
          toolOutputs: [],
          workspaceRoot: "/home/tetsuo/git/stream-test/agenc-shell",
        },
      },
      "/home/tetsuo/git/AgenC",
    );

    expect(result).toBeUndefined();
  });

  it("does not treat raw cwd directives as structured delegated filesystem scope", () => {
    expect(
      stepRequiresStructuredDelegatedFilesystemScope({
        name: "review_plan",
        stepType: "subagent_task",
        objective: "Review PLAN.md",
        inputContract: "Read PLAN.md and return findings",
        acceptanceCriteria: ["3-5 findings"],
        requiredToolCapabilities: ["system.readFile"],
        contextRequirements: ["cwd=/workspace"],
        maxBudgetHint: "2m",
        canRunParallel: true,
      }),
    ).toBe(false);
  });

  it("drops legacy cwd directives while preserving non-scope context requirements", () => {
    expect(
      buildEffectiveContextRequirements({
        name: "review_plan",
        stepType: "subagent_task",
        objective: "Review PLAN.md",
        inputContract: "Read PLAN.md and return findings",
        acceptanceCriteria: ["3-5 findings"],
        requiredToolCapabilities: ["system.readFile"],
        contextRequirements: [
          "cwd=/workspace",
          "working_directory:/tmp/project",
          "repo_context",
          "repo_context",
        ],
        maxBudgetHint: "2m",
        canRunParallel: true,
      }),
    ).toEqual(["repo_context"]);
  });

  it("distinguishes trusted runtime envelope mismatches from invalid root attempts and informational cwd mentions", () => {
    expect(
      classifyDelegatedScopeTrustSignal({
        message:
          'Delegated workspace root "/repo" does not match the child working directory "/tmp".',
      }),
    ).toBe("trusted_runtime_envelope_mismatch");

    expect(
      classifyDelegatedScopeTrustSignal({
        message:
          'Requested delegated workspace root "/" is outside the trusted parent workspace root "/home/tetsuo/git/AgenC".',
      }),
    ).toBe("model_authored_invalid_root_attempt");

    expect(
      classifyDelegatedScopeTrustSignal({
        contextRequirements: ["cwd=/workspace/demo", "repo_context"],
      }),
    ).toBe("informational_untrusted_cwd_mention");
  });

  it("derives a contract-shaped tool budget floor for multi-evidence delegated checks", () => {
    const step = {
      name: "repair_git_and_check_state",
      stepType: "subagent_task" as const,
      objective:
        "Repair git if needed, then list files, run git status, and read README",
      inputContract:
        "Return a grounded workspace state check covering repository init, file listing, git status, and README evidence",
      acceptanceCriteria: [
        "Repository initialized if needed",
        "Workspace files listed",
        "Git status reported",
        "README summarized from grounded evidence",
      ],
      requiredToolCapabilities: [
        "system.bash",
        "system.readFile",
        "system.listDir",
      ],
      contextRequirements: ["repo_context"],
      executionContext: {
        version: "v1" as const,
        workspaceRoot: "/tmp/project",
        allowedReadRoots: ["/tmp/project"],
        allowedWriteRoots: ["/tmp/project"],
        requiredSourceArtifacts: ["/tmp/project/README.md"],
        effectClass: "read_only" as const,
        verificationMode: "grounded_read" as const,
        stepKind: "delegated_review" as const,
      },
      maxBudgetHint: "1m",
      canRunParallel: false,
    };

    expect(
      estimateContractShapedToolBudgetFloor(step),
    ).toBeGreaterThan(1);

    expect(
      resolveSubagentToolBudgetPerRequest({
        timeoutMs: 60_000,
        step,
      }),
    ).toBe(0);
  });
});
