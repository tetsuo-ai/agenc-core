import { describe, expect, it, vi } from "vitest";

import type {
  AdmissionAcquireInput,
  ExecutionAdmissionClient,
} from "../../src/budget/admission-client.js";
import { AdmissionDeniedError } from "../../src/budget/admission-client.js";
import type { AdmissionLease } from "../../src/budget/admission-types.js";
import { runAdmittedToolCall } from "../../src/budget/admitted-tool-call.js";
import { EventLog, type Event } from "../../src/session/event-log.js";
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
  const effectEvents: Event[] = [];
  const eventLog = new EventLog();
  eventLog.subscribe((event) => effectEvents.push(event));
  const session = {
    conversationId: "session-1",
    eventLog,
    rolloutStore: { assertToolAdmissionAllowed: vi.fn() },
    emit: (event: Event) => eventLog.emit(event),
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
    effectEvents,
    holdUnknown,
    leaseController,
    reconcile,
    session,
  };
}

describe("runAdmittedToolCall", () => {
  it("fails closed before tool dispatch when the canonical effect journal is detached", async () => {
    const state = toolHarness();
    Object.assign(state.session, { rolloutStore: null });
    const invoke = vi.fn(async () => ({ content: "must not run" }));
    const tool = {
      name: "write.without-journal",
      recoveryCategory: "side-effecting",
    } as unknown as Tool;

    await expect(
      runAdmittedToolCall({
        session: state.session,
        turnId: "turn-1",
        callId: "call-no-journal",
        tool,
        args: {},
        invoke,
      }),
    ).rejects.toMatchObject({
      name: "AdmissionDeniedError",
      reason: "effect_journal_unavailable",
    });
    expect(invoke).not.toHaveBeenCalled();
    expect(state.acquire).toHaveBeenCalledOnce();
  });

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
    const effectEvents: Event[] = [];
    const eventLog = new EventLog();
    eventLog.subscribe((event) => effectEvents.push(event));
    const session = {
      conversationId: "session-1",
      eventLog,
      rolloutStore: { assertToolAdmissionAllowed: vi.fn() },
      emit: (event: Event) => eventLog.emit(event),
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
    expect(effectEvents.map((event) => event.msg.type)).toEqual([
      "effect_intent",
      "effect_unknown_outcome",
    ]);
  });

  it("settles cancelled zero-cost idempotent waits without unknown-outcome residue", async () => {
    const state = toolHarness();
    const tool = {
      name: "wait_agent",
      recoveryCategory: "idempotent",
      cancellationUsage: "zero",
      admissionEstimate: () => ({
        maxInputTokens: 0,
        maxOutputTokens: 0,
        maxCostUsd: 0,
      }),
    } as unknown as Tool;
    const invoked = Promise.withResolvers<AbortSignal>();
    const call = runAdmittedToolCall({
      session: state.session,
      turnId: "turn-1",
      callId: "call-wait",
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
    await invoked.promise;
    const cancellation = new AdmissionDeniedError(
      "parent_cancelled",
      "cancelled",
    );
    state.leaseController.abort(cancellation);

    await expect(call).rejects.toBe(cancellation);
    expect(state.holdUnknown).not.toHaveBeenCalled();
    expect(state.reconcile).toHaveBeenCalledWith("tool-reservation", {
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    });
    expect(state.effectEvents.map((event) => event.msg.type)).toEqual([
      "effect_intent",
      "effect_result",
    ]);
    expect(state.effectEvents.at(-1)?.msg).toMatchObject({
      type: "effect_result",
      payload: { outcome: "cancelled" },
    });
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
    expect(state.effectEvents.map((event) => event.msg.type)).toEqual([
      "effect_intent",
      "effect_result",
    ]);
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

  it("gives only idempotent effects a stable durable key", async () => {
    const state = toolHarness();
    const tool = {
      name: "read.stable",
      recoveryCategory: "idempotent",
      admissionEstimate: () => ({
        maxInputTokens: 0,
        maxOutputTokens: 0,
        maxCostUsd: 0,
      }),
    } as unknown as Tool;
    const invoke = async () => ({ content: "same result" });

    await runAdmittedToolCall({
      session: state.session,
      turnId: "turn-1",
      callId: "call-stable",
      tool,
      args: { nested: { b: 2, a: 1 } },
      invoke,
    });
    await runAdmittedToolCall({
      session: state.session,
      turnId: "turn-1",
      callId: "call-stable",
      tool,
      args: { nested: { a: 1, b: 2 } },
      invoke,
    });

    const intents = state.effectEvents.filter(
      (event) => event.msg.type === "effect_intent",
    );
    expect(intents).toHaveLength(2);
    if (
      intents[0]?.msg.type !== "effect_intent" ||
      intents[1]?.msg.type !== "effect_intent"
    ) {
      throw new Error("missing effect intent events");
    }
    expect(intents[0].msg.payload.idempotencyKey).toMatch(
      /^sha256:[a-f0-9]{64}$/,
    );
    expect(intents[1].msg.payload.idempotencyKey).toBe(
      intents[0].msg.payload.idempotencyKey,
    );
    expect(intents[1].msg.payload.intentDigest).toBe(
      intents[0].msg.payload.intentDigest,
    );
    expect(intents[1].id).not.toBe(intents[0].id);
    expect(intents[1].seq).toBeGreaterThan(intents[0].seq!);
  });

  it("records an unacknowledged non-idempotent exception as unknown", async () => {
    const state = toolHarness();
    const tool = {
      name: "write.unacknowledged-failure",
      recoveryCategory: "side-effecting",
      admissionEstimate: () => ({
        maxInputTokens: 0,
        maxOutputTokens: 0,
        maxCostUsd: 0,
      }),
    } as unknown as Tool;

    await expect(
      runAdmittedToolCall({
        session: state.session,
        turnId: "turn-1",
        callId: "call-unacknowledged-failure",
        tool,
        args: {},
        invoke: async () => {
          throw Object.assign(new Error("lost acknowledgement"), {
            code: "EIO",
          });
        },
      }),
    ).rejects.toThrow("lost acknowledgement");

    const acknowledgement = state.effectEvents.at(-1);
    expect(acknowledgement?.msg.type).toBe("effect_unknown_outcome");
    if (acknowledgement?.msg.type !== "effect_unknown_outcome") {
      throw new Error("missing unknown effect outcome");
    }
    expect(acknowledgement.msg.payload).toMatchObject({
      outcome: "unknown_outcome",
      reason: "tool_failed_after_dispatch_without_acknowledgement",
      requiresReview: true,
    });
  });

  it("records an explicit error result as a proven failed outcome", async () => {
    const state = toolHarness();
    const tool = {
      name: "write.known-failure",
      recoveryCategory: "side-effecting",
      admissionEstimate: () => ({
        maxInputTokens: 0,
        maxOutputTokens: 0,
        maxCostUsd: 0,
      }),
    } as unknown as Tool;

    await expect(
      runAdmittedToolCall({
        session: state.session,
        turnId: "turn-1",
        callId: "call-known-failure",
        tool,
        args: {},
        invoke: async () => ({ content: "known failure", isError: true }),
      }),
    ).resolves.toMatchObject({ content: "known failure", isError: true });

    const acknowledgement = state.effectEvents.at(-1);
    expect(acknowledgement?.msg.type).toBe("effect_result");
    if (acknowledgement?.msg.type !== "effect_result") {
      throw new Error("missing effect result");
    }
    expect(acknowledgement.msg.payload.outcome).toBe("failed");
  });

  it("records a sandbox denial as a determinate failed outcome, not unknown", async () => {
    const state = toolHarness();
    const tool = {
      name: "write.sandbox-denied",
      recoveryCategory: "side-effecting",
      admissionEstimate: () => ({
        maxInputTokens: 0,
        maxOutputTokens: 0,
        maxCostUsd: 0,
      }),
    } as unknown as Tool;

    // The sandbox policy check runs before the process is spawned, so a
    // denial is pre-effect by construction — poisoning the session behind
    // the M4 review gate for it is wrong (observed: plan mode + 2>/dev/null).
    const denied = new Error(
      "sandbox workspace_write blocked write outside workspace: /dev/null",
    );
    denied.name = "SandboxDeniedError";

    await expect(
      runAdmittedToolCall({
        session: state.session,
        turnId: "turn-1",
        callId: "call-sandbox-denied",
        tool,
        args: {},
        invoke: async () => {
          throw denied;
        },
      }),
    ).rejects.toThrow("sandbox workspace_write blocked");

    const acknowledgement = state.effectEvents.at(-1);
    expect(acknowledgement?.msg.type).toBe("effect_result");
    if (acknowledgement?.msg.type !== "effect_result") {
      throw new Error("missing effect result");
    }
    expect(acknowledgement.msg.payload.outcome).toBe("failed");
  });

  it("records a tool-reported timeout as a determinate failed outcome, not unknown", async () => {
    const state = toolHarness();
    const tool = {
      name: "write.timeout",
      recoveryCategory: "side-effecting",
      admissionEstimate: () => ({
        maxInputTokens: 0,
        maxOutputTokens: 0,
        maxCostUsd: 0,
      }),
    } as unknown as Tool;

    await expect(
      runAdmittedToolCall({
        session: state.session,
        turnId: "turn-1",
        callId: "call-timeout",
        tool,
        args: {},
        invoke: async () => {
          throw Object.assign(new Error("wait exceeded 30000ms timeout"), {
            reason: "timeout",
          });
        },
      }),
    ).rejects.toThrow("exceeded 30000ms timeout");

    const acknowledgement = state.effectEvents.at(-1);
    expect(acknowledgement?.msg.type).toBe("effect_result");
    if (acknowledgement?.msg.type !== "effect_result") {
      throw new Error("missing effect result");
    }
    expect(acknowledgement.msg.payload.outcome).toBe("failed");
  });
});
