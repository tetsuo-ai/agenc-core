/** Shared M3 boundary for approved tool effects. */

import { createHash, randomUUID } from "node:crypto";

import {
  EFFECT_EVIDENCE_FORMAT_VERSION,
  EFFECT_EVIDENCE_MINIMUM_READER_RUNTIME,
  type EffectBoundary,
  type EffectNoEffectProof,
  type EffectReviewResolution,
  type ToolEffectDispositionEvidence,
} from "../contracts/run-contracts.js";
import {
  M4DurabilityFailpointError,
  hitM4DurabilityFailpoint,
} from "../durability/failpoints.js";
import type {
  EffectIntentEvent,
  EffectReviewResolvedEvent,
  EffectResultEvent,
  EffectUnknownOutcomeEvent,
  Event,
  EventMsg,
} from "../session/event-log.js";
import type { Session } from "../session/session.js";
import type { Tool, ToolRecoveryCategory } from "../tools/types.js";
import type { ToolDispatchResult } from "../tool-registry.js";
import {
  readEffectBoundaryNotCrossed,
  validateToolEffectDispositionEvidence,
} from "../tools/effect-boundary.js";
import { readPendingPhysicalSettlement } from "../tools/physical-settlement.js";
import {
  AdmissionDeniedError,
  type ExecutionAdmissionClient,
} from "./admission-client.js";
import {
  assertNoLiveUnknownEffect,
  clearLiveEffectPoison,
  incrementEffectSettlementMetric,
  liveEffectWasExternallyResolved,
  poisonLiveEffect,
  readIdempotentRendezvous,
  registerEffectSettlementObserver,
  type LiveEffectIdentity,
} from "./effect-settlement-supervisor.js";

export interface AdmittedToolCallOptions {
  readonly session: Session;
  readonly turnId: string;
  readonly callId: string;
  readonly tool: Tool;
  readonly args: Readonly<Record<string, unknown>>;
  readonly signal?: AbortSignal;
  /**
   * Suffix appended to the persisted admission stepId for PHYSICAL
   * re-dispatches of the same logical tool call (transient retry, sandbox
   * escalation). The first attempt's admission record is already terminal by
   * then, and the kernel dedupes by stepId — without a fresh stepId the
   * legitimate retry is denied as `admission_already_terminal` (observed:
   * sandbox escalation of a plan-file Write surfaced exactly that to the
   * model instead of running unsandboxed). Genuine new calls keep the bare
   * stepId, so dedupe protection is unchanged.
   */
  readonly stepIdSuffix?: string;
  readonly invoke: (
    context: AdmittedToolDispatchContext,
  ) => Promise<ToolDispatchResult>;
}

