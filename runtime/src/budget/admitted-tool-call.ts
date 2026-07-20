/** Shared M3 boundary for approved tool effects. */

import { createHash, randomUUID } from "node:crypto";

import {
  M4DurabilityFailpointError,
  hitM4DurabilityFailpoint,
} from "../durability/failpoints.js";
import type {
  EffectIntentEvent,
  EffectResultEvent,
  EffectUnknownOutcomeEvent,
  Event,
  EventMsg,
} from "../session/event-log.js";
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

/**
 * Optional rebuildable state projection for the canonical rollout journal.
 * The JSONL event is always fsync-committed first; a projection failure stops
 * dispatch/continuation and can be repaired by replaying that journal.
 */
export interface ToolEffectDurabilityProjection {
  recordEffectEvent(event: Event): void;
}

interface EffectJournalContext {
  readonly runId: string;
  readonly stepId: string;
  readonly callId: string;
  readonly toolName: string;
  readonly recoveryCategory: ToolRecoveryCategory;
  readonly idempotencyKey?: string;
  readonly intentDigest: string;
  readonly intentEventSeq: number;
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

function canonicalEffectValue(
  value: unknown,
  ancestors = new WeakSet<object>(),
): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "undefined":
      return "undefined";
    case "boolean":
      return value ? "boolean:true" : "boolean:false";
    case "string":
      return `string:${JSON.stringify(value)}`;
    case "number":
      if (Number.isNaN(value)) return "number:NaN";
      if (value === Number.POSITIVE_INFINITY) return "number:+Infinity";
      if (value === Number.NEGATIVE_INFINITY) return "number:-Infinity";
      if (Object.is(value, -0)) return "number:-0";
      return `number:${String(value)}`;
    case "bigint":
      return `bigint:${value.toString(10)}`;
    case "symbol":
    case "function":
      throw new TypeError(`unsupported effect digest value: ${typeof value}`);
    case "object":
      break;
  }
  if (ancestors.has(value)) {
    throw new TypeError("circular effect digest value");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `array:[${value
        .map((entry) => canonicalEffectValue(entry, ancestors))
        .join(",")}]`;
    }
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}=${canonicalEffectValue(record[key], ancestors)}`,
      );
    return `object:{${entries.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function effectDigest(value: unknown): string {
  return createHash("sha256")
    .update(canonicalEffectValue(value), "utf8")
    .digest("hex");
}

function effectProjection(
  session: Session,
): ToolEffectDurabilityProjection | undefined {
  const rolloutProjection = session.rolloutStore as
    ToolEffectDurabilityProjection | null | undefined;
  if (typeof rolloutProjection?.recordEffectEvent === "function") {
    return rolloutProjection;
  }
  return (
    session.services as
      { readonly effectDurability?: ToolEffectDurabilityProjection } | undefined
  )?.effectDurability;
}

function appendEffectEvent(
  session: Session,
  msg: Extract<
    EventMsg,
    {
      readonly type:
        "effect_intent" | "effect_result" | "effect_unknown_outcome";
    }
  >,
): Event | undefined {
  const emit = (session as { readonly emit?: Session["emit"] }).emit;
  if (session.rolloutStore == null || typeof emit !== "function") {
    if (session.services?.admissionRequired !== false) {
      throw new AdmissionDeniedError("effect_journal_unavailable");
    }
    return undefined;
  }
  const event = emit.call(
    session,
    { id: randomUUID(), msg },
    { durable: true },
  );
  if (!Number.isSafeInteger(event.seq) || (event.seq ?? 0) <= 0) {
    throw new AdmissionDeniedError("effect_journal_sequence_missing");
  }
  effectProjection(session)?.recordEffectEvent(event);
  return event;
}

function appendEffectIntent(params: {
  readonly session: Session;
  readonly runId: string;
  readonly stepId: string;
  readonly callId: string;
  readonly tool: Tool;
  readonly args: Readonly<Record<string, unknown>>;
  readonly recoveryCategory: ToolRecoveryCategory;
}): EffectJournalContext {
  const identity = {
    version: 1,
    runId: params.runId,
    stepId: params.stepId,
    callId: params.callId,
    toolName: params.tool.name,
    recoveryCategory: params.recoveryCategory,
    args: params.args,
  } as const;
  const intentDigest = effectDigest(identity);
  const idempotencyKey =
    params.recoveryCategory === "idempotent"
      ? `sha256:${effectDigest({ ...identity, purpose: "idempotency" })}`
      : undefined;
  const payload: EffectIntentEvent = {
    runId: params.runId,
    stepId: params.stepId,
    callId: params.callId,
    toolName: params.tool.name,
    recoveryCategory: params.recoveryCategory,
    ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    intentDigest,
    attempt: 1,
    recordedAt: new Date().toISOString(),
  };
  const event = appendEffectEvent(params.session, {
    type: "effect_intent",
    payload,
  });
  return {
    ...payload,
    intentEventSeq: event?.seq ?? 0,
  };
}

function appendEffectResult(
  session: Session,
  context: EffectJournalContext,
  options: {
    readonly outcome: EffectResultEvent["outcome"];
    readonly result?: ToolDispatchResult;
    readonly evidence?: Readonly<Record<string, unknown>>;
  },
): void {
  const payload: EffectResultEvent = {
    runId: context.runId,
    stepId: context.stepId,
    callId: context.callId,
    toolName: context.toolName,
    recoveryCategory: context.recoveryCategory,
    ...(context.idempotencyKey !== undefined
      ? { idempotencyKey: context.idempotencyKey }
      : {}),
    intentEventSeq: context.intentEventSeq,
    outcome: options.outcome,
    ...(options.result !== undefined
      ? {
          resultDigest: effectDigest({
            content: options.result.content,
            isError: options.result.isError === true,
            preventContinuation: options.result.preventContinuation === true,
            admissionUsage: options.result.admissionUsage ?? null,
          }),
        }
      : {}),
    ...(options.evidence !== undefined ? { evidence: options.evidence } : {}),
    recordedAt: new Date().toISOString(),
  };
  hitM4DurabilityFailpoint("before_tool_ack_commit");
  appendEffectEvent(session, { type: "effect_result", payload });
  hitM4DurabilityFailpoint("after_tool_ack_commit");
}

function appendEffectUnknownOutcome(
  session: Session,
  context: EffectJournalContext,
  reason: string,
): void {
  const payload: EffectUnknownOutcomeEvent = {
    runId: context.runId,
    stepId: context.stepId,
    callId: context.callId,
    toolName: context.toolName,
    recoveryCategory: context.recoveryCategory,
    ...(context.idempotencyKey !== undefined
      ? { idempotencyKey: context.idempotencyKey }
      : {}),
    intentEventSeq: context.intentEventSeq,
    outcome: "unknown_outcome",
    reason,
    requiresReview: true,
    recordedAt: new Date().toISOString(),
  };
  hitM4DurabilityFailpoint("before_tool_ack_commit");
  appendEffectEvent(session, { type: "effect_unknown_outcome", payload });
  hitM4DurabilityFailpoint("after_tool_ack_commit");
}

function errorEvidence(error: unknown): Readonly<Record<string, unknown>> {
  if (!(error instanceof Error)) return { errorType: typeof error };
  const code = (error as { readonly code?: unknown }).code;
  return {
    errorName: error.name,
    ...(typeof code === "string" ? { errorCode: code } : {}),
  };
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
    const stepId = `tool:${params.turnId}:${params.callId}`;
    let effect: EffectJournalContext | undefined;
    let dispatched = false;
    let acknowledgementStarted = false;
    let acknowledged = false;
    try {
      effect = appendEffectIntent({
        session: params.session,
        runId: params.session.conversationId,
        stepId,
        callId: params.callId,
        tool: params.tool,
        args: params.args,
        recoveryCategory: category,
      });
      const cancelledBeforeDispatch = cancellationAfterDispatch(
        dispatch.context.signal,
      );
      if (cancelledBeforeDispatch !== undefined) {
        acknowledgementStarted = true;
        appendEffectResult(params.session, effect, {
          outcome: "cancelled",
          evidence: { reason: "cancelled_before_dispatch" },
        });
        acknowledged = true;
        throw cancelledBeforeDispatch;
      }
      hitM4DurabilityFailpoint("before_tool_spawn");
      dispatched = true;
      const pending = params.invoke(dispatch.context);
      hitM4DurabilityFailpoint("after_tool_spawn");
      const result = await pending;
      acknowledgementStarted = true;
      appendEffectResult(params.session, effect, {
        outcome: result.isError === true ? "failed" : "committed",
        result,
      });
      acknowledged = true;
      // The physical tool result won the race with cancellation. Preserve it
      // so streamed tool history remains complete and the committed effect
      // evidence agrees with the caller-visible outcome. Admission-backed
      // calls have a separate durable cancellation authority below.
      return result;
    } catch (error) {
      if (error instanceof M4DurabilityFailpointError) throw error;
      if (effect !== undefined && !acknowledgementStarted && !acknowledged) {
        acknowledgementStarted = true;
        if (dispatched && category !== "idempotent") {
          // A tool-reported timeout (ToolTimeoutError.reason === "timeout")
          // is a DETERMINATE failure — the tool explicitly says it did not
          // complete. Recording it as an unknown outcome instead poisons the
          // whole session behind the M4 operator-review gate for a routine
          // 30s wait (observed: a slow write_stdin wait blocked every later
          // side-effecting call). Structural check — no import of the heavy
          // tools/execution chain.
          const isToolTimeout =
            error instanceof Error &&
            (error as { readonly reason?: unknown }).reason === "timeout";
          if (isToolTimeout) {
            appendEffectResult(params.session, effect, {
              outcome: "failed",
              evidence: errorEvidence(error),
            });
          } else {
            appendEffectUnknownOutcome(
              params.session,
              effect,
              dispatch.context.signal.aborted
                ? "tool_cancelled_after_dispatch"
                : "tool_failed_after_dispatch_without_acknowledgement",
            );
          }
        } else {
          appendEffectResult(params.session, effect, {
            outcome: dispatch.context.signal.aborted ? "cancelled" : "failed",
            evidence: errorEvidence(error),
          });
        }
        acknowledged = true;
      }
      throw error;
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
  let effect: EffectJournalContext | undefined;
  let dispatched = false;
  let settled = false;
  let lateCancellation: Error | undefined;
  let acknowledgementStarted = false;
  let acknowledged = false;
  let crashInjected = false;
  try {
    effect = appendEffectIntent({
      session: params.session,
      runId: lease.reservation.step.runId,
      stepId: lease.reservation.step.stepId,
      callId: params.callId,
      tool: params.tool,
      args: params.args,
      recoveryCategory: category,
    });
    const cancelledBeforeDispatch = cancellationAfterDispatch(
      dispatch.context.signal,
    );
    if (cancelledBeforeDispatch !== undefined) {
      acknowledgementStarted = true;
      appendEffectResult(params.session, effect, {
        outcome: "cancelled",
        evidence: { reason: "cancelled_before_dispatch" },
      });
      acknowledged = true;
      client.void(reservationId, "tool_cancelled_before_dispatch");
      settled = true;
      throw cancelledBeforeDispatch;
    }
    hitM4DurabilityFailpoint("before_tool_spawn");
    client.markDispatched(reservationId, {
      boundary: "tool_effect",
      details: {
        toolName: params.tool.name,
        recoveryCategory: category,
        maxCostUsd: estimate.maxCostUsd,
      },
    });
    dispatched = true;
    const pending = params.invoke(dispatch.context);
    hitM4DurabilityFailpoint("after_tool_spawn");
    const result = await pending;
    // Snapshot cancellation at physical effect settlement. Reconciliation can
    // itself abort on overrun and must not be mistaken for an earlier cancel.
    lateCancellation = cancellationAfterDispatch(lease.signal);
    acknowledgementStarted = true;
    appendEffectResult(params.session, effect, {
      outcome: result.isError === true ? "failed" : "committed",
      result,
      evidence: { reservationId },
    });
    acknowledged = true;
    if (
      result.admissionUsage !== undefined &&
      !validUsage(result.admissionUsage)
    ) {
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
    if (error instanceof M4DurabilityFailpointError) {
      crashInjected = true;
      throw error;
    }
    if (effect !== undefined && !acknowledgementStarted && !acknowledged) {
      acknowledgementStarted = true;
      if (dispatched && category !== "idempotent") {
        appendEffectUnknownOutcome(
          params.session,
          effect,
          dispatch.context.signal.aborted
            ? "tool_cancelled_after_dispatch"
            : "tool_failed_after_dispatch_without_acknowledgement",
        );
      } else {
        appendEffectResult(params.session, effect, {
          outcome: dispatch.context.signal.aborted ? "cancelled" : "failed",
          evidence: {
            reservationId,
            ...errorEvidence(error),
          },
        });
      }
      acknowledged = true;
    }
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
    if (!crashInjected) client.acknowledgeCompletion(reservationId);
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
