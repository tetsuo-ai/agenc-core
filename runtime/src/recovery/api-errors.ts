/**
 * API-error classification primitives used by the recovery ladder.
 *
 * Port of agenc `services/api/errors.ts` subset + the
 * `FallbackTriggeredError` from `services/api/withRetry.ts`.
 *
 * Every classifier here is a pure predicate — no I/O. The recovery
 * ladder uses them to decide which strategy branch applies to the
 * last assistant message.
 *
 * @module
 */

import type { AssistantMessage, TurnState } from "../session/turn-state.js";
import {
  LLMCaptivePortalError,
  LLMCertificateError,
  LLMAuthenticationError,
  LLMContextWindowExceededError,
  LLMInvalidResponseError,
  LLMMessageValidationError,
  LLMProviderError,
} from "../llm/errors.js";

// ─────────────────────────────────────────────────────────────────────
// String constants
// ─────────────────────────────────────────────────────────────────────

const PROMPT_TOO_LONG_ERROR_MESSAGE = "Prompt is too long";

// ─────────────────────────────────────────────────────────────────────
// FallbackTriggeredError — port of withRetry.ts:169
// ─────────────────────────────────────────────────────────────────────

/**
 * Thrown by the provider/retry layer when the network wire has given
 * up on the primary model and is about to retry on the fallback.
 * Phase-3 catches this and triggers the model-fallback strategy
 * (AgenC query.ts:928-981).
 */
export interface FallbackTriggeredErrorOptions {
  readonly fromProvider?: string;
  readonly toProvider?: string;
  readonly reason?: string;
  readonly message?: string;
}

export class FallbackTriggeredError extends Error {
  readonly isFallbackTrigger = true as const;
  readonly fromProvider?: string;
  readonly toProvider?: string;
  readonly reason?: string;

  constructor(
    public readonly fromModel: string,
    public readonly toModel: string,
    optionsOrMessage?: string | FallbackTriggeredErrorOptions,
  ) {
    const options =
      typeof optionsOrMessage === "string" ? undefined : optionsOrMessage;
    const message =
      typeof optionsOrMessage === "string"
        ? optionsOrMessage
        : options?.message;
    super(message ?? `fallback: ${fromModel} -> ${toModel}`);
    this.name = "FallbackTriggeredError";
    this.fromProvider = options?.fromProvider;
    this.toProvider = options?.toProvider;
    this.reason = options?.reason;
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
 * Port of agenc `isPromptTooLongMessage`. Matches an assistant
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
 * Port of agenc `isMediaSizeError`. Detects image / PDF upload
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
 * Detects a withheld `max_output_tokens` error. AgenC withholds
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
  return (
    state.stopHookActive === true &&
    state.transition?.reason === "stop_hook_blocking"
  );
}

/**
 * Did the streaming fallback fire in the previous iteration? This is
 * tracked by the stream-model phase via `state.transition` and the
 * `streamingFallbackOccured` flag the adapter reports.
 *
 * T8 disambiguation: this check fires on the dedicated
 * `streaming_fallback_retry` reason so downstream telemetry can
 * distinguish it from the cross-model `model_fallback` swap handled
 * by `onFallbackError`.
 */
export function isStreamingFallbackOccured(state: TurnState): boolean {
  if (state.transition?.reason === "streaming_fallback_retry") {
    return true;
  }
  const lastAssistant = state.assistantMessages.at(-1);
  const lastStreamError = (
    state as TurnState & { lastStreamError?: unknown }
  ).lastStreamError;
  return (
    lastAssistant?.apiError === "provider_error" &&
    lastAssistant.text !== undefined &&
    lastAssistant.text.length > 0 &&
    lastStreamError !== undefined &&
    !isNonRecoverableProviderSetupError(lastStreamError) &&
    !isPartialProviderResponseError(lastStreamError) &&
    !isFallbackTriggeredError(lastStreamError)
  );
}

const NON_RECOVERABLE_PROVIDER_SETUP_MARKERS = [
  "openai_category=model_not_found",
  "openai_category=endpoint_not_found",
  "openai_category=tool_call_incompatible",
  "model not found",
  "model_not_found",
  "unknown model",
  "unavailable model",
  "does not exist",
] as const;

function isNonRecoverableProviderSetupError(
  err: unknown,
  seen: Set<object> = new Set(),
  depth = 0,
): boolean {
  if (depth > 4) return false;
  if (isExplicitNonTransientProviderError(err)) return true;
  if (err instanceof LLMProviderError) {
    if (
      err.statusCode !== undefined &&
      err.statusCode >= 400 &&
      err.statusCode < 500
    ) {
      return true;
    }
    if (hasNonRecoverableProviderSetupMarker(err.message)) return true;
  } else if (err instanceof Error) {
    if (hasNonRecoverableProviderSetupMarker(err.message)) return true;
  }

  if (!err || typeof err !== "object") return false;
  if (seen.has(err)) return false;
  seen.add(err);

  const record = err as {
    readonly cause?: unknown;
    readonly errors?: unknown;
    readonly originalError?: unknown;
  };

  if (isNonRecoverableProviderSetupError(record.cause, seen, depth + 1)) {
    return true;
  }
  if (
    isNonRecoverableProviderSetupError(
      record.originalError,
      seen,
      depth + 1,
    )
  ) {
    return true;
  }
  if (Array.isArray(record.errors)) {
    return record.errors.some((nested) =>
      isNonRecoverableProviderSetupError(nested, seen, depth + 1)
    );
  }

  return false;
}

function hasNonRecoverableProviderSetupMarker(message: string): boolean {
  const normalized = message.toLowerCase();
  return NON_RECOVERABLE_PROVIDER_SETUP_MARKERS.some((marker) =>
    normalized.includes(marker)
  );
}

export function isPartialProviderResponseError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const response = (err as { readonly response?: unknown }).response;
  if (!response || typeof response !== "object") return false;
  const record = response as {
    readonly finishReason?: unknown;
    readonly partial?: unknown;
  };
  return record.finishReason === "error" && record.partial === true;
}