export interface AdmittedToolDispatchContext {
  readonly signal: AbortSignal;
  readonly abortController: AbortController;
  /** Cross exactly once, immediately before the physical effect starts. */
  readonly crossEffectBoundary: () => void;
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

interface EffectEventCommit {
  readonly event?: Event;
  readonly projectionError?: unknown;
}

const EFFECT_PERSISTENCE_RETRY_INITIAL_MS = 10;
const EFFECT_PERSISTENCE_RETRY_MAX_MS = 250;
const EFFECT_PERSISTENCE_RETRY_MULTIPLIER = 2;

class EffectProjectionAfterCommitError extends Error {
  constructor(
    readonly event: Event,
    options: { readonly cause: unknown },
  ) {
    super(
      `durable ${event.msg.type} event ${event.eventId ?? event.id} could not be projected`,
      options,
    );
    this.name = "EffectProjectionAfterCommitError";
  }
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

function logicalIdempotencyKey(params: {
  readonly runId: string;
  readonly callId: string;
  readonly toolName: string;
  readonly args: Readonly<Record<string, unknown>>;
}): string {
  return `sha256:${effectDigest({
    version: 1,
    runId: params.runId,
    callId: params.callId,
    toolName: params.toolName,
    args: params.args,
    purpose: "idempotency",
  })}`;
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
        | "effect_intent"
        | "effect_result"
        | "effect_unknown_outcome"
        | "effect_review_resolved";
    }
  >,
): EffectEventCommit {
  const emit = (session as { readonly emit?: Session["emit"] }).emit;
  if (session.rolloutStore == null || typeof emit !== "function") {
    if (session.services?.admissionRequired !== false) {
      throw new AdmissionDeniedError("effect_journal_unavailable");
    }
    return {};
  }
  const event = emit.call(
    session,
    { id: randomUUID(), msg },
    { durable: true },
  );
  if (!Number.isSafeInteger(event.seq) || (event.seq ?? 0) <= 0) {
    throw new AdmissionDeniedError("effect_journal_sequence_missing");
  }
  try {
    effectProjection(session)?.recordEffectEvent(event);
    return { event };
  } catch (projectionError) {
    return { event, projectionError };
  }
}

function requireEffectProjection(commit: EffectEventCommit): void {
  if (commit.projectionError === undefined) return;
  if (commit.event === undefined) throw commit.projectionError;
  throw new EffectProjectionAfterCommitError(commit.event, {
    cause: commit.projectionError,
  });
}

function projectCommittedEffectEvent(session: Session, event: Event): void {
  try {
    effectProjection(session)?.recordEffectEvent(event);
  } catch (projectionError) {
    throw new EffectProjectionAfterCommitError(event, {
      cause: projectionError,
    });
  }
}

function appendEffectIntent(params: {
  readonly session: Session;
  readonly runId: string;
  readonly stepId: string;
  readonly attempt: number;
  readonly callId: string;
  readonly tool: Tool;
  readonly args: Readonly<Record<string, unknown>>;
  readonly recoveryCategory: ToolRecoveryCategory;
}): EffectJournalContext {
  const intentIdentity = {
    version: 1,
    runId: params.runId,
    stepId: params.stepId,
    attempt: params.attempt,
    callId: params.callId,
    toolName: params.tool.name,
    recoveryCategory: params.recoveryCategory,
    args: params.args,
  } as const;
  const intentDigest = effectDigest(intentIdentity);
  // Physical retry suffixes deliberately do not participate. Every retry of
  // one logical call must rendezvous on the original key.
  const idempotencyKey =
    params.recoveryCategory === "idempotent"
      ? logicalIdempotencyKey({
          runId: params.runId,
          callId: params.callId,
          toolName: params.tool.name,
          args: params.args,
        })
      : undefined;
  const payload: EffectIntentEvent = {
    formatVersion: EFFECT_EVIDENCE_FORMAT_VERSION,
    minimumReaderRuntime: EFFECT_EVIDENCE_MINIMUM_READER_RUNTIME,
    runId: params.runId,
    stepId: params.stepId,
    callId: params.callId,
    toolName: params.tool.name,
    recoveryCategory: params.recoveryCategory,
    ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    intentDigest,
    attempt: params.attempt,
    recordedAt: new Date().toISOString(),
  };
  const commit = appendEffectEvent(params.session, {
    type: "effect_intent",
    payload,
  });
  requireEffectProjection(commit);
  return {
    ...payload,
    intentEventSeq: commit.event?.seq ?? 0,
  };
}

function appendEffectResult(
  session: Session,
  context: EffectJournalContext,
  options: {
    readonly outcome: EffectResultEvent["outcome"];
    readonly effectBoundary?: EffectBoundary;
    readonly noEffectEvidence?: EffectNoEffectProof;
    readonly result?: ToolDispatchResult;
    readonly evidence?: Readonly<Record<string, unknown>>;
  },
): EffectEventCommit {
  const payload: EffectResultEvent = {
    formatVersion: EFFECT_EVIDENCE_FORMAT_VERSION,
    minimumReaderRuntime: EFFECT_EVIDENCE_MINIMUM_READER_RUNTIME,
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
    effectBoundary: options.effectBoundary,
    ...(options.noEffectEvidence !== undefined
      ? { noEffectEvidence: options.noEffectEvidence }
      : {}),
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
  const commit = appendEffectEvent(session, { type: "effect_result", payload });
  hitM4DurabilityFailpoint("after_tool_ack_commit");
  return commit;
}

function appendEffectUnknownOutcome(
  session: Session,
  context: EffectJournalContext,
  options: {
    readonly reason: string;
    readonly callerStop?: "timeout" | "abort";
    readonly callerStoppedAt?: string;
    readonly reservationId?: string;
  },
): EffectEventCommit {
  const payload: EffectUnknownOutcomeEvent = {
    formatVersion: EFFECT_EVIDENCE_FORMAT_VERSION,
    minimumReaderRuntime: EFFECT_EVIDENCE_MINIMUM_READER_RUNTIME,
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
    reason: options.reason,
    requiresReview: true,
    ...(options.callerStop !== undefined
      ? { callerStop: options.callerStop }
      : {}),
    ...(options.callerStoppedAt !== undefined
      ? { callerStoppedAt: options.callerStoppedAt }
      : {}),
    ...(options.reservationId !== undefined
      ? { reservationId: options.reservationId }
      : {}),
    recordedAt: new Date().toISOString(),
  };
  hitM4DurabilityFailpoint("before_tool_ack_commit");
  const commit = appendEffectEvent(session, {
    type: "effect_unknown_outcome",
    payload,
  });
  hitM4DurabilityFailpoint("after_tool_ack_commit");
  return commit;
}

async function persistCallerStopEvidence(
  session: Session,
  signal: AbortSignal,
  persist: () => void,
): Promise<void> {
  let retryDelayMs = EFFECT_PERSISTENCE_RETRY_INITIAL_MS;
  while (!signal.aborted) {
    try {
      persist();
      return;
    } catch (error) {
      if (error instanceof M4DurabilityFailpointError) throw error;
      incrementEffectSettlementMetric(session, "durabilityPersistenceFailures");
      await waitForPersistenceRetry(retryDelayMs, signal);
      retryDelayMs = Math.min(
        EFFECT_PERSISTENCE_RETRY_MAX_MS,
        retryDelayMs * EFFECT_PERSISTENCE_RETRY_MULTIPLIER,
      );
    }
  }
}

function waitForPersistenceRetry(
  delayMs: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    timer = setTimeout(finish, delayMs);
    signal.addEventListener("abort", finish, { once: true });
  });
}

