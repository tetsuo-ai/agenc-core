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
import type {
  ExecutionContext,
  ToolCallRecord,
} from "./chat-executor-types.js";

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
