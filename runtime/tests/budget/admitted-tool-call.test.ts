import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type {
  AdmissionAcquireInput,
  ExecutionAdmissionClient,
} from "../../src/budget/admission-client.js";
import { AdmissionDeniedError } from "../../src/budget/admission-client.js";
import type { AdmissionLease } from "../../src/budget/admission-types.js";
import { runAdmittedToolCall } from "../../src/budget/admitted-tool-call.js";
import {
  effectSettlementMetrics,
  resolveLiveEffectPoison,
  shutdownEffectSettlementSupervisor,
} from "../../src/budget/effect-settlement-supervisor.js";
import { EventLog, type Event } from "../../src/session/event-log.js";
import type { Session } from "../../src/session/session.js";
import type { Tool } from "../../src/tools/types.js";
import { attachPendingPhysicalSettlement } from "../../src/tools/physical-settlement.js";
import { createFileEditTool } from "../../src/tools/system/file-edit.js";

const zeroAdmissionEstimate = () => ({
  maxInputTokens: 0,
  maxOutputTokens: 0,
  maxCostUsd: 0,
});

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
      invoke: async ({ signal, crossEffectBoundary }) => {
        crossEffectBoundary();
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
      "tool_failed_after_effect_boundary",
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
      invoke: async ({ signal, crossEffectBoundary }) => {
        crossEffectBoundary();
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
      invoke: async ({ crossEffectBoundary }) => {
        crossEffectBoundary();
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
      invoke: async ({ crossEffectBoundary }) => {
        crossEffectBoundary();
        return {
          content: "ok",
          admissionUsage: { inputTokens: 4, outputTokens: 7, costUsd: 0.25 },
        };
      },
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
      invoke: async ({ crossEffectBoundary }) => {
        crossEffectBoundary();
        return { content: "ok" };
      },
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
      invoke: async ({ crossEffectBoundary }) => {
        crossEffectBoundary();
        return { content: "ok" };
      },
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
    const invoke = async ({
      crossEffectBoundary,
    }: {
      readonly crossEffectBoundary: () => void;
    }) => {
      crossEffectBoundary();
      return { content: "same result" };
    };

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
      stepIdSuffix: ":dispatch-2",
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
    expect(intents[1].msg.payload.intentDigest).not.toBe(
      intents[0].msg.payload.intentDigest,
    );
    expect(intents[1].msg.payload.stepId).toBe(
      "tool:turn-1:call-stable:dispatch-2",
    );
    expect(intents[1].id).not.toBe(intents[0].id);
    expect(intents[1].seq).toBeGreaterThan(intents[0].seq!);
  });

  it("allocates a fresh durable step for an authorized recovered attempt", async () => {
    const state = toolHarness();
    const assertToolEffectAttemptAllowed = vi.fn(() => 2);
    Object.assign(state.session.rolloutStore!, {
      assertToolEffectAttemptAllowed,
    });
    const tool = {
      name: "read.recovered",
      recoveryCategory: "idempotent",
    } as unknown as Tool;
    const invoke = vi.fn(async ({ crossEffectBoundary }) => {
      crossEffectBoundary();
      return { content: "recovered result" };
    });

    await expect(
      runAdmittedToolCall({
        session: state.session,
        turnId: "turn-1",
        callId: "call-recovered",
        tool,
        args: { path: "same" },
        invoke,
      }),
    ).resolves.toMatchObject({ content: "recovered result" });

    expect(assertToolEffectAttemptAllowed).toHaveBeenCalledWith(
      expect.objectContaining({
        callId: "call-recovered",
        recoveryCategory: "idempotent",
      }),
    );
    expect(state.acquire).toHaveBeenCalledWith(
      expect.objectContaining({
        stepId: "tool:turn-1:call-recovered:dispatch2",
      }),
      undefined,
    );
    expect(state.effectEvents[0]?.msg).toMatchObject({
      type: "effect_intent",
      payload: {
        stepId: "tool:turn-1:call-recovered:dispatch2",
        attempt: 2,
      },
    });
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("keeps an explicit non-error unknown disposition review-locked", async () => {
    const state = toolHarness();
    const tool = {
      name: "write.unknown-receipt",
      recoveryCategory: "side-effecting",
    } as unknown as Tool;

    await expect(
      runAdmittedToolCall({
        session: state.session,
        turnId: "turn-1",
        callId: "call-unknown-receipt",
        tool,
        args: {},
        invoke: async ({ crossEffectBoundary }) => {
          crossEffectBoundary();
          return {
            content: "request accepted but state could not be observed",
            effectDisposition: {
              disposition: "remains_unknown",
              evidenceKind: "provider_receipt",
              evidenceRef: "provider-receipt:unknown-1",
              evidenceSha256: "c".repeat(64),
            },
          };
        },
      }),
    ).resolves.toMatchObject({
      content: "request accepted but state could not be observed",
    });

    expect(state.effectEvents.map((event) => event.msg.type)).toEqual([
      "effect_intent",
      "effect_unknown_outcome",
    ]);
    expect(state.effectEvents.at(-1)?.msg).toMatchObject({
      type: "effect_unknown_outcome",
      payload: {
        outcome: "unknown_outcome",
        reason: "adapter_reported_unknown_effect_disposition",
      },
    });
    await expect(
      runAdmittedToolCall({
        session: state.session,
        turnId: "turn-1",
        callId: "dependent-call",
        tool,
        args: {},
        invoke: async () => ({ content: "must not run" }),
      }),
    ).rejects.toMatchObject({ code: "UNKNOWN_OUTCOME_MUTATION_BLOCKED" });
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
        invoke: async ({ crossEffectBoundary }) => {
          crossEffectBoundary();
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
      reason: "tool_failed_after_effect_boundary_without_disposition",
      requiresReview: true,
    });
  });

  it("does not treat an unproved error result as no-effect", async () => {
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
        invoke: async ({ crossEffectBoundary }) => {
          crossEffectBoundary();
          return { content: "known failure", isError: true };
        },
      }),
    ).resolves.toMatchObject({ content: "known failure", isError: true });

    const acknowledgement = state.effectEvents.at(-1);
    expect(acknowledgement?.msg.type).toBe("effect_unknown_outcome");
    if (acknowledgement?.msg.type !== "effect_unknown_outcome") {
      throw new Error("missing unknown outcome");
    }
    expect(acknowledgement.msg.payload.outcome).toBe("unknown_outcome");
  });

  it("settles an Edit whose old_string is not found as a determinate failure, not unknown", async () => {
    // Regression for the poisoned-session rollout: a stale `old_string`
    // returned a bare error result, the supervisor recorded
    // `effect_unknown_outcome`, and every later Write / exec_command in
    // the session was refused with a `/resolve` instruction the model
    // cannot execute. The file is untouched before the write boundary, so
    // the Edit tool must settle this as a confirmed no-effect failure.
    const root = await mkdtemp(join(tmpdir(), "agenc-admitted-edit-"));
    try {
      const file = join(root, "target.txt");
      await writeFile(file, "current text\n", "utf8");
      const editTool = createFileEditTool({ allowedPaths: [root] });
      const state = toolHarness();

      const result = await runAdmittedToolCall({
        session: state.session,
        turnId: "turn-1",
        callId: "call-edit-miss",
        tool: {
          ...editTool,
          admissionEstimate: zeroAdmissionEstimate,
        } as unknown as Tool,
        args: {},
        invoke: async ({ crossEffectBoundary }) => {
          crossEffectBoundary();
          return editTool.execute({
            file_path: file,
            old_string: "text that is not there",
            new_string: "replacement",
            __testBypassSessionGuard: true,
          });
        },
      });

      expect(result.isError).toBe(true);
      expect(result.content).toContain("String to replace not found in file.");
      expect(
        state.effectEvents.some(
          (event) => event.msg.type === "effect_unknown_outcome",
        ),
      ).toBe(false);
      expect(state.effectEvents.at(-1)?.msg).toMatchObject({
        type: "effect_result",
        payload: { outcome: "failed", effectBoundary: "crossed" },
      });

      // The session is not poisoned: a later side-effecting call still runs.
      await expect(
        runAdmittedToolCall({
          session: state.session,
          turnId: "turn-1",
          callId: "call-write-after-edit-miss",
          tool: {
            name: "write.follow-up",
            recoveryCategory: "side-effecting",
            admissionEstimate: zeroAdmissionEstimate,
          } as unknown as Tool,
          args: {},
          invoke: async ({ crossEffectBoundary }) => {
            crossEffectBoundary();
            return { content: "ok" };
          },
        }),
      ).resolves.toMatchObject({ content: "ok" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts typed adapter evidence that a crossed attempt made no effect", async () => {
    const state = toolHarness();
    const tool = {
      name: "write.provider-rejected",
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
        callId: "call-provider-rejected",
        tool,
        args: {},
        invoke: async ({ crossEffectBoundary }) => {
          crossEffectBoundary();
          return {
            content: "provider rejected before commit",
            isError: true,
            effectDisposition: {
              disposition: "confirmed_no_effect",
              evidenceKind: "provider_receipt",
              evidenceRef: "provider-receipt:rejected-42",
              evidenceSha256: "a".repeat(64),
            },
          };
        },
      }),
    ).resolves.toMatchObject({ isError: true });

    const acknowledgement = state.effectEvents.at(-1)?.msg;
    expect(acknowledgement).toMatchObject({
      type: "effect_result",
      payload: {
        outcome: "failed",
        effectBoundary: "crossed",
        noEffectEvidence: {
          kind: "effect_no_effect_proof",
          evidenceKind: "provider_receipt",
          evidenceRef: "provider-receipt:rejected-42",
          evidenceSha256: "a".repeat(64),
        },
      },
    });
  });

  it("does not brick later mutations after a confirmed no-effect agent refusal", async () => {
    const state = toolHarness();
    const closeAgent = {
      name: "close_agent",
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
        callId: "call-close-root",
        tool: closeAgent,
        args: {},
        invoke: async ({ crossEffectBoundary }) => {
          crossEffectBoundary();
          return {
            content: '{"error":"root is not a spawned agent"}',
            isError: true,
            effectDisposition: {
              disposition: "confirmed_no_effect",
              evidenceKind: "boundary_not_crossed",
              evidenceRef: "tool:agents.v2:validation",
              evidenceSha256: "c".repeat(64),
            },
          };
        },
      }),
    ).resolves.toMatchObject({ isError: true });

    await expect(
      runAdmittedToolCall({
        session: state.session,
        turnId: "turn-1",
        callId: "call-write-after-close-refusal",
        tool: {
          ...closeAgent,
          name: "write.follow-up",
        } as unknown as Tool,
        args: {},
        invoke: async ({ crossEffectBoundary }) => {
          crossEffectBoundary();
          return { content: "ok" };
        },
      }),
    ).resolves.toMatchObject({ content: "ok" });
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

  it("does not accept a free-form timeout marker as no-effect proof", async () => {
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
        invoke: async ({ crossEffectBoundary }) => {
          crossEffectBoundary();
          throw Object.assign(new Error("wait exceeded 30000ms timeout"), {
            reason: "timeout",
          });
        },
      }),
    ).rejects.toThrow("exceeded 30000ms timeout");

    const acknowledgement = state.effectEvents.at(-1);
    expect(acknowledgement?.msg.type).toBe("effect_unknown_outcome");
    if (acknowledgement?.msg.type !== "effect_unknown_outcome") {
      throw new Error("missing unknown effect result");
    }
    expect(acknowledgement.msg.payload.outcome).toBe("unknown_outcome");
  });

  it("keeps the lease occupied and resolves a timed-out effect from late settlement", async () => {
    const state = toolHarness();
    const physical = Promise.withResolvers<{ content: string }>();
    const callerTimeout = new Error("caller deadline elapsed");
    attachPendingPhysicalSettlement(callerTimeout, {
      callerStop: "timeout",
      callerStoppedAt: "2026-07-18T00:00:00.000Z",
      settlement: physical.promise,
    });
    const tool = {
      name: "write.late-settlement",
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
        callId: "call-late-settlement",
        tool,
        args: {},
        invoke: async ({ crossEffectBoundary }) => {
          crossEffectBoundary();
          throw callerTimeout;
        },
      }),
    ).rejects.toBe(callerTimeout);

    expect(state.acknowledgeCompletion).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(state.effectEvents.at(-1)?.msg).toMatchObject({
        type: "effect_unknown_outcome",
        payload: {
          callerStop: "timeout",
          callerStoppedAt: "2026-07-18T00:00:00.000Z",
          reservationId: "tool-reservation",
        },
      });
    });
    physical.resolve({ content: "physically committed" });
    await vi.waitFor(() => {
      expect(state.effectEvents.at(-1)?.msg.type).toBe(
        "effect_review_resolved",
      );
      expect(state.acknowledgeCompletion).toHaveBeenCalledOnce();
    });
    const review = state.effectEvents.at(-1)?.msg;
    expect(review).toMatchObject({
      type: "effect_review_resolved",
      payload: {
        resolution: {
          disposition: "confirmed_committed",
          workflowStatus: "resolved",
          domainAction: "mark_completed",
        },
      },
    });
  });

  it("reprojects the same unknown event after fsync instead of appending a duplicate", async () => {
    const state = toolHarness();
    let failUnknownProjection = true;
    let callerObserved = false;
    let projectionObservedStoppedCaller = false;
    Object.assign(state.session.rolloutStore as object, {
      recordEffectEvent: (event: Event) => {
        if (
          event.msg.type === "effect_unknown_outcome" &&
          failUnknownProjection
        ) {
          projectionObservedStoppedCaller = callerObserved;
          failUnknownProjection = false;
          throw new Error("simulated effect projection failure");
        }
      },
    });
    const physical = Promise.withResolvers<{ content: string }>();
    const callerTimeout = new Error("caller deadline elapsed");
    attachPendingPhysicalSettlement(callerTimeout, {
      callerStop: "timeout",
      callerStoppedAt: "2026-07-18T00:00:00.000Z",
      settlement: physical.promise,
    });
    const tool = {
      name: "write.projection-retry",
      recoveryCategory: "side-effecting",
    } as unknown as Tool;

    await expect(
      runAdmittedToolCall({
        session: state.session,
        turnId: "turn-1",
        callId: "call-projection-retry",
        tool,
        args: {},
        invoke: async ({ crossEffectBoundary }) => {
          crossEffectBoundary();
          throw callerTimeout;
        },
      }),
    ).rejects.toBe(callerTimeout);
    callerObserved = true;

    physical.resolve({ content: "committed once" });
    await vi.waitFor(() => {
      expect(state.acknowledgeCompletion).toHaveBeenCalledOnce();
    });
    expect(
      state.effectEvents.filter(
        (event) => event.msg.type === "effect_unknown_outcome",
      ),
    ).toHaveLength(1);
    expect(projectionObservedStoppedCaller).toBe(true);
    expect(
      effectSettlementMetrics(state.session).durabilityPersistenceFailures,
    ).toBe(1);
    expect(
      state.effectEvents.filter(
        (event) => event.msg.type === "effect_review_resolved",
      ),
    ).toHaveLength(1);
  });

  it("returns the typed caller stop before retrying pre-boundary evidence", async () => {
    const state = toolHarness();
    let failResultProjection = true;
    let callerObserved = false;
    let projectionObservedStoppedCaller = false;
    Object.assign(state.session.rolloutStore as object, {
      recordEffectEvent: (event: Event) => {
        if (event.msg.type === "effect_result" && failResultProjection) {
          projectionObservedStoppedCaller = callerObserved;
          failResultProjection = false;
          throw new Error("simulated pre-boundary projection failure");
        }
      },
    });
    const physical = Promise.withResolvers<{ content: string }>();
    const callerAbort = new Error("caller aborted before dispatch");
    attachPendingPhysicalSettlement(callerAbort, {
      callerStop: "abort",
      callerStoppedAt: "2026-07-18T00:00:00.000Z",
      settlement: physical.promise,
    });
    const tool = {
      name: "write.pre-boundary-projection-retry",
      recoveryCategory: "side-effecting",
    } as unknown as Tool;

    await expect(
      runAdmittedToolCall({
        session: state.session,
        turnId: "turn-1",
        callId: "call-pre-boundary-projection-retry",
        tool,
        args: {},
        invoke: async () => {
          throw callerAbort;
        },
      }),
    ).rejects.toBe(callerAbort);
    callerObserved = true;
    physical.resolve({ content: "never dispatched" });

    await vi.waitFor(() => {
      expect(state.acknowledgeCompletion).toHaveBeenCalledOnce();
    });
    expect(projectionObservedStoppedCaller).toBe(true);
    expect(
      state.effectEvents.filter((event) => event.msg.type === "effect_result"),
    ).toHaveLength(1);
    expect(state.effectEvents.at(-1)?.msg).toMatchObject({
      type: "effect_result",
      payload: {
        outcome: "cancelled",
        effectBoundary: "not_crossed",
        evidence: {
          callerStop: "abort",
          callerStoppedAt: "2026-07-18T00:00:00.000Z",
          reservationId: "tool-reservation",
        },
      },
    });
  });

  it("closes an idempotent rendezvous only after durable settlement work", async () => {
    const state = toolHarness();
    const assertToolEffectAttemptAllowed = vi
      .fn<() => number>()
      .mockReturnValueOnce(1)
      .mockReturnValueOnce(2);
    Object.assign(state.session.rolloutStore!, {
      assertToolEffectAttemptAllowed,
    });
    const physical = Promise.withResolvers<{ content: string }>();
    const callerTimeout = new Error("caller deadline elapsed");
    attachPendingPhysicalSettlement(callerTimeout, {
      callerStop: "timeout",
      callerStoppedAt: "2026-07-18T00:00:00.000Z",
      settlement: physical.promise,
    });
    const tool = {
      name: "read.rendezvous",
      recoveryCategory: "idempotent",
    } as unknown as Tool;
    const firstInvoke = vi.fn(
      async ({ crossEffectBoundary }: { crossEffectBoundary: () => void }) => {
        crossEffectBoundary();
        throw callerTimeout;
      },
    );

    await expect(
      runAdmittedToolCall({
        session: state.session,
        turnId: "turn-1",
        callId: "call-rendezvous",
        tool,
        args: { path: "same" },
        invoke: firstInvoke,
      }),
    ).rejects.toBe(callerTimeout);
    const duplicateInvoke = vi.fn(async () => ({ content: "duplicate" }));
    const duplicate = runAdmittedToolCall({
      session: state.session,
      turnId: "turn-1",
      callId: "call-rendezvous",
      stepIdSuffix: ":dispatch-2",
      tool,
      args: { path: "same" },
      invoke: duplicateInvoke,
    });
    let duplicateSettled = false;
    void duplicate.then(
      () => {
        duplicateSettled = true;
      },
      () => {
        duplicateSettled = true;
      },
    );
    await Promise.resolve();
    expect(duplicateSettled).toBe(false);

    physical.resolve({ content: "canonical result" });
    await expect(duplicate).resolves.toEqual({ content: "canonical result" });
    expect(duplicateInvoke).not.toHaveBeenCalled();
    expect(firstInvoke).toHaveBeenCalledOnce();
    expect(state.acquire).toHaveBeenCalledOnce();
    expect(state.acknowledgeCompletion).toHaveBeenCalledOnce();
    expect(state.effectEvents.map((event) => event.msg.type)).toEqual([
      "effect_intent",
      "effect_result",
    ]);

    const laterInvoke = vi.fn(
      async ({ crossEffectBoundary }: { crossEffectBoundary: () => void }) => {
        crossEffectBoundary();
        return { content: "safe same-key replay" };
      },
    );
    await expect(
      runAdmittedToolCall({
        session: state.session,
        turnId: "turn-1",
        callId: "call-rendezvous",
        tool,
        args: { path: "same" },
        invoke: laterInvoke,
      }),
    ).resolves.toMatchObject({ content: "safe same-key replay" });
    expect(laterInvoke).toHaveBeenCalledOnce();
    expect(assertToolEffectAttemptAllowed).toHaveBeenCalledTimes(2);
    expect(state.acquire).toHaveBeenCalledTimes(2);
    expect(state.acquire.mock.calls[1]?.[0]).toMatchObject({
      stepId: "tool:turn-1:call-rendezvous:dispatch2",
    });
    expect(state.effectEvents[2]?.msg).toMatchObject({
      type: "effect_intent",
      payload: { attempt: 2 },
    });
  });

  it("propagates a live idempotent rendezvous rejection without redispatch", async () => {
    const state = toolHarness();
    const physical = Promise.withResolvers<{ content: string }>();
    const callerTimeout = new Error("caller deadline elapsed");
    attachPendingPhysicalSettlement(callerTimeout, {
      callerStop: "timeout",
      callerStoppedAt: "2026-07-18T00:00:00.000Z",
      settlement: physical.promise,
    });
    const tool = {
      name: "read.rendezvous-rejection",
      recoveryCategory: "idempotent",
    } as unknown as Tool;
    const firstInvoke = vi.fn(
      async ({ crossEffectBoundary }: { crossEffectBoundary: () => void }) => {
        crossEffectBoundary();
        throw callerTimeout;
      },
    );
    await expect(
      runAdmittedToolCall({
        session: state.session,
        turnId: "turn-1",
        callId: "call-rendezvous-rejection",
        tool,
        args: { path: "same" },
        invoke: firstInvoke,
      }),
    ).rejects.toBe(callerTimeout);

    const duplicateInvoke = vi.fn(async () => ({ content: "duplicate" }));
    const duplicate = runAdmittedToolCall({
      session: state.session,
      turnId: "turn-1",
      callId: "call-rendezvous-rejection",
      tool,
      args: { path: "same" },
      invoke: duplicateInvoke,
    });
    const physicalFailure = new Error("canonical physical failure");
    physical.reject(physicalFailure);

    await expect(duplicate).rejects.toBe(physicalFailure);
    expect(duplicateInvoke).not.toHaveBeenCalled();
    expect(firstInvoke).toHaveBeenCalledOnce();
    expect(state.acquire).toHaveBeenCalledOnce();
    expect(state.acknowledgeCompletion).toHaveBeenCalledOnce();
  });

  it("suppresses late system review after a live operator resolution", async () => {
    const state = toolHarness();
    const physical = Promise.withResolvers<{ content: string }>();
    const callerTimeout = new Error("caller deadline elapsed");
    attachPendingPhysicalSettlement(callerTimeout, {
      callerStop: "timeout",
      callerStoppedAt: "2026-07-18T00:00:00.000Z",
      settlement: physical.promise,
    });
    const tool = {
      name: "write.operator-reviewed",
      recoveryCategory: "side-effecting",
    } as unknown as Tool;
    await expect(
      runAdmittedToolCall({
        session: state.session,
        turnId: "turn-1",
        callId: "call-operator-reviewed",
        tool,
        args: {},
        invoke: async ({ crossEffectBoundary }) => {
          crossEffectBoundary();
          throw callerTimeout;
        },
      }),
    ).rejects.toBe(callerTimeout);
    expect(
      resolveLiveEffectPoison(state.session, {
        callId: "call-operator-reviewed",
      }),
    ).toBe(1);

    physical.resolve({ content: "late physical success" });
    await vi.waitFor(() => {
      expect(state.acknowledgeCompletion).toHaveBeenCalledOnce();
    });
    expect(
      state.effectEvents.filter(
        (event) => event.msg.type === "effect_review_resolved",
      ),
    ).toHaveLength(0);
  });

  it("hands a post-timeout effect to forced shutdown without leaking a lease", async () => {
    const state = toolHarness();
    await shutdownEffectSettlementSupervisor(state.session, 0);
    const physical = Promise.withResolvers<{ content: string }>();
    const callerTimeout = new Error("caller deadline elapsed");
    attachPendingPhysicalSettlement(callerTimeout, {
      callerStop: "timeout",
      callerStoppedAt: "2026-07-18T00:00:00.000Z",
      settlement: physical.promise,
    });
    const tool = {
      name: "write.shutdown-race",
      recoveryCategory: "side-effecting",
    } as unknown as Tool;

    await expect(
      runAdmittedToolCall({
        session: state.session,
        turnId: "turn-1",
        callId: "call-shutdown-race",
        tool,
        args: {},
        invoke: async ({ crossEffectBoundary }) => {
          crossEffectBoundary();
          throw callerTimeout;
        },
      }),
    ).rejects.toBe(callerTimeout);
    await vi.waitFor(() => {
      expect(state.acknowledgeCompletion).toHaveBeenCalledOnce();
    });
    expect(state.holdUnknown).toHaveBeenCalledWith(
      "tool-reservation",
      "physical_settlement_exceeded_shutdown_drain",
    );
    expect(
      effectSettlementMetrics(state.session).occupiedPostTimeoutLeases,
    ).toBe(0);
  });

  it("keeps a late rejected settlement unknown and blocks dependent effects", async () => {
    const state = toolHarness();
    const physical = Promise.withResolvers<{ content: string }>();
    const callerTimeout = new Error("caller deadline elapsed");
    attachPendingPhysicalSettlement(callerTimeout, {
      callerStop: "timeout",
      callerStoppedAt: "2026-07-18T00:00:00.000Z",
      settlement: physical.promise,
    });
    const tool = {
      name: "write.late-rejection",
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
        callId: "call-late-rejection",
        tool,
        args: {},
        invoke: async ({ crossEffectBoundary }) => {
          crossEffectBoundary();
          throw callerTimeout;
        },
      }),
    ).rejects.toBe(callerTimeout);

    physical.reject(new Error("transport ended without a receipt"));
    await vi.waitFor(() => {
      expect(state.effectEvents.at(-1)?.msg).toMatchObject({
        type: "effect_review_resolved",
        payload: {
          resolution: {
            disposition: "remains_unknown",
            workflowStatus: "pending",
          },
        },
      });
      expect(state.acknowledgeCompletion).toHaveBeenCalledOnce();
    });

    await expect(
      runAdmittedToolCall({
        session: state.session,
        turnId: "turn-1",
        callId: "dependent-call",
        tool,
        args: {},
        invoke: async ({ crossEffectBoundary }) => {
          crossEffectBoundary();
          return { content: "must not run" };
        },
      }),
    ).rejects.toMatchObject({
      code: "UNKNOWN_OUTCOME_MUTATION_BLOCKED",
    });
    expect(state.acquire).toHaveBeenCalledOnce();
  });

  it("keeps an explicit late non-error unknown disposition pending", async () => {
    const state = toolHarness();
    const physical = Promise.withResolvers<{
      content: string;
      effectDisposition: {
        disposition: "remains_unknown";
        evidenceKind: "provider_receipt";
        evidenceRef: string;
        evidenceSha256: string;
      };
    }>();
    const callerTimeout = new Error("caller deadline elapsed");
    attachPendingPhysicalSettlement(callerTimeout, {
      callerStop: "timeout",
      callerStoppedAt: "2026-07-18T00:00:00.000Z",
      settlement: physical.promise,
    });
    const tool = {
      name: "write.late-unknown-receipt",
      recoveryCategory: "side-effecting",
    } as unknown as Tool;

    await expect(
      runAdmittedToolCall({
        session: state.session,
        turnId: "turn-1",
        callId: "call-late-unknown-receipt",
        tool,
        args: {},
        invoke: async ({ crossEffectBoundary }) => {
          crossEffectBoundary();
          throw callerTimeout;
        },
      }),
    ).rejects.toBe(callerTimeout);

    physical.resolve({
      content: "request accepted but state could not be observed",
      effectDisposition: {
        disposition: "remains_unknown",
        evidenceKind: "provider_receipt",
        evidenceRef: "provider-receipt:late-unknown-1",
        evidenceSha256: "d".repeat(64),
      },
    });
    await vi.waitFor(() => {
      expect(state.effectEvents.at(-1)?.msg).toMatchObject({
        type: "effect_review_resolved",
        payload: {
          resolution: {
            disposition: "remains_unknown",
            evidenceRef: "provider-receipt:late-unknown-1",
            evidenceSha256: "d".repeat(64),
            workflowStatus: "pending",
          },
        },
      });
      expect(state.acknowledgeCompletion).toHaveBeenCalledOnce();
    });
    expect(
      state.effectEvents.filter((event) => event.msg.type === "effect_result"),
    ).toHaveLength(0);
  });
});