function appendEffectReview(
  session: Session,
  context: EffectJournalContext,
  resolution: EffectReviewResolution,
): EffectEventCommit {
  const payload: EffectReviewResolvedEvent = {
    runId: context.runId,
    stepId: context.stepId,
    callId: context.callId,
    resolution,
  };
  return appendEffectEvent(session, {
    type: "effect_review_resolved",
    payload,
  });
}

function errorEvidence(error: unknown): Readonly<Record<string, unknown>> {
  if (!(error instanceof Error)) return { errorType: typeof error };
  const code = (error as { readonly code?: unknown }).code;
  return {
    errorName: error.name,
    ...(typeof code === "string" ? { errorCode: code } : {}),
  };
}

function noEffectProof(
  context: EffectJournalContext,
  observedAt: string,
  error?: unknown,
): EffectNoEffectProof {
  const trusted = readEffectBoundaryNotCrossed(error, observedAt);
  if (trusted !== undefined) return trusted;
  const evidenceRef = `admission-boundary:not-crossed:${context.runId}:${context.stepId}`;
  return {
    version: 1,
    kind: "effect_no_effect_proof",
    evidenceKind: "boundary_not_crossed",
    evidenceRef,
    evidenceSha256: effectDigest({ evidenceRef, observedAt }),
    observedAt,
  };
}

function dispositionNoEffectProof(
  evidence: ToolEffectDispositionEvidence,
  observedAt: string,
): EffectNoEffectProof {
  if (evidence.disposition !== "confirmed_no_effect") {
    throw new TypeError("confirmed no-effect evidence is required");
  }
  return {
    version: 1,
    kind: "effect_no_effect_proof",
    evidenceKind: evidence.evidenceKind,
    evidenceRef: evidence.evidenceRef,
    evidenceSha256: evidence.evidenceSha256,
    observedAt,
  };
}

function physicalResultDigest(result: ToolDispatchResult): string {
  return effectDigest({
    content: result.content,
    isError: result.isError === true,
    preventContinuation: result.preventContinuation === true,
    admissionUsage: result.admissionUsage ?? null,
  });
}

