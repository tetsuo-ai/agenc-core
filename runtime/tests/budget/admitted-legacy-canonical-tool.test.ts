import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  AdmissionAcquireInput,
  ExecutionAdmissionClient,
} from "../../src/budget/admission-client.js";
import { AdmissionDeniedError } from "../../src/budget/admission-client.js";
import type { AdmissionLease } from "../../src/budget/admission-types.js";
import {
  clearCurrentRuntimeSession,
  runWithCurrentRuntimeSession,
} from "../../src/session/current-session.js";
import type { Session } from "../../src/session/session.js";
import { createTestEffectJournal } from "../helpers/test-effect-journal.js";
import {
  attachToolRuntimeContext,
  type ToolRuntimeAttemptContext,
} from "../../src/tools/runtimes/context.js";

const runtimeFileRead = vi.hoisted(() => ({
  execute: vi.fn(),
  estimate: vi.fn(),
}));

vi.mock("../../src/tools/system/file-read.js", () => ({
  createFileReadTool: () => ({
    name: "FileRead",
    description: "test canonical file read",
    inputSchema: { type: "object" },
    recoveryCategory: "idempotent",
    admissionEstimate: runtimeFileRead.estimate,
    execute: runtimeFileRead.execute,
  }),
}));

import { CanonicalFileReadTool } from "../../src/tools/canonicalToolSurface.js";

function admissionHarness(signal = new AbortController().signal) {
  const acquire = vi.fn(
    async (input: AdmissionAcquireInput): Promise<AdmissionLease> => ({
      decision: "allow",
      reservation: {
        reservationId: `reservation:${input.stepId}`,
        step: { runId: "run-legacy", stepId: input.stepId },
        reservedCostUsd: input.maxCostUsd ?? 0,
        reservedTokens: input.maxInputTokens + input.maxOutputTokens,
        reservedAt: "2026-07-18T00:00:00.000Z",
      },
      request: {
        step: { runId: "run-legacy", stepId: input.stepId },
        kind: input.kind,
        estimate: {
          maxInputTokens: input.maxInputTokens,
          maxOutputTokens: input.maxOutputTokens,
          maxCostUsd: input.maxCostUsd,
        },
        workspaceId: "workspace-legacy",
        sessionId: "session-legacy",
        parentScopeId: input.parentScopeId,
        autonomous: false,
      },
      signal,
    }),
  );
  const admission = {
    scope: {
      runId: "run-legacy",
      workspaceId: "workspace-legacy",
      sessionId: "session-legacy",
      autonomous: false,
    },
    acquire,
    markDispatched: vi.fn(),
    reconcile: vi.fn(() => ({ applied: true, outcome: "reconciled" })),
    holdUnknown: vi.fn(),
    void: vi.fn(),
    acknowledgeCompletion: vi.fn(),
    recordFallback: vi.fn(),
    forSession: vi.fn(),
    subscribe: vi.fn(() => () => {}),
  } as unknown as ExecutionAdmissionClient;
  const effectJournal = createTestEffectJournal();
  const session = {
    ...effectJournal,
    conversationId: "session-legacy",
    activeTurn: { unsafePeek: () => ({ turnId: "turn-legacy" }) },
    services: {
      executionAdmission: admission,
      admissionRequired: true,
    },
  } as unknown as Session;
  return { admission, acquire, session };
}

function toolContext(abortController = new AbortController()) {
  return { abortController } as never;
}

afterEach(() => {
  clearCurrentRuntimeSession();
  runtimeFileRead.execute.mockReset();
  runtimeFileRead.estimate.mockReset();
});

