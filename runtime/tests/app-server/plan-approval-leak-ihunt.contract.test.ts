import { afterEach, describe, expect, it } from "vitest";

import { AgenCDaemonAgentManager } from "../../src/app-server/agent-lifecycle.js";
import { AgenCDaemonSessionManager } from "../../src/app-server/session-lifecycle.js";
import type { AgenCBackgroundAgentRunner } from "../../src/app-server/background-agent-runner.js";
import {
  clearExitPlanModeApprovalsForTest,
  consumeExitPlanModeApproval,
} from "../../src/planning/exit-plan-approval.js";

function sequence(values: readonly string[]): () => string {
  let index = 0;
  return () => {
    const value = values[index];
    if (value === undefined) {
      throw new Error("test sequence exhausted");
    }
    index += 1;
    return value;
  };
}

/**
 * Build an agent manager whose runner reports the tool request as NO LONGER
 * PENDING (resolveToolDecision -> false). This is the race/duplicate path
 * (e.g. an exit-plan approve arriving after the turn aborted, or a duplicate
 * approve) where approveTool throws INVALID_ARGUMENT.
 */
function createAgentsWithNonPendingDecision(): {
  readonly agents: AgenCDaemonAgentManager;
} {
  const sessions = new AgenCDaemonSessionManager({
    createSessionId: sequence(["session_1"]),
    now: sequence(["2026-05-01T12:00:00.000Z"]),
  });
  const runner: AgenCBackgroundAgentRunner = {
    startAgent: async () => ({
      agentId: "agent_leak",
      startedAt: "2026-05-01T12:00:00.500Z",
      status: "running",
    }),
    // The request is not pending anymore: the deferred ExitPlanMode tool will
    // never run to consume any recorded approval.
    resolveToolDecision: async () => false,
  };
  const agents = new AgenCDaemonAgentManager({
    sessionManager: sessions,
    runner,
  });
  return { agents };
}

describe("approveTool does not leak exit-plan approvals on the non-pending throw path (ihunt)", () => {
  afterEach(() => clearExitPlanModeApprovalsForTest());

  it("removes the recorded approval when the decision is no longer pending", async () => {
    const { agents } = createAgentsWithNonPendingDecision();
    await agents.createAgent({ cwd: process.cwd(), objective: "wait for plan approval" });

    await expect(
      agents.approveTool({
        sessionId: "session_1",
        requestId: "call_leak_1",
        exitPlan: {
          action: "approve",
          mode: "acceptEdits",
          applyAllowedPrompts: true,
        },
      }),
    ).rejects.toThrow(/not pending/);

    // The approval recorded under the requestId must NOT survive in the
    // module-global approvals Map after approveTool throws. If the fix is
    // reverted, the entry is still present and consume returns the approval.
    expect(
      consumeExitPlanModeApproval({ __callId: "call_leak_1" }),
    ).toBeNull();
  });

  it("does not leak across many distinct non-pending requestIds", async () => {
    const { agents } = createAgentsWithNonPendingDecision();
    await agents.createAgent({ cwd: process.cwd(), objective: "wait for plan approval" });

    const ids = ["call_a", "call_b", "call_c", "call_d", "call_e"];
    for (const requestId of ids) {
      await expect(
        agents.approveTool({
          sessionId: "session_1",
          requestId,
          exitPlan: { action: "revise", feedback: "redo it" },
        }),
      ).rejects.toThrow(/not pending/);
    }

    // None of the recorded approvals may remain after the throws.
    for (const requestId of ids) {
      expect(
        consumeExitPlanModeApproval({ __callId: requestId }),
      ).toBeNull();
    }
  });
});