function settlementResolution(
  context: EffectJournalContext,
  result: ToolDispatchResult | undefined,
  error: unknown,
  reviewedAt: string,
): EffectReviewResolution {
  const disposition = validateToolEffectDispositionEvidence(
    result?.effectDisposition,
  );
  if (disposition?.disposition === "confirmed_committed") {
    return {
      version: 1,
      kind: "effect_review_resolution",
      disposition: "confirmed_committed",
      actorKind: "system_settlement",
      actorId: "effect-settlement-supervisor",
      evidenceKind: disposition.evidenceKind,
      evidenceRef: disposition.evidenceRef,
      evidenceSha256: disposition.evidenceSha256,
      reviewedAt,
      workflowStatus: "resolved",
      domainAction: "mark_completed",
    };
  }
  if (disposition?.disposition === "confirmed_no_effect") {
    return {
      version: 1,
      kind: "effect_review_resolution",
      disposition: "confirmed_no_effect",
      actorKind: "system_settlement",
      actorId: "effect-settlement-supervisor",
      evidenceKind: disposition.evidenceKind,
      evidenceRef: disposition.evidenceRef,
      evidenceSha256: disposition.evidenceSha256,
      reviewedAt,
      workflowStatus: "resolved",
      domainAction: "retry_new_attempt",
    };
  }
  if (disposition?.disposition === "remains_unknown") {
    return {
      version: 1,
      kind: "effect_review_resolution",
      disposition: "remains_unknown",
      actorKind: "system_settlement",
      actorId: "effect-settlement-supervisor",
      evidenceKind: disposition.evidenceKind,
      evidenceRef: disposition.evidenceRef,
      evidenceSha256: disposition.evidenceSha256,
      reviewedAt,
      workflowStatus: "pending",
    };
  }
  const noEffectEvidence = readEffectBoundaryNotCrossed(error, reviewedAt);
  if (noEffectEvidence !== undefined) {
    return {
      version: 1,
      kind: "effect_review_resolution",
      disposition: "confirmed_no_effect",
      actorKind: "system_settlement",
      actorId: "effect-settlement-supervisor",
      evidenceKind: noEffectEvidence.evidenceKind,
      evidenceRef: noEffectEvidence.evidenceRef,
      evidenceSha256: noEffectEvidence.evidenceSha256,
      reviewedAt,
      workflowStatus: "resolved",
      domainAction: "retry_new_attempt",
    };
  }
  if (result !== undefined && result.isError !== true) {
    const evidenceRef = `physical-settlement:${context.callId}`;
    return {
      version: 1,
      kind: "effect_review_resolution",
      disposition: "confirmed_committed",
      actorKind: "system_settlement",
      actorId: "effect-settlement-supervisor",
      evidenceKind: "provider_receipt",
      evidenceRef,
      evidenceSha256: physicalResultDigest(result),
      reviewedAt,
      workflowStatus: "resolved",
      domainAction: "mark_completed",
    };
  }
  const evidence =
    result === undefined
      ? errorEvidence(error)
      : {
          resultDigest: physicalResultDigest(result),
          isError: result.isError === true,
        };
  const evidenceRef = `physical-settlement:unresolved:${context.callId}`;
  return {
    version: 1,
    kind: "effect_review_resolution",
    disposition: "remains_unknown",
    actorKind: "system_settlement",
    actorId: "effect-settlement-supervisor",
    evidenceKind: "provider_receipt",
    evidenceRef,
    evidenceSha256: effectDigest(evidence),
    reviewedAt,
    workflowStatus: "pending",
  };
}

function reconcileToolUsage(
  client: ExecutionAdmissionClient | undefined,
  reservationId: string,
  estimate: {
    readonly maxInputTokens: number;
    readonly maxOutputTokens: number;
    readonly maxCostUsd: number | null;
  },
  result: ToolDispatchResult | undefined,
  session: Session,
  missingUsageReason = "missing_tool_usage",
): "provider_overrun" | undefined {
  if (client === undefined) return undefined;
  if (
    result?.admissionUsage !== undefined &&
    !validUsage(result.admissionUsage)
  ) {
    client.holdUnknown(reservationId, "invalid_tool_usage");
    incrementEffectSettlementMetric(session, "heldAccounting");
    return undefined;
  }
  if (validUsage(result?.admissionUsage)) {
    const outcome = client.reconcile(reservationId, result.admissionUsage);
    if (outcome.outcome === "provider_overrun") {
      session.abortTerminal("provider_overrun");
      void session.services?.agentControl.shutdownAgentTree?.(
        session.conversationId,
      );
      return "provider_overrun";
    }
    return undefined;
  }
  if (isZeroBound(estimate)) {
    client.reconcile(reservationId, {
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    });
    return undefined;
  }
  client.holdUnknown(reservationId, missingUsageReason);
  incrementEffectSettlementMetric(session, "heldAccounting");
  return undefined;
}

/**
 * Runs after permission/approval but immediately before `tool.execute`.
 * Local tools reserve a zero monetary charge while still consuming durable
 * capacity. Model-backed tools make their nested charged calls through the
 * model boundary and therefore do not double-charge here.
 */
function createDispatchContext(
  source?: AbortSignal,
  onCross: () => void = () => {},
): {
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
  const crossEffectBoundary = (): void => {
    if (abortController.signal.aborted) {
      const reason = abortController.signal.reason;
      throw reason instanceof Error
        ? reason
        : new AdmissionDeniedError(
            "tool_cancelled_before_dispatch",
            "cancelled",
          );
    }
    onCross();
  };
  return {
    context: {
      signal: abortController.signal,
      abortController,
      crossEffectBoundary,
    },
    cleanup: () => source?.removeEventListener("abort", forwardAbort),
  };
}

function liveIdentity(context: EffectJournalContext): LiveEffectIdentity {
  return {
    runId: context.runId,
    stepId: context.stepId,
    callId: context.callId,
    toolName: context.toolName,
    recoveryCategory: context.recoveryCategory,
    ...(context.idempotencyKey !== undefined
      ? { idempotencyKey: context.idempotencyKey }
      : {}),
  };
}

