import { vi } from "vitest";

import type {
  AdmissionAcquireInput,
  ExecutionAdmissionClient,
} from "../../src/budget/admission-client.js";
import { AdmissionDeniedError } from "../../src/budget/admission-client.js";
import type { AdmissionLease } from "../../src/budget/admission-types.js";

export type AllowAdmissionScope = {
  readonly maxCostUsd?: number;
  readonly maxTokens?: number;
  readonly hasHardCostCap?: boolean;
  readonly hasHardTokenCap?: boolean;
};

export type AllowAdmissionHarnessOptions = {
  readonly reservationId?: string;
  readonly parentScopeId?: string;
  readonly reservedAt?: string;
  readonly rejectDenialReason?: boolean;
  readonly scope?: AllowAdmissionScope;
};

export function createAllowAdmissionHarness(
  options: AllowAdmissionHarnessOptions = {},
) {
  const leaseController = new AbortController();
  const reservationId = options.reservationId ?? "reservation-1";
  const parentScopeId = options.parentScopeId ?? "session-1";
  const reservedAt = options.reservedAt ?? "2026-07-18T00:00:00.000Z";
  const scopeOptions = options.scope;
  const reconcile = vi.fn(() => ({
    applied: true as const,
    outcome: "reconciled" as const,
  }));
  const holdUnknown = vi.fn();
  const cancelRun = vi.fn();
  const acknowledgeCompletion = vi.fn();
  const voidReservation = vi.fn();
  const recordFallback = vi.fn();
  const markDispatched = vi.fn();
  const acquire = vi.fn(
    async (input: AdmissionAcquireInput): Promise<AdmissionLease> => {
      if (options.rejectDenialReason !== false && input.denialReason !== undefined) {
        throw new AdmissionDeniedError(input.denialReason);
      }
      return {
        decision: "allow",
        reservation: {
          reservationId,
          step: { runId: "run-1", stepId: input.stepId },
          reservedCostUsd: input.maxCostUsd ?? 0,
          reservedTokens: input.maxInputTokens + input.maxOutputTokens,
          reservedAt,
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
          parentScopeId,
          autonomous: false,
        },
        signal: leaseController.signal,
      };
    },
  );
  const admission = {
    scope: {
      runId: "run-1",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      autonomous: false,
      ...(scopeOptions?.maxCostUsd !== undefined
        ? { maxCostUsd: scopeOptions.maxCostUsd }
        : {}),
      ...(scopeOptions?.maxTokens !== undefined
        ? { maxTokens: scopeOptions.maxTokens }
        : {}),
      ...(scopeOptions?.hasHardCostCap === true ? { hasHardCostCap: true } : {}),
      ...(scopeOptions?.hasHardTokenCap === true ? { hasHardTokenCap: true } : {}),
    },
    acquire,
    markDispatched,
    reconcile,
    holdUnknown,
    cancelRun,
    void: voidReservation,
    acknowledgeCompletion,
    recordFallback,
    forSession: vi.fn(),
    subscribe: vi.fn(() => () => {}),
  } as unknown as ExecutionAdmissionClient;
  return {
    acknowledgeCompletion,
    acquire,
    admission,
    cancelRun,
    holdUnknown,
    leaseController,
    markDispatched,
    recordFallback,
    reconcile,
    voidReservation,
  };
}
