import { describe, expect, it, vi } from "vitest";

import type {
  AdmissionAcquireInput,
  ExecutionAdmissionClient,
} from "../../src/budget/admission-client.js";
import { AdmissionDeniedError } from "../../src/budget/admission-client.js";
import type { AdmissionLease } from "../../src/budget/admission-types.js";
import { runAdmittedToolCall } from "../../src/budget/admitted-tool-call.js";
import type { Session } from "../../src/session/session.js";
import type { Tool } from "../../src/tools/types.js";

function toolHarness() {
  const leaseController = new AbortController();
  const acquire = vi.fn(
    async (input: AdmissionAcquireInput): Promise<AdmissionLease> => ({
      decision: "allow",
      reservation: {
        reservationId: "tool-reservation",
        step: { runId: "run-1", stepId: input.stepId },
        reservedCostUsd: input.maxCostUsd ?? 0,
        reservedTokens: input.maxInputTokens + input.maxOutputTokens,
        reservedAt: "2026-07-18T00:00:00.000Z",
      },
      request: {
        step: { runId: "run-1", stepId: input.stepId },
        kind: input.kind,
        estimate: {
          maxInputTokens: input.maxInputTokens,
          maxOutputTokens: input.maxOutputTokens,
          maxCostUsd: input.maxCostUsd,
        },
        workspaceId: "workspace-1",
        sessionId: "session-1",
        parentScopeId: "turn-1",
        autonomous: false,
      },
      signal: leaseController.signal,
    }),
  );
  const reconcile = vi.fn(() => ({
    applied: true as const,
    outcome: "reconciled" as const,
  }));
  const holdUnknown = vi.fn();
  const acknowledgeCompletion = vi.fn();
  const admission = {
    scope: {
      runId: "run-1",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      autonomous: false,
    },
    acquire,
    markDispatched: vi.fn(),
    reconcile,
    holdUnknown,
    void: vi.fn(),
    acknowledgeCompletion,
    recordFallback: vi.fn(),
    forSession: vi.fn(),
    subscribe: vi.fn(() => () => {}),
  } as unknown as ExecutionAdmissionClient;
  const session = {
    conversationId: "session-1",
    services: {
      executionAdmission: admission,
      admissionRequired: true,
      agentControl: { shutdownAgentTree: vi.fn() },
    },
    abortTerminal: vi.fn(),
  } as unknown as Session;
  return {
    acknowledgeCompletion,
    acquire,
    holdUnknown,
    leaseController,
    reconcile,
    session,
  };
}

