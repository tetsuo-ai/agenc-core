/** Shared M3 boundary for approved tool effects. */

import type { Session } from "../session/session.js";
import type { Tool, ToolRecoveryCategory } from "../tools/types.js";
import type { ToolDispatchResult } from "../tool-registry.js";
import { AdmissionDeniedError } from "./admission-client.js";

export interface AdmittedToolCallOptions {
  readonly session: Session;
  readonly turnId: string;
  readonly callId: string;
  readonly tool: Tool;
  readonly args: Readonly<Record<string, unknown>>;
  readonly signal?: AbortSignal;
  readonly invoke: (
    context: AdmittedToolDispatchContext,
  ) => Promise<ToolDispatchResult>;
}

export interface AdmittedToolDispatchContext {
  readonly signal: AbortSignal;
  readonly abortController: AbortController;
}

function recoveryCategory(tool: Tool): ToolRecoveryCategory {
  return tool.recoveryCategory ?? "side-effecting";
}

function isZeroBound(estimate: {
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly maxCostUsd: number | null;
}): boolean {
  return (
    estimate.maxInputTokens === 0 &&
    estimate.maxOutputTokens === 0 &&
    estimate.maxCostUsd === 0
  );
}

function validUsage(
  usage: ToolDispatchResult["admissionUsage"],
): usage is NonNullable<ToolDispatchResult["admissionUsage"]> {
  return (
    usage !== undefined &&
    Number.isSafeInteger(usage.inputTokens) &&
    usage.inputTokens >= 0 &&
    Number.isSafeInteger(usage.outputTokens) &&
    usage.outputTokens >= 0 &&
    Number.isFinite(usage.costUsd) &&
    usage.costUsd >= 0
  );
}

function cancellationAfterDispatch(signal: AbortSignal): Error | undefined {
  if (!signal.aborted) return undefined;
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  return new AdmissionDeniedError(
    typeof reason === "string" && reason.length > 0
      ? reason
      : "admission_cancelled",
    "cancelled",
  );
}

/**
 * Runs after permission/approval but immediately before `tool.execute`.
 * Local tools reserve a zero monetary charge while still consuming durable
 * capacity. Model-backed tools make their nested charged calls through the
 * model boundary and therefore do not double-charge here.
 */
export async function runAdmittedToolCall(
  params: AdmittedToolCallOptions,
): Promise<ToolDispatchResult> {
  const category = recoveryCategory(params.tool);
  params.session.rolloutStore?.assertToolAdmissionAllowed(category);

  const client = params.session.services?.executionAdmission;
  if (client === undefined) {
    if (params.session.services?.admissionRequired !== false) {
      throw new AdmissionDeniedError("admission_kernel_unavailable");
    }
    const dispatch = createDispatchContext(params.signal);
    try {
      return await params.invoke(dispatch.context);
    } finally {
      dispatch.cleanup();
    }
  }

  // Missing pricing is never interpreted as free. Core local tools are
  // explicitly decorated with a zero bound by the registry; extension and
  // future tools remain unpriced until their owner supplies a contract.
  const estimate = params.tool.admissionEstimate?.(params.args) ?? {
    maxInputTokens: 0,
    maxOutputTokens: 0,
    maxCostUsd: null,
  };
  const lease = await client.acquire(
    {
      stepId: `tool:${params.turnId}:${params.callId}`,
      kind: "tool_exec",
      sessionId: params.session.conversationId,
      parentScopeId: params.turnId,
      maxInputTokens: estimate.maxInputTokens,
      maxOutputTokens: estimate.maxOutputTokens,
      maxCostUsd: estimate.maxCostUsd,
    },
    params.signal,
  );
  const reservationId = lease.reservation.reservationId;
  const dispatch = createDispatchContext(lease.signal);
  let dispatched = false;
  let settled = false;
  let lateCancellation: Error | undefined;
  try {
    client.markDispatched(reservationId, {
      boundary: "tool_effect",
      details: {
        toolName: params.tool.name,
        recoveryCategory: category,
        maxCostUsd: estimate.maxCostUsd,
      },
    });
    dispatched = true;
    const result = await params.invoke(dispatch.context);
    // Snapshot cancellation at physical effect settlement. Reconciliation can
    // itself abort on overrun and must not be mistaken for an earlier cancel.
    lateCancellation = cancellationAfterDispatch(lease.signal);
    if (result.admissionUsage !== undefined && !validUsage(result.admissionUsage)) {
      client.holdUnknown(reservationId, "invalid_tool_usage");
      settled = true;
    } else if (validUsage(result.admissionUsage)) {
      const outcome = client.reconcile(reservationId, result.admissionUsage);
      settled = true;
      if (outcome.outcome === "provider_overrun") {
        params.session.abortTerminal("provider_overrun");
        void params.session.services?.agentControl.shutdownAgentTree?.(
          params.session.conversationId,
        );
        if (lateCancellation !== undefined) throw lateCancellation;
        throw new AdmissionDeniedError("provider_overrun");
      }
    } else if (isZeroBound(estimate)) {
      client.reconcile(reservationId, {
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
      });
      settled = true;
    } else {
      client.holdUnknown(reservationId, "missing_tool_usage");
      settled = true;
    }
    // Preserve any late authoritative usage, but an abort-ignoring tool must
    // not turn a durably cancelled effect back into caller-visible success.
    if (lateCancellation !== undefined) throw lateCancellation;
    return result;
  } catch (error) {
    if (settled) {
      throw error;
    } else if (dispatched && dispatch.context.signal.aborted) {
      client.holdUnknown(reservationId, "tool_cancelled_after_dispatch");
    } else if (dispatched && isZeroBound(estimate)) {
      client.reconcile(reservationId, {
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
      });
    } else if (dispatched) {
      client.holdUnknown(reservationId, "tool_failed_after_dispatch");
    } else {
      client.void(reservationId, "tool_failed_before_dispatch");
    }
    if (lateCancellation !== undefined) throw lateCancellation;
    throw error;
  } finally {
    // Cancellation records the durable unknown outcome at once while keeping
    // live capacity occupied until even an abort-ignoring tool promise settles.
    client.acknowledgeCompletion(reservationId);
    dispatch.cleanup();
  }
}

function createDispatchContext(source?: AbortSignal): {
  readonly context: AdmittedToolDispatchContext;
  readonly cleanup: () => void;
} {
  const abortController = new AbortController();
  const forwardAbort = (): void => {
    if (abortController.signal.aborted) return;
    abortController.abort(source?.reason);
  };
  if (source?.aborted) {
    forwardAbort();
  } else {
    source?.addEventListener("abort", forwardAbort, { once: true });
  }
  return {
    context: { signal: abortController.signal, abortController },
    cleanup: () => source?.removeEventListener("abort", forwardAbort),
  };
}
