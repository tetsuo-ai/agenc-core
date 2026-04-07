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

});
