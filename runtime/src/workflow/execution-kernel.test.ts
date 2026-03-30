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
  it("preserves needs_verification as a dependency-satisfied nonterminal completion state", async () => {
    const events: Array<Record<string, unknown>> = [];
    const deterministicExecutor = createDeterministicExecutor();
    const executeNode = vi.fn<
      (typeof import("./execution-kernel-types.js"))["ExecutionKernelPlannerDelegate"]["executeNode"]
    >(async (step): Promise<ExecutionKernelNodeOutcome> => {
      return {
        status: "completed",
        result: JSON.stringify({
          status: "completed",
          step: step.name,
          completionState:
            step.name === "implement_core"
              ? "needs_verification"
              : "completed",
        }),
      };
    });
    const assessDependencySatisfaction = vi.fn(
      (step): ExecutionKernelDependencyState => ({
        kind:
          step.name === "implement_core"
            ? "satisfied_nonterminal"
            : "satisfied_terminal",
        completionState:
          step.name === "implement_core"
            ? "needs_verification"
            : "completed",
        dependencySatisfied: true,
        terminal: step.name !== "implement_core",
        verifierClosed: step.name !== "implement_core",
        semantics: "normal",
      }),
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
            name: "verify_core",
            stepType: "subagent_task",
            objective: "Verify core",
            inputContract: "Core is implemented",
            acceptanceCriteria: ["core verification is queued"],
            requiredToolCapabilities: ["system.bash"],
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
    expect(result.completionState).toBe("needs_verification");
    expect(result.completedSteps).toBe(2);
    expect(result.context.results.implement_core).toContain(
      "\"completionState\":\"needs_verification\"",
    );
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "step_state_changed",
          stepName: "implement_core",
          state: "completed",
        }),
        expect.objectContaining({
          type: "step_state_changed",
          stepName: "verify_core",
          state: "ready",
        }),
      ]),
    );
  });

  it("fails closed when parent fallback leaves the workflow blocked", async () => {
    const deterministicExecutor = createDeterministicExecutor();
    const executeNode = vi.fn<
      (typeof import("./execution-kernel-types.js"))["ExecutionKernelPlannerDelegate"]["executeNode"]
    >(async (step): Promise<ExecutionKernelNodeOutcome> => {
      if (step.name === "implement_core") {
        return {
          status: "completed",
          result: JSON.stringify({
            status: "delegation_fallback",
            recoveredViaParentFallback: true,
            completionState: "blocked",
            dependencyState: "unsatisfied_terminal",
            resolutionSemantics: "delegation_fallback",
            error: "budget exceeded",
            stopReasonHint: "budget_exceeded",
          }),
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
        assessDependencySatisfaction: vi.fn((step): ExecutionKernelDependencyState => {
          if (step.name === "implement_core") {
            return {
              kind: "unsatisfied_terminal",
              completionState: "blocked",
              dependencySatisfied: false,
              terminal: true,
              verifierClosed: false,
              semantics: "delegation_fallback",
              reason: "budget exceeded",
              stopReasonHint: "budget_exceeded",
            };
          }
          return {
            kind: "satisfied_terminal",
            completionState: "completed",
            dependencySatisfied: true,
            terminal: true,
            verifierClosed: true,
            semantics: "normal",
          };
        }),
        isExclusiveNode: () => false,
        resolveMaxParallelism: () => 4,
      },
    });

    const result = await kernel.execute({
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
    );

    expect(result.status).toBe("failed");
    expect(result.completionState).toBe("blocked");
    expect(result.completedSteps).toBe(1);
    expect(result.context.results.implement_core).toContain("delegation_fallback");
    expect(result.context.results.implement_cli).toContain("dependency_blocked");
    expect(result.error).toContain("budget exceeded");
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
              kind: "unsatisfied_terminal",
              completionState: "blocked",
              dependencySatisfied: false,
              terminal: true,
              verifierClosed: false,
              semantics: "normal",
              reason: "Core contract missing build proof",
              stopReasonHint: "validation_error",
            };
          }
          return {
            kind: "satisfied_terminal",
            completionState: "completed",
            dependencySatisfied: true,
            terminal: true,
            verifierClosed: true,
            semantics: "normal",
          };
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