describe("runAdmittedToolCall", () => {
  it("forwards live lease cancellation into the running tool", async () => {
    const leaseController = new AbortController();
    const holdUnknown = vi.fn();
    const acknowledgeCompletion = vi.fn();
    const acquire = vi.fn(
      async (input: AdmissionAcquireInput): Promise<AdmissionLease> => ({
        decision: "allow",
        reservation: {
          reservationId: "tool-reservation",
          step: { runId: "run-1", stepId: input.stepId },
          reservedCostUsd: 0,
          reservedTokens: 0,
          reservedAt: "2026-07-18T00:00:00.000Z",
        },
        request: {
          step: { runId: "run-1", stepId: input.stepId },
          kind: input.kind,
          estimate: {
            maxInputTokens: input.maxInputTokens,
            maxOutputTokens: input.maxOutputTokens,
            maxCostUsd: input.maxCostUsd,
          },
          workspaceId: "workspace-1",
          sessionId: "session-1",
          parentScopeId: "turn-1",
          autonomous: false,
        },
        signal: leaseController.signal,
      }),
    );
    const admission = {
      scope: {
        runId: "run-1",
        workspaceId: "workspace-1",
        sessionId: "session-1",
        autonomous: false,
      },
      acquire,
      markDispatched: vi.fn(),
      reconcile: vi.fn(),
      holdUnknown,
      void: vi.fn(),
      acknowledgeCompletion,
      recordFallback: vi.fn(),
      forSession: vi.fn(),
      subscribe: vi.fn(() => () => {}),
    } as unknown as ExecutionAdmissionClient;
    const session = {
      conversationId: "session-1",
      services: {
        executionAdmission: admission,
        admissionRequired: true,
      },
    } as unknown as Session;
    const tool = {
      name: "test.tool",
      recoveryCategory: "side-effecting",
    } as unknown as Tool;
    const invoked = Promise.withResolvers<AbortSignal>();

    const call = runAdmittedToolCall({
      session,
      turnId: "turn-1",
      callId: "call-1",
      tool,
      args: {},
      invoke: async ({ signal }) => {
        invoked.resolve(signal);
        return new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      },
    });
    const dispatchSignal = await invoked.promise;
    const cancellation = new AdmissionDeniedError(
      "parent_cancelled",
      "cancelled",
    );
    leaseController.abort(cancellation);

    await expect(call).rejects.toBe(cancellation);
    expect(dispatchSignal.aborted).toBe(true);
    expect(holdUnknown).toHaveBeenCalledWith(
      "tool-reservation",
      "tool_cancelled_after_dispatch",
    );
    expect(acknowledgeCompletion).toHaveBeenCalledOnce();
    expect(acknowledgeCompletion).toHaveBeenCalledWith("tool-reservation");
  });

  it("rejects a late tool success after durable cancellation", async () => {
    const state = toolHarness();
    const tool = {
      name: "metered.tool",
      recoveryCategory: "side-effecting",
      admissionEstimate: () => ({
        maxInputTokens: 10,
        maxOutputTokens: 20,
        maxCostUsd: 1,
      }),
    } as unknown as Tool;
    const invoked = Promise.withResolvers<void>();
    const toolResult = Promise.withResolvers<{
      content: string;
      admissionUsage: {
        inputTokens: number;
        outputTokens: number;
        costUsd: number;
      };
    }>();
    const running = runAdmittedToolCall({
      session: state.session,
      turnId: "turn-1",
      callId: "call-late-cancel",
      tool,
      args: {},
      invoke: async () => {
        invoked.resolve();
        // Deliberately ignore the dispatch AbortSignal and resolve later.
        return toolResult.promise;
      },
    });
    await invoked.promise;
    const cancellation = new AdmissionDeniedError(
      "operator_cancelled",
      "cancelled",
    );
    state.leaseController.abort(cancellation);
    toolResult.resolve({
      content: "too late",
      admissionUsage: { inputTokens: 4, outputTokens: 7, costUsd: 0.25 },
    });

    await expect(running).rejects.toBe(cancellation);
    expect(state.reconcile).toHaveBeenCalledWith("tool-reservation", {
      inputTokens: 4,
      outputTokens: 7,
      costUsd: 0.25,
    });
    expect(state.acknowledgeCompletion).toHaveBeenCalledOnce();
  });

  it("reconciles authoritative charged-tool usage", async () => {
    const state = toolHarness();
    const tool = {
      name: "metered.tool",
      recoveryCategory: "side-effecting",
      admissionEstimate: () => ({
        maxInputTokens: 10,
        maxOutputTokens: 20,
        maxCostUsd: 1,
      }),
    } as unknown as Tool;

    await runAdmittedToolCall({
      session: state.session,
      turnId: "turn-1",
      callId: "call-metered",
      tool,
      args: {},
      invoke: async () => ({
        content: "ok",
        admissionUsage: { inputTokens: 4, outputTokens: 7, costUsd: 0.25 },
      }),
    });

    expect(state.acquire.mock.calls[0]?.[0]).toMatchObject({
      maxInputTokens: 10,
      maxOutputTokens: 20,
      maxCostUsd: 1,
    });
    expect(state.reconcile).toHaveBeenCalledWith("tool-reservation", {
      inputTokens: 4,
      outputTokens: 7,
      costUsd: 0.25,
    });
    expect(state.holdUnknown).not.toHaveBeenCalled();
    expect(state.acknowledgeCompletion).toHaveBeenCalledOnce();
  });

  it("holds the full bound when a charged tool omits usage", async () => {
    const state = toolHarness();
    const tool = {
      name: "metered.tool",
      recoveryCategory: "side-effecting",
      admissionEstimate: () => ({
        maxInputTokens: 0,
        maxOutputTokens: 0,
        maxCostUsd: 1,
      }),
    } as unknown as Tool;

    await runAdmittedToolCall({
      session: state.session,
      turnId: "turn-1",
      callId: "call-unknown",
      tool,
      args: {},
      invoke: async () => ({ content: "ok" }),
    });

    expect(state.holdUnknown).toHaveBeenCalledWith(
      "tool-reservation",
      "missing_tool_usage",
    );
    expect(state.reconcile).not.toHaveBeenCalled();
  });

  it("treats an unannotated future tool as unpriced, never free", async () => {
    const state = toolHarness();
    const tool = {
      name: "future.paid.tool",
      recoveryCategory: "side-effecting",
    } as unknown as Tool;

    await runAdmittedToolCall({
      session: state.session,
      turnId: "turn-1",
      callId: "call-future",
      tool,
      args: {},
      invoke: async () => ({ content: "ok" }),
    });

    expect(state.acquire.mock.calls[0]?.[0]?.maxCostUsd).toBeNull();
    expect(state.holdUnknown).toHaveBeenCalledWith(
      "tool-reservation",
      "missing_tool_usage",
    );
  });
});
