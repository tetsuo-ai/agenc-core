import { describe, expect, it } from "vitest";

import type { Pipeline, PipelineCheckpoint } from "./pipeline.js";
import {
  canonicalizePipelinePlannerExecutionContexts,
  migratePipelineCheckpoint,
} from "./migrations.js";

describe("delegated workspace migration compatibility", () => {
  it("does not promote legacy planner cwd hints into live execution envelopes", () => {
    const workspaceRoot = "/home/tetsuo/git/stream-test/agenc-shell";
    const pipeline: Pipeline = {
      id: "planner:test:legacy-cwd",
      createdAt: Date.now(),
      context: { results: {} },
      steps: [],
      plannerContext: {
        parentRequest: "Review PLAN.md",
        history: [],
        memory: [],
        toolOutputs: [],
        workspaceRoot,
      },
      plannerSteps: [
        {
          name: "review_plan",
          stepType: "subagent_task",
          objective: "Review PLAN.md",
          inputContract: "Workspace exists",
          acceptanceCriteria: ["PLAN.md inspected"],
          requiredToolCapabilities: ["system.readFile"],
          contextRequirements: ["cwd=.", "read PLAN.md first"],
          maxBudgetHint: "2m",
          canRunParallel: false,
        },
      ],
    };

    const normalized = canonicalizePipelinePlannerExecutionContexts(pipeline);
    const step = normalized.plannerSteps?.[0];

    expect(step?.stepType).toBe("subagent_task");
    if (!step || step.stepType !== "subagent_task") {
      throw new Error("Expected subagent task step");
    }

    expect(step.executionContext).toBeUndefined();
  });

  it("does not upgrade legacy checkpoint planner steps into structured execution envelopes", () => {
    const workspaceRoot = "/home/tetsuo/agent-test/signal-cartography-ts-57";
    const checkpoint: PipelineCheckpoint = {
      pipelineId: "planner:test:checkpoint",
      pipeline: {
        id: "planner:test:checkpoint",
        createdAt: Date.now(),
        context: { results: {} },
        steps: [],
        plannerContext: {
          parentRequest: "Scaffold the repo",
          history: [],
          memory: [],
          toolOutputs: [],
          workspaceRoot,
        },
        plannerSteps: [
          {
            name: "scaffold_monorepo",
            stepType: "subagent_task",
            objective: "Scaffold the signal cartography monorepo",
            inputContract: "Empty dir at /workspace/signal-cartography-ts-57",
            acceptanceCriteria: ["Root manifest exists"],
            requiredToolCapabilities: ["system.writeFile"],
            contextRequirements: ["cwd=/workspace/signal-cartography-ts-57"],
            maxBudgetHint: "2m",
            canRunParallel: false,
          },
        ],
      },
      stepIndex: 0,
      context: { results: {} },
      status: "running",
      updatedAt: Date.now(),
    };

    const migrated = migratePipelineCheckpoint(checkpoint).value;
    const step = migrated.pipeline.plannerSteps?.[0];

    expect(step?.stepType).toBe("subagent_task");
    if (!step || step.stepType !== "subagent_task") {
      throw new Error("Expected subagent task step");
    }

    expect(step.executionContext).toBeUndefined();
    expect(migrated.provenance?.trust).toBe("needs_revalidation");
    expect(migrated.provenance?.source).toBe("migrated_checkpoint");
    expect(migrated.provenance?.reasons).toEqual(
      expect.arrayContaining(["schema_migrated"]),
    );
  });

  it("marks migrated legacy execution envelopes as needing resume revalidation", () => {
    const migrated = migratePipelineCheckpoint({
      pipelineId: "planner:test:legacy-envelope",
      pipeline: {
        id: "planner:test:legacy-envelope",
        createdAt: Date.now(),
        context: { results: {} },
        steps: [],
        plannerContext: {
          parentRequest: "Inspect PLAN.md",
          history: [],
          memory: [],
          toolOutputs: [],
          workspaceRoot: "/home/tetsuo/git/stream-test/agenc-shell",
        },
        plannerSteps: [
          {
            name: "inspect_plan",
            stepType: "subagent_task",
            objective: "Inspect PLAN.md",
            inputContract: "Workspace exists",
            acceptanceCriteria: ["PLAN.md inspected"],
            requiredToolCapabilities: ["system.readFile"],
            executionContext: {
              workspaceRoot: "/workspace",
              allowedReadRoots: ["/workspace"],
              requiredSourceArtifacts: ["/workspace/PLAN.md"],
            },
            maxBudgetHint: "2m",
            canRunParallel: false,
          },
        ],
      },
      stepIndex: 0,
      context: { results: {} },
      status: "running",
      updatedAt: Date.now(),
    }).value;
    const step = migrated.pipeline.plannerSteps?.[0];

    expect(step?.stepType).toBe("subagent_task");
    if (!step || step.stepType !== "subagent_task") {
      throw new Error("Expected subagent task step");
    }

    expect(step.executionContext).toBeUndefined();
    expect(migrated.provenance?.trust).toBe("needs_revalidation");
    expect(migrated.provenance?.source).toBe("migrated_checkpoint");
    expect(migrated.provenance?.reasons).toEqual(
      expect.arrayContaining([
        "schema_migrated",
        "legacy_execution_envelope",
      ]),
    );
  });
});
