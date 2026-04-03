import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { Pipeline, PipelinePlannerSubagentStep } from "../workflow/pipeline.js";
import { buildWorkspaceStateGuidanceLines } from "./subagent-workspace-probes.js";

describe("subagent-workspace-probes", () => {
  it("uses only the trusted execution-envelope workspace root for prompt guidance", () => {
    const step: PipelinePlannerSubagentStep = {
      name: "inspect_workspace",
      stepType: "subagent_task",
      objective: "Inspect authored package state",
      inputContract: "Use the approved workspace only",
      acceptanceCriteria: ["Summarize package state"],
      requiredToolCapabilities: ["system.readFile"],
      contextRequirements: ["cwd=/workspace/legacy-hint"],
      executionContext: {
        version: "v1",
        workspaceRoot: "/home/tetsuo/git/AgenC/agenc-core",
        allowedReadRoots: ["/home/tetsuo/git/AgenC/agenc-core"],
        allowedWriteRoots: ["/home/tetsuo/git/AgenC/agenc-core"],
        allowedTools: ["system.readFile"],
        effectClass: "read_only",
        verificationMode: "grounded_read",
        stepKind: "delegated_review",
      },
      maxBudgetHint: "2m",
      canRunParallel: true,
    };
    const pipeline: Pipeline = {
      id: "planner:test:trusted-guidance",
      createdAt: Date.now(),
      context: { results: {} },
      steps: [],
      plannerSteps: [step],
      plannerContext: {
        parentRequest: "Inspect the approved workspace only.",
        history: [],
        memory: [],
        toolOutputs: [],
      },
    };

    expect(
      buildWorkspaceStateGuidanceLines(
        step,
        pipeline,
        [{ path: "/home/tetsuo/git/AgenC/agenc-core/package.json" }],
        "/tmp/fabricated-root",
      ),
    ).toEqual([]);
  });

  it("warns when a delegated CMake workspace contains a stale copied build cache", () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "agenc-probes-"));
    try {
      mkdirSync(join(workspaceRoot, "build"), { recursive: true });
      writeFileSync(join(workspaceRoot, "CMakeLists.txt"), "cmake_minimum_required(VERSION 3.10)\nproject(test C)\n");
      writeFileSync(
        join(workspaceRoot, "build", "CMakeCache.txt"),
        "CMAKE_HOME_DIRECTORY:INTERNAL=/home/tetsuo/git/stream-test/agenc-shell\n",
      );
      const step: PipelinePlannerSubagentStep = {
        name: "implement_owner",
        stepType: "subagent_task",
        objective: "Implement the shell phases and keep tests passing",
        inputContract: "Own the implementation request end to end",
        acceptanceCriteria: ["Build and test the shell"],
        requiredToolCapabilities: ["system.readFile", "system.bash"],
        contextRequirements: [],
        executionContext: {
          version: "v1",
          workspaceRoot,
          allowedReadRoots: [workspaceRoot],
          allowedWriteRoots: [workspaceRoot],
          allowedTools: ["system.readFile", "system.bash"],
          effectClass: "workspace_write",
          verificationMode: "grounded_verification",
          stepKind: "delegated_execution",
        },
        maxBudgetHint: "10m",
        canRunParallel: false,
      };
      const pipeline: Pipeline = {
        id: "planner:test:stale-cmake-cache",
        createdAt: Date.now(),
        context: { results: {} },
        steps: [],
        plannerSteps: [step],
        plannerContext: {
          parentRequest: "Implement the shell and keep the build green.",
          history: [],
          memory: [],
          toolOutputs: [],
        },
      };

      const lines = buildWorkspaceStateGuidanceLines(
        step,
        pipeline,
        [],
        workspaceRoot,
      );

      expect(lines.some((line) => line.includes("build/CMakeCache.txt"))).toBe(true);
      expect(lines.some((line) => line.includes("build-agenc-fresh"))).toBe(true);
      expect(lines.some((line) => line.includes("first build or verification attempt"))).toBe(true);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});
