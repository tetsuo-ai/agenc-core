/**
 * Tiny pure helpers extracted from `ChatExecutor` (Phase F of the
 * 16-phase refactor in TODO.MD).
 *
 * These functions depend only on `ExecutionContext` fields, not on
 * any `ChatExecutor` instance state. Moving them out of the class
 * body is a prerequisite for the larger extractions of
 * `executeRequest`, `initializeExecutionContext`, and
 * `callModelForPhase` that Phase F proper targets.
 *
 * All functions here are side-effect free except
 * `appendToolRecord`, which mutates the ctx's tool call ledger.
 * The mutation is localized and doesn't touch class state.
 *
 * @module
 */

import { didToolCallFail } from "./chat-executor-tool-utils.js";
import { toStatefulReconciliationMessage } from "./chat-executor-text.js";
import type {
  ChatExecutionTraceEvent,
  ExecutionContext,
  ToolCallRecord,
} from "./chat-executor-types.js";
import type { LLMMessage } from "./types.js";
import type { LLMPipelineStopReason } from "./policy.js";
import type { PromptBudgetSection } from "./prompt-budget.js";

/**
 * Push a tool call record onto the ctx's tool call ledger and
 * increment the failure counter when the record reports an error.
 * Pure mutation on ctx — no class state involved.
 */
export function appendToolRecord(
  ctx: ExecutionContext,
  record: ToolCallRecord,
): void {
  ctx.allToolCalls.push(record);
  if (didToolCallFail(record.isError, record.result)) {
    ctx.failedToolCalls++;
  }
}

/**
 * Whether the ctx still has model-recall budget remaining. The
 * first call is always free (ctx.modelCalls === 0); subsequent
 * calls are bounded by `ctx.effectiveMaxModelRecalls`. A bound of
 * 0 or lower means unlimited.
 */
export function hasModelRecallBudget(ctx: ExecutionContext): boolean {
  if (ctx.modelCalls === 0) return true;
  if (ctx.effectiveMaxModelRecalls <= 0) return true;
  return ctx.modelCalls - 1 < ctx.effectiveMaxModelRecalls;
}

/**
 * Milliseconds remaining until the ctx's end-to-end request
 * deadline fires. Returns `Infinity` when the request timeout is
 * disabled (`effectiveRequestTimeoutMs <= 0`). Negative values
 * indicate the deadline has already passed.
 */
export function getRemainingRequestMs(ctx: ExecutionContext): number {
  if (ctx.effectiveRequestTimeoutMs <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  return ctx.requestDeadlineAt - Date.now();
}

/**
 * Normalize a request timeout value for serialization into trace
 * payloads and diagnostics. Finite positive values pass through;
 * everything else (0, negative, NaN, Infinity) serializes to
 * `null` so the receiving side can treat it as "unlimited".
 */
export function serializeRequestTimeoutMs(
  timeoutMs: number,
): number | null {
  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : null;
}

/**
 * Normalize a remaining-request-milliseconds value for
 * serialization. Finite values clamp to `[0, ∞)`;
 * non-finite (Infinity / NaN) serializes to `null`.
 */
export function serializeRemainingRequestMs(
  remainingRequestMs: number,
): number | null {
  return Number.isFinite(remainingRequestMs)
    ? Math.max(0, remainingRequestMs)
    : null;
}

/**
 * Build the diagnostic message body for a request-timeout stop
 * reason. When `requestTimeoutMs <= 0` the configured timeout is
 * effectively unlimited, so the detail omits the numeric value.
 */
export function buildTimeoutDetail(
  stage: string,
  requestTimeoutMs: number,
): string {
  if (requestTimeoutMs <= 0) {
    return `Request exceeded end-to-end timeout during ${stage}`;
  }
  return `Request exceeded end-to-end timeout (${requestTimeoutMs}ms) during ${stage}`;
}

/**
 * Append a message to the ctx message array, synchronously updating
 * the reconciliation message ledger and the per-message section tag.
 * Pure mutation on ctx — no class state involved.
 *
 * Phase F extraction (PR-1). Previously `ChatExecutor.pushMessage`.
 */
export function pushMessage(
  ctx: ExecutionContext,
  nextMessage: LLMMessage,
  section: PromptBudgetSection,
  reconciliationMessage?: LLMMessage,
): void {
  ctx.messages.push(nextMessage);
  ctx.reconciliationMessages.push(
    toStatefulReconciliationMessage(reconciliationMessage ?? nextMessage),
  );
  ctx.messageSections.push(section);
}

/**
 * Set the pipeline stop reason. Implements the canonical "first
 * non-completed reason wins" precedence: a stop reason can only be
 * recorded when the current stop reason is `"completed"` (the
 * initial state). Subsequent calls are silently dropped to preserve
 * the authoritative first failure rather than letting later phases
 * overwrite it with looser codes.
 *
 * The only legitimate bypass paths are documented at their call
 * sites:
 *   - The supersededStopReason reset near the executeRequest return
 *     path (rolls a soft validation_error back to completed when a
 *     follow-up call produced a clean response).
 *   - The snapshot restore in chat-executor-planner-execution.ts
 *     (restores the pre-synthesis stop reason after a failed
 *     synthesis attempt).
 * Any other direct `ctx.stopReason = ...` assignment is a bug — it
 * silently overwrites the authoritative stop reason. See audit S1.3.
 *
 * Phase F extraction (PR-1). Previously `ChatExecutor.setStopReason`.
 */
export function setStopReason(
  ctx: ExecutionContext,
  reason: LLMPipelineStopReason,
  detail?: string,
): void {
  if (ctx.stopReason === "completed") {
    ctx.stopReason = reason;
    ctx.stopReasonDetail = detail;
  }
}

/**
 * Check whether the request's end-to-end deadline has fired. When
 * the deadline has passed, set the ctx's stop reason to "timeout"
 * with a stage-tagged detail and return `true` so callers can short-
 * circuit. Otherwise return `false` and leave ctx untouched.
 *
 * Phase F extraction (PR-1). Previously
 * `ChatExecutor.checkRequestTimeout`.
 */
export function checkRequestTimeout(
  ctx: ExecutionContext,
  stage: string,
): boolean {
  if (getRemainingRequestMs(ctx) > 0) return false;
  setStopReason(
    ctx,
    "timeout",
    buildTimeoutDetail(stage, ctx.effectiveRequestTimeoutMs),
  );
  return true;
}

/**
 * Emit an execution trace event via the ctx's optional trace hook.
 * Pure pass-through; safe to call when no trace handler is wired.
 *
 * Phase F extraction (PR-1). Previously
 * `ChatExecutor.emitExecutionTrace`.
 */
export function emitExecutionTrace(
  ctx: ExecutionContext,
  event: ChatExecutionTraceEvent,
): void {
  ctx.trace?.onExecutionTraceEvent?.(event);
}
