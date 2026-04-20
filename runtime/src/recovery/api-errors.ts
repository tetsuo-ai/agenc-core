/**
 * API-error classification primitives used by the recovery ladder.
 *
 * Port of openclaude `services/api/errors.ts` subset + the
 * `FallbackTriggeredError` from `services/api/withRetry.ts`.
 *
 * Every classifier here is a pure predicate — no I/O. The recovery
 * ladder uses them to decide which strategy branch applies to the
 * last assistant message.
 *
 * @module
 */

import type { AssistantMessage, TurnState } from "../session/turn-state.js";

// ─────────────────────────────────────────────────────────────────────
// String constants
// ─────────────────────────────────────────────────────────────────────

export const PROMPT_TOO_LONG_ERROR_MESSAGE = "Prompt is too long";
export const MAX_OUTPUT_TOKENS_ERROR_MESSAGE = "max_output_tokens";
export const CONTEXT_WINDOW_ERROR_MESSAGE = "context_window_exceeded";

// ─────────────────────────────────────────────────────────────────────
// FallbackTriggeredError — port of withRetry.ts:169
// ─────────────────────────────────────────────────────────────────────

/**
 * Thrown by the provider/retry layer when the network wire has given
 * up on the primary model and is about to retry on the fallback.
 * Phase-3 catches this and triggers the model-fallback strategy
 * (openclaude query.ts:928-981).
 */
export class FallbackTriggeredError extends Error {
  readonly isFallbackTrigger = true as const;
  constructor(
    public readonly fromModel: string,
    public readonly toModel: string,
    message?: string,
  ) {
    super(message ?? `fallback: ${fromModel} → ${toModel}`);
    this.name = "FallbackTriggeredError";
  }
}

export function isFallbackTriggeredError(
  err: unknown,
): err is FallbackTriggeredError {
  return (
    err instanceof FallbackTriggeredError ||
    (err instanceof Error && (err as { isFallbackTrigger?: boolean }).isFallbackTrigger === true)
  );
}

// ─────────────────────────────────────────────────────────────────────
// Prompt-too-long (I-10 first-priority trigger)
// ─────────────────────────────────────────────────────────────────────

function assistantText(msg: AssistantMessage): string {
  return msg.text ?? "";
}

/**
 * Port of openclaude `isPromptTooLongMessage`. Matches an assistant
 * message whose text begins with the sentinel PTL error phrase.
 */
export function isPromptTooLongMessage(msg: AssistantMessage): boolean {
  const text = assistantText(msg);
  if (text.length === 0) return false;
  return text.startsWith(PROMPT_TOO_LONG_ERROR_MESSAGE);
}

/**
 * Parse actual / limit token counts from a PTL error string. Used by
 * reactive compact to jump multiple groups in one retry.
 */
export function parsePromptTooLongTokenCounts(raw: string): {
  readonly actualTokens?: number;
  readonly limitTokens?: number;
} {
  const match = raw.match(
    /prompt is too long[^0-9]*(\d+)\s*tokens?\s*>\s*(\d+)/i,
  );
  if (!match) return {};
  return {
    actualTokens: Number.parseInt(match[1]!, 10),
    limitTokens: Number.parseInt(match[2]!, 10),
  };
}

/** Returns the gap by which PTL exceeded the limit, or undefined. */
export function getPromptTooLongTokenGap(
  msg: AssistantMessage,
): number | undefined {
  if (!isPromptTooLongMessage(msg)) return undefined;
  const errorDetails = (msg as AssistantMessage & { errorDetails?: string })
    .errorDetails;
  if (!errorDetails) return undefined;
  const { actualTokens, limitTokens } = parsePromptTooLongTokenCounts(
    errorDetails,
  );
  if (actualTokens === undefined || limitTokens === undefined) return undefined;
  const gap = actualTokens - limitTokens;
  return gap > 0 ? gap : undefined;
}

// ─────────────────────────────────────────────────────────────────────
// Media-size error (I-10 second-priority trigger)
// ─────────────────────────────────────────────────────────────────────

/**
 * Port of openclaude `isMediaSizeError`. Detects image / PDF upload
 * failures that `stripImagesFromMessages` can recover from.
 */
export function isMediaSizeError(raw: string): boolean {
  return (
    (raw.includes("image exceeds") && raw.includes("maximum")) ||
    (raw.includes("image dimensions exceed") && raw.includes("many-image")) ||
    /maximum of \d+ PDF pages/.test(raw)
  );
}

/**
 * Is the last assistant message an error message caused by oversized
 * media uploads (image/PDF too large)?
 */
export function isMediaTooLargeMessage(msg: AssistantMessage): boolean {
  const text = assistantText(msg);
  if (text.length > 0 && isMediaSizeError(text)) return true;
  const errorDetails = (msg as AssistantMessage & { errorDetails?: string })
    .errorDetails;
  return errorDetails ? isMediaSizeError(errorDetails) : false;
}

// ─────────────────────────────────────────────────────────────────────
// Max-output-tokens error (I-10 third-priority trigger)
// ─────────────────────────────────────────────────────────────────────

/**
 * Detects a withheld `max_output_tokens` error. Openclaude withholds
 * these mid-stream so only the recovery loop sees them; the final
 * surface error is a plain assistant message with `apiError = 'max_output_tokens'`.
 */
export function isWithheldMaxOutputTokens(msg: AssistantMessage): boolean {
  return msg.apiError === "max_output_tokens";
}

// ─────────────────────────────────────────────────────────────────────
// Withheld "413" / prompt-too-long helper
// ─────────────────────────────────────────────────────────────────────

/**
 * A message is "withheld 413" when it's PTL AND either the content
 * isn't yet visible to the caller (`apiError` set) or it's the
 * sentinel error-message variant. Used by withhold-cascading (I-10
 * two-gate check).
 */
export function isWithheld413Message(msg: AssistantMessage): boolean {
  return (
    isPromptTooLongMessage(msg) ||
    msg.apiError === "context_window_exceeded" ||
    msg.apiError === "prompt_too_long"
  );
}

// ─────────────────────────────────────────────────────────────────────
// Stop-hook-blocking + streaming-fallback
// ─────────────────────────────────────────────────────────────────────

/** Whether the last iteration's stop-hook was blocking. */
export function isStopHookBlocking(state: TurnState): boolean {
  return state.stopHookActive === true;
}

/**
 * Did the streaming fallback fire in the previous iteration? This is
 * tracked by the stream-model phase via `state.transition` and the
 * `streamingFallbackOccured` flag the adapter reports.
 */
export function isStreamingFallbackOccured(state: TurnState): boolean {
  return state.transition?.reason === "model_fallback";
}

// ─────────────────────────────────────────────────────────────────────
// Retryable / transient classification for reconnection backoff.
// ─────────────────────────────────────────────────────────────────────

/**
 * Port of the transient-error detection used by openclaude
 * reconnection. Anything in this set goes through exponential
 * backoff (500ms → 8s). Non-transient errors surface as terminal.
 */
export function isTransientProviderError(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (msg.includes("econnreset")) return true;
    if (msg.includes("econnrefused")) return true;
    if (msg.includes("etimedout")) return true;
    if (msg.includes("socket hang up")) return true;
    if (msg.includes("stream_idle")) return true;
    const status = (err as { status?: number }).status;
    if (status === 500 || status === 502 || status === 503 || status === 504) {
      return true;
    }
  }
  return false;
}
