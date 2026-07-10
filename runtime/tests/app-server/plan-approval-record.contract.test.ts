import { afterEach, describe, expect, it } from "vitest";

import { AgenCDaemonAgentManager } from "../../src/app-server/agent-lifecycle.js";
import { AgenCDaemonJsonRpcDispatcher } from "../../src/app-server/daemon-dispatcher.js";
import { JSON_RPC_VERSION } from "../../src/app-server/protocol/index.js";
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

interface ResolveCall {
  readonly agentId: string;
  readonly requestId: string;
  // The approval recorded under requestId AT THE MOMENT the decision resolves.
  // null means nothing was recorded before resolve ran.
  readonly approvalAtResolve: unknown;
}

function createAgents(resolveCalls: ResolveCall[]): {
  readonly agents: AgenCDaemonAgentManager;
} {
  const sessions = new AgenCDaemonSessionManager({
    createSessionId: sequence(["session_1"]),
    now: sequence(["2026-05-01T12:00:00.000Z"]),
  });
  const runner: AgenCBackgroundAgentRunner = {
    startAgent: async () => ({
      agentId: "agent_plan",
      startedAt: "2026-05-01T12:00:00.500Z",
      status: "running",
    }),
    resolveToolDecision: async (agentId, params) => {
      // Observe what was recorded BEFORE resolve runs. The deferred tool would
      // consume it at this point, so the record MUST already be present.
      resolveCalls.push({
        agentId,
        requestId: params.requestId,
        approvalAtResolve: consumeExitPlanModeApproval({
          __callId: params.requestId,
        }),
      });
      return true;
    },
  };
  const agents = new AgenCDaemonAgentManager({
    sessionManager: sessions,
    runner,
  });
  return { agents };
}

describe("approveTool records the exit-plan choice before resolving (contract #2)", () => {
  afterEach(() => clearExitPlanModeApprovalsForTest());

  it("records an approve+acceptEdits choice BEFORE resolving the decision", async () => {
    const resolveCalls: ResolveCall[] = [];
    const { agents } = createAgents(resolveCalls);
    await agents.createAgent({ objective: "wait for plan approval" });

    await expect(
      agents.approveTool({
        sessionId: "session_1",
        requestId: "call_plan_1",
        exitPlan: { action: "approve", mode: "acceptEdits", applyAllowedPrompts: true },
      }),
    ).resolves.toEqual({ requestId: "call_plan_1", decision: "approved" });

    // The record was present at resolve time (consumed inside resolveToolDecision).
    expect(resolveCalls).toEqual([
      {
        agentId: "agent_plan",
        requestId: "call_plan_1",
        approvalAtResolve: {
          action: "approve",
          mode: "acceptEdits",
          applyAllowedPrompts: true,
        },
      },
    ]);
  });

  it("records a revise choice (with feedback) before resolving", async () => {
    const resolveCalls: ResolveCall[] = [];
    const { agents } = createAgents(resolveCalls);
    await agents.createAgent({ objective: "wait for plan approval" });

    await agents.approveTool({
      sessionId: "session_1",
      requestId: "call_plan_2",
      exitPlan: { action: "revise", feedback: "split the migration" },
    });

    expect(resolveCalls[0]?.approvalAtResolve).toEqual({
      action: "revise",
      feedback: "split the migration",
    });
  });

  it("records nothing when no exitPlan is supplied", async () => {
    const resolveCalls: ResolveCall[] = [];
    const { agents } = createAgents(resolveCalls);
    await agents.createAgent({ objective: "wait for ordinary approval" });

    await agents.approveTool({
      sessionId: "session_1",
      requestId: "call_plain",
    });

    expect(resolveCalls[0]?.approvalAtResolve).toBeNull();
  });
});

describe("validateToolApproveParams accepts/rejects exitPlan (contract #3)", () => {
  async function dispatchApprove(
    params: Record<string, unknown>,
  ): Promise<{ readonly result?: unknown; readonly error?: { code: number; message: string } }> {
    const sessions = new AgenCDaemonSessionManager({
      createSessionId: sequence(["session_1"]),
      now: sequence(["2026-05-01T12:00:00.000Z"]),
    });
    const runner: AgenCBackgroundAgentRunner = {
      startAgent: async () => ({
        agentId: "agent_validate",
        startedAt: "2026-05-01T12:00:00.500Z",
        status: "running",
      }),
      setAgentPermissionMode: async (_agentId, modeParams) => ({
        applied: true,
        previousMode: "default",
        mode: modeParams.mode,
      }),
      resolveToolDecision: async () => true,
    };
    const agents = new AgenCDaemonAgentManager({
      sessionManager: sessions,
      runner,
    });
    await agents.createAgent({ objective: "validate" });
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({ agentManager: agents });
    const connection = dispatcher.createConnection();
    await connection.dispatch({
      jsonrpc: JSON_RPC_VERSION,
      id: "init",
      method: "initialize",
      params: { protocolVersion: "1.0.0", clientName: "contract-test" },
    });
    const response = (await connection.dispatch({
      jsonrpc: JSON_RPC_VERSION,
      id: "approve",
      method: "tool.approve",
      params,
    })) as { result?: unknown; error?: { code: number; message: string } };
    return response;
  }

  afterEach(() => clearExitPlanModeApprovalsForTest());

  it("accepts a valid exitPlan", async () => {
    const response = await dispatchApprove({
      sessionId: "session_1",
      requestId: "call_v1",
      exitPlan: { action: "approve", mode: "acceptEdits", applyAllowedPrompts: true },
    });
    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({ requestId: "call_v1", decision: "approved" });
  });

  it("still accepts params with no exitPlan", async () => {
    const response = await dispatchApprove({
      sessionId: "session_1",
      requestId: "call_v2",
    });
    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({ requestId: "call_v2", decision: "approved" });
  });

  it("accepts explicit all-tool session approval", async () => {
    const response = await dispatchApprove({
      sessionId: "session_1",
      requestId: "call_all",
      scope: "session",
      allowAllToolsForSession: true,
    });
    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({ requestId: "call_all", decision: "approved" });
  });

  it("rejects all-tool approval outside session scope", async () => {
    const response = await dispatchApprove({
      sessionId: "session_1",
      requestId: "call_bad_scope",
      scope: "once",
      allowAllToolsForSession: true,
    });
    expect(response.result).toBeUndefined();
    expect(response.error?.message ?? "").toMatch(/requires scope 'session'/);
  });

  it("rejects a non-boolean all-tool flag", async () => {
    const response = await dispatchApprove({
      sessionId: "session_1",
      requestId: "call_bad_flag",
      scope: "session",
      allowAllToolsForSession: "yes",
    });
    expect(response.result).toBeUndefined();
    expect(response.error?.message ?? "").toMatch(/must be a boolean/);
  });

  it("rejects a bad exitPlan.action with invalidParams", async () => {
    const response = await dispatchApprove({
      sessionId: "session_1",
      requestId: "call_v3",
      exitPlan: { action: "nope" },
    });
    expect(response.result).toBeUndefined();
    expect(response.error?.message ?? "").toMatch(/exitPlan\.action/);
  });

  it("rejects a bad exitPlan.mode with invalidParams", async () => {
    const response = await dispatchApprove({
      sessionId: "session_1",
      requestId: "call_v4",
      exitPlan: { action: "approve", mode: "bypassPermissions" },
    });
    expect(response.result).toBeUndefined();
    expect(response.error?.message ?? "").toMatch(/exitPlan\.mode/);
  });
});
