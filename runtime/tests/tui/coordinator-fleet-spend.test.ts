import { describe, expect, it } from "vitest";

import {
  orchestratorTokenLabel,
  taskSpendLabel,
} from "../../src/tui/components/CoordinatorAgentStatus.js";
import type { LocalAgentTaskState } from "../../src/tasks/LocalAgentTask/LocalAgentTask.js";

/**
 * Build a minimal LocalAgentTaskState carrying the fields the fleet-panel
 * spend/token columns read. Only `progress`, `model`, and `agentType` are
 * load-bearing here.
 */
function agentTask(
  overrides: Partial<LocalAgentTaskState> = {},
): LocalAgentTaskState {
  return {
    id: "agent-1",
    type: "local_agent",
    status: "running",
    description: "build the parser",
    startTime: 0,
    outputFile: "urn:agenc:task:agent-1:output",
    outputOffset: 0,
    notified: false,
    agentId: "agent-1",
    prompt: "build the parser",
    agentType: "worker",
    model: "claude-opus-4-7",
    retrieved: false,
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
    isBackgrounded: false,
    pendingMessages: [],
    retain: false,
    diskLoaded: false,
    progress: { toolUseCount: 4, tokenCount: 40_000 },
    ...overrides,
  } as LocalAgentTaskState;
}

describe("fleet panel spend column (D7)", () => {
  it("renders a real estimated spend for an agent with real tokens + model", () => {
    // This is the swap that replaced the hardcoded `· spend —`. With real
    // tokenCount + a known-priced model, the label is a positive estimate.
    const label = taskSpendLabel(agentTask());
    expect(label).not.toBe("—");
    expect(label).toMatch(/^\$\d/);
    expect(label).toContain("est.");
  });

  it("dashes spend only when the data is genuinely unknown (no $0.00)", () => {
    expect(taskSpendLabel(agentTask({ progress: { toolUseCount: 0 } }))).toBe(
      "—",
    );
    expect(
      taskSpendLabel(
        agentTask({ model: undefined, progress: { tokenCount: 40_000 } }),
      ),
    ).toBe("—");
  });

  it("renders the orchestrator row's real session tokens (not a hardcoded dash)", () => {
    // Replaces the hardcoded `tokens=\"—\"` on the orchestrator MainLine.
    const tasks = {
      main: agentTask({
        id: "main",
        agentType: "main-session",
        progress: { tokenCount: 9_000 },
      }),
      worker: agentTask(),
    } as unknown as Record<string, LocalAgentTaskState>;
    const label = orchestratorTokenLabel(tasks);
    expect(label).not.toBe("—");
    expect(label).toContain("tokens");
  });

  it("dashes the orchestrator tokens when no main-session usage has landed", () => {
    const tasks = { worker: agentTask() } as unknown as Record<
      string,
      LocalAgentTaskState
    >;
    // Only a spawned worker is present (no main-session task) → dash.
    expect(orchestratorTokenLabel(tasks)).toBe("—");
  });
});
