import { describe, expect, it } from "vitest";

import { createMockMemoryBackend } from "../../../src/memory/test-utils.js";
import { PipelineExecutor } from "../../../src/workflow/pipeline.js";
import type { SubAgentConfig, SubAgentResult } from "../../../src/gateway/sub-agent.js";
import { SubAgentOrchestrator } from "../../../src/gateway/subagent-orchestrator.js";

class SequencedFailureManager {
  private seq = 0;
  private readonly entries = new Map<string, SubAgentResult>();

  public readonly spawnCalls: SubAgentConfig[] = [];

  constructor(private readonly results: readonly SubAgentResult[]) {}

  async spawn(config: SubAgentConfig): Promise<string> {
    const id = `sub-${++this.seq}`;
    this.spawnCalls.push(config);
    this.entries.set(id, {
      sessionId: id,
      ...this.results[Math.min(this.seq - 1, this.results.length - 1)]!,
    });
    return id;
  }

  getResult(sessionId: string): SubAgentResult | null {
    const result = this.entries.get(sessionId);
    if (!result) return null;
    this.entries.delete(sessionId);
    return result;
  }

  cancel(): boolean {
    return true;
  }
}

describe("execution kernel lifecycle integration", () => {
  it("keeps dependency progress moving when delegated work falls back locally", async () => {
    const workspaceRoot = "/home/tetsuo/project";
    const baseExecutor = new PipelineExecutor({
      toolHandler: async () => '{"stdout":"lint ok","exitCode":0}',
      memoryBackend: createMockMemoryBackend(),
    });
    const manager = new SequencedFailureManager([
      {
        output: "Tool budget exceeded (24 per request)",
        success: false,
        durationMs: 10,
        toolCalls: [],
        stopReason: "budget_exceeded",
      },
      {
        output: "Tool budget exceeded (36 per request)",
        success: false,
        durationMs: 11,
        toolCalls: [],
        stopReason: "budget_exceeded",
      },
    ]);
    const orchestrator = new SubAgentOrchestrator({
      fallbackExecutor: baseExecutor,
      resolveSubAgentManager: () => manager,
      fallbackBehavior: "continue_without_delegation",
      pollIntervalMs: 5,
    });
    const events: Array<Record<string, unknown>> = [];

    const result = await orchestrator.execute(
      {
        id: "planner:kernel:lifecycle:1",
        createdAt: Date.now(),
        context: { results: {} },
        steps: [],
        plannerContext: {
          parentRequest: "Implement the core package, then lint the project.",
          history: [],
          memory: [],
          toolOutputs: [],
          workspaceRoot,
        },
        plannerSteps: [
          {
            name: "implement_core",
            stepType: "subagent_task",
            objective: "Implement the core package",
            inputContract: "Workspace exists",
            acceptanceCriteria: ["Core builds"],
            requiredToolCapabilities: ["system.writeFile"],
            contextRequirements: ["workspace_exists"],
            maxBudgetHint: "2m",
            canRunParallel: true,
          },
          {
            name: "verify_lint",
            stepType: "deterministic_tool",
            tool: "system.bash",
            args: { command: "npm", args: ["run", "lint"] },
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
    expect(result.context.results.implement_core).toContain("delegation_fallback");
    expect(result.context.results.verify_lint).toContain("lint ok");
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "step_state_changed",
          stepName: "implement_core",
          state: "completed",
          reason: expect.stringContaining("Recovered via parent fallback"),
        }),
        expect.objectContaining({
          type: "step_state_changed",
          stepName: "verify_lint",
          state: "completed",
        }),
      ]),
    );
  });
});
