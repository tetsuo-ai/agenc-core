import { describe, expect, it, vi } from "vitest";

import type { Pipeline } from "./pipeline.js";
import { CanonicalExecutionKernel } from "./execution-kernel.js";
import { assessPlannerDependencySatisfaction } from "./execution-kernel-policy.js";
import type {
  ExecutionKernelDependencyState,
  ExecutionKernelNodeOutcome,
} from "./execution-kernel-types.js";

function createDeterministicExecutor() {
  return {
    execute: vi.fn(async (pipeline: Pipeline) => ({
      status: "completed" as const,
      context: pipeline.context,
      completedSteps: pipeline.steps.length,
      totalSteps: pipeline.steps.length,
    })),
  };
}

describe("CanonicalExecutionKernel", () => {
  it("blocks downstream work when parent fallback occurs on child-owned mutable steps", async () => {
    const events: Array<Record<string, unknown>> = [];
    const deterministicExecutor = createDeterministicExecutor();
    const executeNode = vi.fn<
      (typeof import("./execution-kernel-types.js"))["ExecutionKernelPlannerDelegate"]["executeNode"]
    >(async (step): Promise<ExecutionKernelNodeOutcome> => {
      if (step.name === "implement_core") {
        return {
          status: "failed",
          error: "budget exceeded",
          stopReasonHint: "budget_exceeded",
          fallback: {
            satisfied: true,
            reason: "Recovered via parent fallback",
            stopReasonHint: "budget_exceeded",
            result: JSON.stringify({
              status: "delegation_fallback",
              recoveredViaParentFallback: true,
            }),
          },
        };
      }
      return {
        status: "completed",
        result: JSON.stringify({ status: "completed", step: step.name }),
      };
    });

    const kernel = new CanonicalExecutionKernel({
      deterministicExecutor,
      plannerDelegate: {
        executeNode,
        assessDependencySatisfaction: assessPlannerDependencySatisfaction,
        isExclusiveNode: () => false,
        resolveMaxParallelism: () => 4,
      },
    });

    const result = await kernel.execute(
      {
        id: "planner:test:fallback",
        createdAt: Date.now(),
        context: { results: {} },
        steps: [],
        plannerSteps: [
          {
            name: "implement_core",
            stepType: "subagent_task",
            objective: "Implement core",
            inputContract: "Workspace exists",
            acceptanceCriteria: ["core builds"],
            requiredToolCapabilities: ["system.writeFile"],
            contextRequirements: ["cwd=/workspace"],
            executionContext: {
              version: "v1",
              workspaceRoot: "/workspace",
              targetArtifacts: ["/workspace/src/core.ts"],
              effectClass: "filesystem_write",
              verificationMode: "mutation_required",
              stepKind: "delegated_write",
              fallbackPolicy: "continue_without_delegation",
            },
            maxBudgetHint: "2m",
            canRunParallel: true,
          },
          {
            name: "implement_cli",
            stepType: "subagent_task",
            objective: "Implement cli",
            inputContract: "Core is implemented",
            acceptanceCriteria: ["cli builds"],
            requiredToolCapabilities: ["system.writeFile"],
            contextRequirements: ["cwd=/workspace"],
            maxBudgetHint: "2m",
            canRunParallel: true,
            dependsOn: ["implement_core"],
          },
        ],
      },
      0,
      {
        onEvent: (event) => {
          events.push(event as unknown as Record<string, unknown>);
        },
      },
    );

    expect(result.status).toBe("failed");
    expect(result.context.results.implement_core).toContain(
      "delegation_fallback",
    );
    expect(result.context.results.implement_cli).toContain(
      "dependency_blocked",
    );
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "step_state_changed",
          stepName: "implement_core",
          state: "failed",
          reason: expect.stringContaining("must stay child-owned"),
        }),
      ]),
    );
  });

  it("allows parent fallback to satisfy downstream dependencies for read-only delegated review work", async () => {
    const deterministicExecutor = createDeterministicExecutor();
    const kernel = new CanonicalExecutionKernel({
      deterministicExecutor,
      plannerDelegate: {
        executeNode: vi.fn(
          async (step): Promise<ExecutionKernelNodeOutcome> => {
            if (step.name === "review_plan") {
              return {
                status: "failed",
                error: "provider timeout",
                stopReasonHint: "timeout",
                fallback: {
                  satisfied: true,
                  reason: "Recovered via parent fallback",
                  stopReasonHint: "timeout",
                  result: JSON.stringify({
                    status: "delegation_fallback",
                    recoveredViaParentFallback: true,
                  }),
                },
              };
            }
            return {
              status: "completed",
              result: JSON.stringify({ status: "completed", step: step.name }),
            };
          },
        ),
        assessDependencySatisfaction: assessPlannerDependencySatisfaction,
        isExclusiveNode: () => false,
        resolveMaxParallelism: () => 4,
      },
    });

    const result = await kernel.execute({
      id: "planner:test:review-fallback",
      createdAt: Date.now(),
      context: { results: {} },
      steps: [],
      plannerSteps: [
        {
          name: "review_plan",
          stepType: "subagent_task",
          objective: "Review the planning artifact for missing edge cases",
          inputContract: "Read-only review",
          acceptanceCriteria: ["Review findings captured"],
          requiredToolCapabilities: ["system.readFile"],
          contextRequirements: ["cwd=/workspace"],
          executionContext: {
            version: "v1",
            workspaceRoot: "/workspace",
            requiredSourceArtifacts: ["/workspace/design-spec.md"],
            effectClass: "read_only",
            verificationMode: "grounded_read",
            stepKind: "delegated_review",
            fallbackPolicy: "continue_without_delegation",
          },
          maxBudgetHint: "2m",
          canRunParallel: true,
        },
        {
          name: "summarize_review",
          stepType: "subagent_task",
          objective: "Summarize the review findings",
          inputContract: "Review findings available",
          acceptanceCriteria: ["Summary is produced"],
          requiredToolCapabilities: ["system.readFile"],
          contextRequirements: ["review_plan"],
          maxBudgetHint: "2m",
          canRunParallel: true,
          dependsOn: ["review_plan"],
        },
      ],
    });

    expect(result.status).toBe("completed");
    expect(result.context.results.review_plan).toContain("delegation_fallback");
    expect(result.context.results.summarize_review).toContain(
      "summarize_review",
    );
  });

  it("blocks dependents when an upstream step finishes without satisfying its contract", async () => {
    const deterministicExecutor = createDeterministicExecutor();
    const kernel = new CanonicalExecutionKernel({
      deterministicExecutor,
      plannerDelegate: {
        executeNode: vi.fn(
          async (step): Promise<ExecutionKernelNodeOutcome> => ({
            status: "completed",
            result: JSON.stringify({ status: "completed", step: step.name }),
          }),
        ),
        assessDependencySatisfaction: vi.fn(
          (step): ExecutionKernelDependencyState => {
            if (step.name === "implement_core") {
              return {
                satisfied: false,
                reason: "Core contract missing build proof",
                stopReasonHint: "validation_error",
              };
            }
            return { satisfied: true };
          },
        ),
        isExclusiveNode: () => false,
        resolveMaxParallelism: () => 4,
      },
    });

    const result = await kernel.execute({
      id: "planner:test:blocked",
      createdAt: Date.now(),
      context: { results: {} },
      steps: [],
      plannerSteps: [
        {
          name: "implement_core",
          stepType: "subagent_task",
          objective: "Implement core",
          inputContract: "Workspace exists",
          acceptanceCriteria: ["core builds"],
          requiredToolCapabilities: ["system.writeFile"],
          contextRequirements: ["cwd=/workspace"],
          maxBudgetHint: "2m",
          canRunParallel: true,
        },
        {
          name: "implement_cli",
          stepType: "subagent_task",
          objective: "Implement cli",
          inputContract: "Core is implemented",
          acceptanceCriteria: ["cli builds"],
          requiredToolCapabilities: ["system.writeFile"],
          contextRequirements: ["cwd=/workspace"],
          maxBudgetHint: "2m",
          canRunParallel: true,
          dependsOn: ["implement_core"],
        },
      ],
    });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("Core contract missing build proof");
    expect(result.context.results.implement_cli).toContain(
      "dependency_blocked",
    );
  });
});
