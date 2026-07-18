import { describe, expect, it, vi } from "vitest";

import { buildToolRegistry } from "../../../src/tool-registry.js";
import type { MultiAgentV2Options } from "../../../src/agents/v2/common.js";
import { createMultiAgentV2Tools } from "../../../src/agents/v2/index.js";
import { createAgentRoleWorkspace } from "../../../src/agents/role.js";
import { runAdmittedToolCall } from "../../../src/budget/admitted-tool-call.js";
import type {
  AdmissionAcquireInput,
  ExecutionAdmissionClient,
} from "../../../src/budget/admission-client.js";
import type { AdmissionLease } from "../../../src/budget/admission-types.js";
import type { Session } from "../../../src/session/session.js";

const COLLABORATION_CONTROL_TOOLS = [
  "spawn_agent",
  "assign_task",
  "list_agents",
  "wait_agent",
  "close_agent",
  "send_message",
] as const;

function collaborationRegistry() {
  const options: MultiAgentV2Options = {
    getSession: () => null,
    workspace: createAgentRoleWorkspace("/repo"),
    ensureAgentControl: () => {
      throw new Error("not executed by classification test");
    },
  };
  return buildToolRegistry({
    workspaceRoot: "/repo",
    modelFacingTools: createMultiAgentV2Tools(options),
  });
}

describe("collaboration control admission classification", () => {
  it("keeps local control effects at zero cost inside the unpriced model-facing group", () => {
    const registry = collaborationRegistry();

    for (const name of COLLABORATION_CONTROL_TOOLS) {
      const tool = registry.tools.find((candidate) => candidate.name === name);
      expect(tool, name).toBeDefined();
      expect(tool?.admissionEstimate?.({}), name).toEqual({
        maxInputTokens: 0,
        maxOutputTokens: 0,
        maxCostUsd: 0,
      });
    }
  });

  it("admits each control effect as a zero-cost tool_exec boundary", async () => {
    let reservationSequence = 0;
    const acquire = vi.fn(
      async (input: AdmissionAcquireInput): Promise<AdmissionLease> => ({
        decision: "allow",
        reservation: {
          reservationId: `reservation-${++reservationSequence}`,
          step: { runId: "root-run", stepId: input.stepId },
          reservedCostUsd: 0,
          reservedTokens: 0,
          reservedAt: "2026-07-18T00:00:00.000Z",
        },
        request: {} as never,
        signal: new AbortController().signal,
      }),
    );
    const admission = {
      scope: {
        runId: "root-run",
        workspaceId: "workspace",
        sessionId: "root-session",
        autonomous: false,
      },
      acquire,
      markDispatched: vi.fn(),
      reconcile: vi.fn(() => ({
        applied: true as const,
        outcome: "reconciled" as const,
      })),
      holdUnknown: vi.fn(),
      void: vi.fn(),
      acknowledgeCompletion: vi.fn(),
      recordFallback: vi.fn(),
      forSession: vi.fn(),
      subscribe: vi.fn(() => () => {}),
    } satisfies ExecutionAdmissionClient;
    const session = {
      conversationId: "root-session",
      services: {
        executionAdmission: admission,
        admissionRequired: true,
      },
    } as Session;
    const registry = collaborationRegistry();

    for (const name of COLLABORATION_CONTROL_TOOLS) {
      const tool = registry.tools.find((candidate) => candidate.name === name);
      if (tool === undefined) throw new Error(`missing ${name}`);
      await runAdmittedToolCall({
        session,
        turnId: "turn-1",
        callId: `call-${name}`,
        tool,
        args: {},
        invoke: async () => ({ content: "ok" }),
      });
    }

    expect(acquire).toHaveBeenCalledTimes(COLLABORATION_CONTROL_TOOLS.length);
    for (const [index, name] of COLLABORATION_CONTROL_TOOLS.entries()) {
      expect(acquire.mock.calls[index]?.[0], name).toMatchObject({
        stepId: `tool:turn-1:call-${name}`,
        kind: "tool_exec",
        maxInputTokens: 0,
        maxOutputTokens: 0,
        maxCostUsd: 0,
      });
    }
  });
});