/**
 * Run an admitted tool while keeping caller completion separate from physical
 * settlement. A timeout/abort may stop the caller, but it never fabricates a
 * failed/no-effect outcome and never releases the physical concurrency lease.
 */
export async function runAdmittedToolCall(
  params: AdmittedToolCallOptions,
): Promise<ToolDispatchResult> {
  const category = recoveryCategory(params.tool);
  assertNoLiveUnknownEffect(params.session, category);
  params.session.rolloutStore?.assertToolAdmissionAllowed(category);

  const client = params.session.services?.executionAdmission;
  if (
    client === undefined &&
    params.session.services?.admissionRequired !== false
  ) {
    throw new AdmissionDeniedError("admission_kernel_unavailable");
  }

  const logicalRunId = client?.scope.runId ?? params.session.conversationId;
  const idempotencyKey =
    category === "idempotent"
      ? logicalIdempotencyKey({
          runId: logicalRunId,
          callId: params.callId,
          toolName: params.tool.name,
          args: params.args,
        })
      : undefined;
  if (idempotencyKey !== undefined) {
    const active = readIdempotentRendezvous<ToolDispatchResult>(
      params.session,
      idempotencyKey,
    );
    if (active !== undefined) {
      const outcome = await active;
      if (outcome.kind === "fulfilled") return outcome.value;
      if (outcome.kind === "rejected" || outcome.kind === "observer_failed") {
        throw outcome.reason;
      }
      throw new AdmissionDeniedError(
        "idempotent_effect_settlement_forced_during_shutdown",
      );
    }
  }

  const retryGate = params.session.rolloutStore as {
    assertToolEffectAttemptAllowed?(options: {
      readonly callId: string;
      readonly recoveryCategory: ToolRecoveryCategory;
      readonly idempotencyKey?: string;
    }): number;
  } | null;
  const attempt =
    retryGate?.assertToolEffectAttemptAllowed?.({
      callId: params.callId,
      recoveryCategory: category,
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    }) ?? 1;
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new AdmissionDeniedError("effect_attempt_number_invalid");
  }
  const retrySuffix = attempt > 1 ? `:dispatch${attempt}` : "";
  const stepId =
    `tool:${params.turnId}:${params.callId}` +
    (params.stepIdSuffix ?? retrySuffix);

  const estimate = params.tool.admissionEstimate?.(params.args) ?? {
    maxInputTokens: 0,
    maxOutputTokens: 0,
    maxCostUsd: null,
  };
  const lease =
    client === undefined
      ? undefined
      : await client.acquire(
          {
            stepId,
            kind: "tool_exec",
            sessionId: params.session.conversationId,
            parentScopeId: params.turnId,
            maxInputTokens: estimate.maxInputTokens,
            maxOutputTokens: estimate.maxOutputTokens,
            maxCostUsd: estimate.maxCostUsd,
          },
          params.signal,
        );
  const reservationId = lease?.reservation.reservationId;
  const runId = lease?.reservation.step.runId ?? logicalRunId;
  const durableStepId = lease?.reservation.step.stepId ?? stepId;
  let boundaryCrossed = false;
  const dispatch = createDispatchContext(lease?.signal ?? params.signal, () => {
    if (boundaryCrossed) return;
    if (reservationId !== undefined) {
      client?.markDispatched(reservationId, {
        boundary: "tool_effect",
        details: {
          toolName: params.tool.name,
          recoveryCategory: category,
          maxCostUsd: estimate.maxCostUsd,
        },
      });
    }
    boundaryCrossed = true;
    hitM4DurabilityFailpoint("after_tool_spawn");
  });

  let journal: EffectJournalContext;
  try {
    journal = appendEffectIntent({
      session: params.session,
      runId,
      stepId: durableStepId,
      attempt,
      callId: params.callId,
      tool: params.tool,
      args: params.args,
      recoveryCategory: category,
    });
  } catch (error) {
    if (reservationId !== undefined) {
      client?.void(reservationId, "effect_intent_commit_failed");
      client?.acknowledgeCompletion(reservationId);
    }
    dispatch.cleanup();
    throw error;
  }

  let effectClosed = false;
  let admissionSettled = false;
  let observerOwnsPhysical = false;
  let crashInjected = false;
  try {
    const cancelledBeforeDispatch = cancellationAfterDispatch(
      dispatch.context.signal,
    );
    if (cancelledBeforeDispatch !== undefined) {
      const observedAt = new Date().toISOString();
      const commit = appendEffectResult(params.session, journal, {
        outcome: "cancelled",
        effectBoundary: "not_crossed",
        noEffectEvidence: noEffectProof(journal, observedAt),
        evidence: { reason: "cancelled_before_dispatch" },
      });
      effectClosed = true;
      if (reservationId !== undefined) {
        client?.void(reservationId, "tool_cancelled_before_dispatch");
        admissionSettled = true;
      }
      requireEffectProjection(commit);
      throw cancelledBeforeDispatch;
    }

    hitM4DurabilityFailpoint("before_tool_spawn");
    const result = await params.invoke(dispatch.context);
    const lateCancellation = cancellationAfterDispatch(
      lease?.signal ?? dispatch.context.signal,
    );
    const recordedAt = new Date().toISOString();
    const disposition = validateToolEffectDispositionEvidence(
      result.effectDisposition,
    );
    let commit: EffectEventCommit;

    if (!boundaryCrossed) {
      commit = appendEffectResult(params.session, journal, {
        outcome: result.isError === true ? "failed" : "cancelled",
        effectBoundary: "not_crossed",
        noEffectEvidence: noEffectProof(journal, recordedAt),
        result,
        evidence: { reason: "dispatch_returned_before_effect_boundary" },
      });
    } else if (
      category !== "idempotent" &&
      (disposition?.disposition === "remains_unknown" ||
        (result.isError === true &&
          disposition?.disposition !== "confirmed_committed" &&
          disposition?.disposition !== "confirmed_no_effect"))
    ) {
      poisonLiveEffect(params.session, liveIdentity(journal));
      commit = appendEffectUnknownOutcome(params.session, journal, {
        reason:
          disposition?.disposition === "remains_unknown"
            ? "adapter_reported_unknown_effect_disposition"
            : "tool_error_result_without_authoritative_effect_disposition",
        ...(reservationId !== undefined ? { reservationId } : {}),
      });
    } else {
      commit = appendEffectResult(params.session, journal, {
        outcome:
          disposition?.disposition === "confirmed_no_effect"
            ? "failed"
            : disposition?.disposition === "remains_unknown"
              ? "failed"
              : disposition?.disposition === "confirmed_committed" ||
                  result.isError !== true
                ? "committed"
                : "failed",
        effectBoundary: "crossed",
        ...(disposition?.disposition === "confirmed_no_effect"
          ? {
              noEffectEvidence: dispositionNoEffectProof(
                disposition,
                recordedAt,
              ),
            }
          : {}),
        result,
        ...(reservationId !== undefined ? { evidence: { reservationId } } : {}),
      });
    }
    effectClosed = true;

    if (reservationId !== undefined) {
      const accounting = reconcileToolUsage(
        client,
        reservationId,
        estimate,
        result,
        params.session,
      );
      admissionSettled = true;
      if (accounting === "provider_overrun") {
        if (lateCancellation !== undefined) throw lateCancellation;
        throw new AdmissionDeniedError("provider_overrun");
      }
    }
    requireEffectProjection(commit);
    if (lateCancellation !== undefined && category !== "idempotent") {
      throw lateCancellation;
    }
    return result;
  } catch (error) {
    if (error instanceof M4DurabilityFailpointError) {
      crashInjected = true;
      throw error;
    }
    if (effectClosed) throw error;

    const pending = readPendingPhysicalSettlement<ToolDispatchResult>(error);
    if (pending !== undefined) {
      if (pending.callerStop === "timeout") {
        incrementEffectSettlementMetric(params.session, "callerTimeouts");
      } else {
        incrementEffectSettlementMetric(params.session, "callerAborts");
      }
      let unknownEvent: Event | undefined;
      let unknownProjected = false;
      let preBoundaryEvent: Event | undefined;
      let preBoundaryProjected = false;
      const ensureUnknownRecorded = (): void => {
        if (unknownProjected || category === "idempotent" || !boundaryCrossed) {
          return;
        }
        if (unknownEvent !== undefined) {
          projectCommittedEffectEvent(params.session, unknownEvent);
          unknownProjected = true;
          return;
        }
        const commit = appendEffectUnknownOutcome(params.session, journal, {
          reason:
            pending.callerStop === "timeout"
              ? "caller_timeout_after_effect_boundary"
              : "caller_abort_after_effect_boundary",
          callerStop: pending.callerStop,
          callerStoppedAt: pending.callerStoppedAt,
          ...(reservationId !== undefined ? { reservationId } : {}),
        });
        unknownEvent = commit.event;
        requireEffectProjection(commit);
        unknownProjected = true;
      };
      const ensurePreBoundaryRecorded = (): void => {
        if (preBoundaryProjected || boundaryCrossed) return;
        if (preBoundaryEvent !== undefined) {
          projectCommittedEffectEvent(params.session, preBoundaryEvent);
          preBoundaryProjected = true;
          effectClosed = true;
        } else {
          const observedAt = new Date().toISOString();
          const commit = appendEffectResult(params.session, journal, {
            outcome: "cancelled",
            effectBoundary: "not_crossed",
            noEffectEvidence: noEffectProof(journal, observedAt, error),
            evidence: {
              reason: `${pending.callerStop}_before_effect_boundary`,
              callerStop: pending.callerStop,
              callerStoppedAt: pending.callerStoppedAt,
              ...(reservationId !== undefined ? { reservationId } : {}),
            },
          });
          preBoundaryEvent = commit.event;
          requireEffectProjection(commit);
          preBoundaryProjected = true;
          effectClosed = true;
        }
        if (reservationId !== undefined && !admissionSettled) {
          client?.void(
            reservationId,
            `tool_${pending.callerStop}_before_dispatch`,
          );
          admissionSettled = true;
        }
      };
      const ensureCallerStopEvidence = (): void => {
        if (boundaryCrossed) {
          ensureUnknownRecorded();
        } else {
          ensurePreBoundaryRecorded();
        }
      };
      const callerStopEvidenceRequired =
        !boundaryCrossed || category !== "idempotent";

      if (boundaryCrossed && category !== "idempotent") {
        // This synchronous poison is the immediate retry/mutation gate. Durable
        // evidence is deliberately deferred so storage latency cannot replace
        // or delay the typed caller timeout/abort.
        poisonLiveEffect(params.session, liveIdentity(journal));
      }

      const identity = liveIdentity(journal);
      const observation = registerEffectSettlementObserver(params.session, {
        identity,
        settlement: pending.settlement,
        ...(callerStopEvidenceRequired
          ? {
              beforeSettlement: (signal: AbortSignal) =>
                persistCallerStopEvidence(
                  params.session,
                  signal,
                  ensureCallerStopEvidence,
                ),
            }
          : {}),
        onSettled: async (settlement) => {
          const settleAdmission = (): void => {
            if (reservationId === undefined || admissionSettled) return;
            const rejectionWithoutNoEffectProof =
              settlement.kind === "rejected" &&
              category !== "idempotent" &&
              boundaryCrossed &&
              readEffectBoundaryNotCrossed(
                settlement.reason,
                new Date().toISOString(),
              ) === undefined;
            if (rejectionWithoutNoEffectProof) {
              client?.holdUnknown(
                reservationId,
                pending.callerStop === "abort"
                  ? "tool_cancelled_after_dispatch"
                  : "tool_timeout_after_dispatch",
              );
              incrementEffectSettlementMetric(params.session, "heldAccounting");
            } else {
              reconcileToolUsage(
                client,
                reservationId,
                estimate,
                settlement.kind === "fulfilled" ? settlement.value : undefined,
                params.session,
              );
            }
            admissionSettled = true;
          };
          try {
            if (category !== "idempotent" && boundaryCrossed) {
              ensureUnknownRecorded();
              if (!liveEffectWasExternallyResolved(params.session, identity)) {
                const resolution = settlementResolution(
                  journal,
                  settlement.kind === "fulfilled"
                    ? settlement.value
                    : undefined,
                  settlement.kind === "rejected"
                    ? settlement.reason
                    : undefined,
                  new Date().toISOString(),
                );
                const commit = appendEffectReview(
                  params.session,
                  journal,
                  resolution,
                );
                requireEffectProjection(commit);
                if (resolution.workflowStatus !== "pending") {
                  clearLiveEffectPoison(params.session, identity);
                  incrementEffectSettlementMetric(
                    params.session,
                    "lateReviewResolutions",
                  );
                }
              }
            } else if (category === "idempotent" && !effectClosed) {
              const result =
                settlement.kind === "fulfilled" ? settlement.value : undefined;
              const disposition = validateToolEffectDispositionEvidence(
                result?.effectDisposition,
              );
              const settledAt = new Date().toISOString();
              const commit = appendEffectResult(params.session, journal, {
                outcome:
                  disposition?.disposition === "confirmed_no_effect"
                    ? "failed"
                    : disposition?.disposition === "remains_unknown"
                      ? "failed"
                      : result !== undefined &&
                          (result.isError !== true ||
                            disposition?.disposition === "confirmed_committed")
                        ? "committed"
                        : "failed",
                effectBoundary: "crossed",
                ...(disposition?.disposition === "confirmed_no_effect"
                  ? {
                      noEffectEvidence: dispositionNoEffectProof(
                        disposition,
                        settledAt,
                      ),
                    }
                  : {}),
                ...(result !== undefined ? { result } : {}),
                evidence:
                  settlement.kind === "rejected"
                    ? errorEvidence(settlement.reason)
                    : { latePhysicalSettlement: true },
              });
              effectClosed = true;
              requireEffectProjection(commit);
            }
            settleAdmission();
          } catch (settlementError) {
            settleAdmission();
            throw settlementError;
          } finally {
            if (reservationId !== undefined) {
              client?.acknowledgeCompletion(reservationId);
            }
            dispatch.cleanup();
          }
        },
        onForcedShutdown: async () => {
          try {
            if (callerStopEvidenceRequired) {
              ensureCallerStopEvidence();
            }
            if (reservationId !== undefined && !admissionSettled) {
              client?.holdUnknown(
                reservationId,
                "physical_settlement_exceeded_shutdown_drain",
              );
              incrementEffectSettlementMetric(params.session, "heldAccounting");
              admissionSettled = true;
            }
          } catch (shutdownError) {
            if (reservationId !== undefined && !admissionSettled) {
              client?.holdUnknown(
                reservationId,
                "physical_settlement_shutdown_processing_failed",
              );
              incrementEffectSettlementMetric(params.session, "heldAccounting");
              admissionSettled = true;
            }
            throw shutdownError;
          } finally {
            if (reservationId !== undefined) {
              client?.acknowledgeCompletion(reservationId);
            }
            dispatch.cleanup();
          }
        },
      });
      observerOwnsPhysical = true;
      void observation;
      throw error;
    }

    const observedAt = new Date().toISOString();
    const authoritativeNoEffect = readEffectBoundaryNotCrossed(
      error,
      observedAt,
    );
    if (!boundaryCrossed || authoritativeNoEffect !== undefined) {
      const commit = appendEffectResult(params.session, journal, {
        outcome: dispatch.context.signal.aborted ? "cancelled" : "failed",
        effectBoundary: boundaryCrossed ? "crossed" : "not_crossed",
        noEffectEvidence:
          authoritativeNoEffect ?? noEffectProof(journal, observedAt, error),
        evidence: errorEvidence(error),
      });
      if (reservationId !== undefined) {
        if (boundaryCrossed) {
          reconcileToolUsage(
            client,
            reservationId,
            estimate,
            undefined,
            params.session,
            "no_effect_usage_unavailable",
          );
        } else {
          client?.void(reservationId, "tool_failed_before_dispatch");
        }
        admissionSettled = true;
      }
      effectClosed = true;
      requireEffectProjection(commit);
    } else if (category !== "idempotent") {
      poisonLiveEffect(params.session, liveIdentity(journal));
      const commit = appendEffectUnknownOutcome(params.session, journal, {
        reason: dispatch.context.signal.aborted
          ? "tool_cancelled_after_effect_boundary"
          : "tool_failed_after_effect_boundary_without_disposition",
        ...(reservationId !== undefined ? { reservationId } : {}),
      });
      if (reservationId !== undefined) {
        reconcileToolUsage(
          client,
          reservationId,
          estimate,
          undefined,
          params.session,
          "tool_failed_after_effect_boundary",
        );
        admissionSettled = true;
      }
      effectClosed = true;
      requireEffectProjection(commit);
    } else {
      const commit = appendEffectResult(params.session, journal, {
        outcome: dispatch.context.signal.aborted ? "cancelled" : "failed",
        effectBoundary: "crossed",
        evidence: errorEvidence(error),
      });
      if (reservationId !== undefined) {
        reconcileToolUsage(
          client,
          reservationId,
          estimate,
          undefined,
          params.session,
          "tool_failed_after_effect_boundary",
        );
        admissionSettled = true;
      }
      effectClosed = true;
      requireEffectProjection(commit);
    }
    throw error;
  } finally {
    if (!observerOwnsPhysical && !crashInjected) {
      if (reservationId !== undefined && !admissionSettled) {
        if (boundaryCrossed) {
          client?.holdUnknown(
            reservationId,
            "effect_completion_processing_failed",
          );
          incrementEffectSettlementMetric(params.session, "heldAccounting");
        } else {
          client?.void(reservationId, "tool_failed_before_dispatch");
        }
        admissionSettled = true;
      }
      if (reservationId !== undefined) {
        client?.acknowledgeCompletion(reservationId);
      }
      dispatch.cleanup();
    }
  }
}