describe("canonical legacy tool admission", () => {
  it("admits direct calls with mapped estimates and reconciles authoritative usage", async () => {
    const state = admissionHarness();
    runtimeFileRead.estimate.mockReturnValue({
      maxInputTokens: 11,
      maxOutputTokens: 7,
      maxCostUsd: 0.5,
    });
    runtimeFileRead.execute.mockResolvedValue({
      content: "allowed",
      admissionUsage: { inputTokens: 3, outputTokens: 2, costUsd: 0.125 },
    });

    const result = await runWithCurrentRuntimeSession(state.session, () =>
      CanonicalFileReadTool.call(
        { file_path: "README.md" },
        toolContext(),
        undefined as never,
        undefined as never,
      ),
    );

    expect(result).toMatchObject({
      data: "allowed",
      admissionUsage: { inputTokens: 3, outputTokens: 2, costUsd: 0.125 },
    });
    expect(runtimeFileRead.estimate).toHaveBeenCalledWith(
      expect.objectContaining({
        file_path: "README.md",
        cwd: expect.any(String),
      }),
    );
    expect(state.acquire).toHaveBeenCalledWith(
      expect.objectContaining({
        stepId: expect.stringMatching(/^tool:turn-legacy:/u),
        maxInputTokens: 11,
        maxOutputTokens: 7,
        maxCostUsd: 0.5,
      }),
      expect.any(AbortSignal),
    );
    expect(state.admission.markDispatched).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        details: expect.objectContaining({
          toolName: "FileRead",
          recoveryCategory: "idempotent",
        }),
      }),
    );
    expect(state.admission.reconcile).toHaveBeenCalledWith(expect.any(String), {
      inputTokens: 3,
      outputTokens: 2,
      costUsd: 0.125,
    });
  });

  it("fails closed before execution when the ambient session has no kernel", async () => {
    const session = {
      conversationId: "session-no-kernel",
      activeTurn: { unsafePeek: () => ({ turnId: "turn-no-kernel" }) },
      services: { admissionRequired: true },
    } as unknown as Session;

    await expect(
      runWithCurrentRuntimeSession(session, () =>
        CanonicalFileReadTool.call(
          { file_path: "README.md" },
          toolContext(),
          undefined as never,
          undefined as never,
        ),
      ),
    ).rejects.toEqual(new AdmissionDeniedError("admission_kernel_unavailable"));
    expect(runtimeFileRead.execute).not.toHaveBeenCalled();
  });

  it("fails closed when no unambiguous ambient session owns the call", async () => {
    await expect(
      CanonicalFileReadTool.call(
        { file_path: "README.md" },
        toolContext(),
        undefined as never,
        undefined as never,
      ),
    ).rejects.toEqual(
      new AdmissionDeniedError("tool_admission_session_unavailable"),
    );
    expect(runtimeFileRead.execute).not.toHaveBeenCalled();
  });

  it("forwards lease cancellation to the canonical effect and holds its outcome unknown", async () => {
    const leaseController = new AbortController();
    const state = admissionHarness(leaseController.signal);
    runtimeFileRead.estimate.mockReturnValue({
      maxInputTokens: 0,
      maxOutputTokens: 0,
      maxCostUsd: 0,
    });
    const started = Promise.withResolvers<AbortSignal>();
    runtimeFileRead.execute.mockImplementation(async (args) => {
      const signal = args.__abortSignal as AbortSignal;
      started.resolve(signal);
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    });

    const call = runWithCurrentRuntimeSession(state.session, () =>
      CanonicalFileReadTool.call(
        { file_path: "README.md" },
        toolContext(),
        undefined as never,
        undefined as never,
      ),
    );
    const effectSignal = await started.promise;
    const cancellation = new AdmissionDeniedError(
      "parent_cancelled",
      "cancelled",
    );
    leaseController.abort(cancellation);

    await expect(call).rejects.toBe(cancellation);
    expect(effectSignal.aborted).toBe(true);
    expect(state.admission.holdUnknown).toHaveBeenCalledWith(
      expect.any(String),
      "tool_cancelled_after_dispatch",
    );
  });

  it("does not double-admit a call carrying the authenticated router context", async () => {
    runtimeFileRead.execute.mockResolvedValue({ content: "router-allowed" });
    const input: Record<string, unknown> = { file_path: "README.md" };
    attachToolRuntimeContext(input, {
      callId: "router-call",
      toolName: "FileRead",
      runtimeKind: "function",
      classification: { kind: "exclusive" },
      supportsParallelToolCalls: false,
      source: "direct",
      submittedAtMs: 0,
      approvalPolicy: "never",
      requestedSandboxMode: "danger_full_access",
      sandboxMode: "danger_full_access",
      approvalResolved: true,
      rawArgs: JSON.stringify(input),
      invocation: {} as never,
    } satisfies ToolRuntimeAttemptContext);

    await expect(
      CanonicalFileReadTool.call(
        input as never,
        toolContext(),
        undefined as never,
        undefined as never,
      ),
    ).resolves.toMatchObject({ data: "router-allowed" });
  });
});
