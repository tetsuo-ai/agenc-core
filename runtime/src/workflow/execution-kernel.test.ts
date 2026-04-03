import { describe, expect, it, vi } from "vitest";

import type { Pipeline } from "./pipeline.js";
import { CanonicalExecutionKernel } from "./execution-kernel.js";
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
  it("treats parent fallback as a satisfied completion for downstream dependencies", async () => {
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
    const assessDependencySatisfaction = vi.fn(
      (): ExecutionKernelDependencyState => ({ satisfied: true }),
    );

    const kernel = new CanonicalExecutionKernel({
      deterministicExecutor,
      plannerDelegate: {
        executeNode,
        assessDependencySatisfaction,
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

    expect(result.status).toBe("completed");
    expect(result.completedSteps).toBe(2);
    expect(result.context.results.implement_core).toContain("delegation_fallback");
    expect(result.context.results.implement_cli).toContain("implement_cli");
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "step_state_changed",
          stepName: "implement_core",
          state: "completed",
          reason: "Recovered via parent fallback",
        }),
        expect.objectContaining({
          type: "step_state_changed",
          stepName: "implement_cli",
          state: "ready",
        }),
      ]),
    );
  });

  it("blocks dependents when an upstream step finishes without satisfying its contract", async () => {
    const deterministicExecutor = createDeterministicExecutor();
    const kernel = new CanonicalExecutionKernel({
      deterministicExecutor,
      plannerDelegate: {
        executeNode: vi.fn(async (step): Promise<ExecutionKernelNodeOutcome> => ({
          status: "completed",
          result: JSON.stringify({ status: "completed", step: step.name }),
        })),
        assessDependencySatisfaction: vi.fn((step): ExecutionKernelDependencyState => {
          if (step.name === "implement_core") {
            return {
              satisfied: false,
              reason: "Core contract missing build proof",
              stopReasonHint: "validation_error",
            };
          }
          return { satisfied: true };
        }),
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
    expect(result.context.results.implement_cli).toContain("dependency_blocked");
  });
});