// ─────────────────────────────────────────────────────────────────────
// Retryable / transient classification for reconnection backoff.
// ─────────────────────────────────────────────────────────────────────

/**
 * Port of the transient-error detection used by AgenC
 * reconnection. Anything in this set goes through exponential
 * backoff (500ms → 8s). Non-transient errors surface as terminal.
 */
export function isTransientProviderError(err: unknown): boolean {
  if (isPartialProviderResponseError(err)) return false;
  return isTransientProviderErrorInner(err, new Set<object>(), 0);
}

const TRANSIENT_PROVIDER_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "ECONNABORTED",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

const TRANSIENT_PROVIDER_HTTP_STATUSES = new Set([500, 502, 503, 504]);

const TRANSIENT_PROVIDER_MESSAGE_PARTS = [
  "econnreset",
  "econnrefused",
  "etimedout",
  "socket hang up",
  "stream_idle",
  "fetch failed",
  "connection reset by peer",
  "connection reset",
  "socket connection was closed unexpectedly",
  "socket closed",
];

function isExplicitNonTransientProviderError(err: unknown): boolean {
  return (
    err instanceof LLMAuthenticationError ||
    err instanceof LLMContextWindowExceededError ||
    err instanceof LLMMessageValidationError ||
    err instanceof LLMCaptivePortalError ||
    err instanceof LLMCertificateError ||
    err instanceof LLMInvalidResponseError
  );
}

function isTransientProviderErrorInner(
  err: unknown,
  seen: Set<object>,
  depth: number,
): boolean {
  if (depth > 4) return false;
  if (isExplicitNonTransientProviderError(err)) return false;
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (TRANSIENT_PROVIDER_MESSAGE_PARTS.some((part) => msg.includes(part))) {
      return true;
    }
  }
  if (!err || typeof err !== "object") return false;
  if (seen.has(err)) return false;
  seen.add(err);

  const record = err as {
    readonly cause?: unknown;
    readonly code?: unknown;
    readonly status?: unknown;
    readonly statusCode?: unknown;
    readonly errors?: unknown;
  };
  if (isExplicitNonTransientProviderError(record.cause)) return false;
  if (typeof record.code === "string") {
    if (TRANSIENT_PROVIDER_ERROR_CODES.has(record.code.toUpperCase())) {
      return true;
    }
  }

  const status = record.status ?? record.statusCode;
  if (
    typeof status === "number" &&
    Number.isFinite(status) &&
    TRANSIENT_PROVIDER_HTTP_STATUSES.has(status)
  ) {
    return true;
  }

  if (isTransientProviderErrorInner(record.cause, seen, depth + 1)) {
    return true;
  }

  if (Array.isArray(record.errors)) {
    for (const nested of record.errors) {
      if (isTransientProviderErrorInner(nested, seen, depth + 1)) {
        return true;
      }
    }
  }

  return false;
}
