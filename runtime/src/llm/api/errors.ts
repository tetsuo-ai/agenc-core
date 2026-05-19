/**
 * Bridges the live LLM API error surface onto the canonical runtime
 * API-error classifiers in `runtime/src/errors/api.ts`.
 *
 * The live LLM layer keeps only the LLM-specific mapper here so callers that
 * import from `llm/api/errors.js` share the same `AgenCApiError` class as the
 * TUI/runtime error formatting path.
 */

import {
  AgenCApiError,
  classifyApiError,
} from "../../errors/api.js";
import {
  LLMAuthenticationError,
  LLMContextWindowExceededError,
  LLMProviderError,
  LLMRateLimitError,
  LLMServerError,
  LLMTimeoutError,
} from "../errors.js";

export {
  AgenCApiError,
  API_ERROR_MESSAGE_PREFIX,
  API_TIMEOUT_ERROR_MESSAGE,
  CREDIT_BALANCE_TOO_LOW_ERROR_MESSAGE,
  INVALID_API_KEY_ERROR_MESSAGE,
  INVALID_API_KEY_ERROR_MESSAGE_EXTERNAL,
  PROMPT_TOO_LONG_ERROR_MESSAGE,
  REPEATED_529_ERROR_MESSAGE,
  TOKEN_REVOKED_ERROR_MESSAGE,
  categorizeRetryableAPIError,
  classifyApiError,
  extractApiErrorMessage,
  extractConnectionErrorDetails,
  formatAPIError,
  getPromptTooLongTokenGap,
  getSSLErrorHint,
  isMediaSizeError,
  parsePromptTooLongTokenCounts,
  redactSensitiveAPIText,
  sanitizeAPIError,
  startsWithApiErrorPrefix,
} from "../../errors/api.js";
export type {
  AgenCApiErrorKind,
  AgenCApiErrorOptions,
  AgenCSystemAPIErrorMessage,
  ConnectionErrorDetails,
} from "../../errors/api.js";

export function mapAgenCApiErrorToLLMError(
  providerName: string,
  error: unknown,
  timeoutMs: number,
): Error {
  const unwrapped = unwrapCannotRetryError(error);
  if (unwrapped !== error) {
    return mapAgenCApiErrorToLLMError(providerName, unwrapped, timeoutMs);
  }

  if (!(error instanceof AgenCApiError)) {
    const kind = classifyApiError(error);
    if (kind === "aborted" || kind === "api_timeout") {
      return new LLMTimeoutError(providerName, timeoutMs);
    }
    return new LLMProviderError(providerName, errorMessage(error));
  }

  if (error.status === 401 || error.status === 403) {
    return new LLMAuthenticationError(providerName, error.status);
  }
  if (error.status === 429) {
    return new LLMRateLimitError(providerName, error.retryAfterMs);
  }
  if (
    error.status === 413 ||
    error.kind === "context_overflow" ||
    error.kind === "prompt_too_long"
  ) {
    return new LLMContextWindowExceededError(providerName, error.message);
  }
  if (
    error.kind === "aborted" ||
    error.kind === "api_timeout" ||
    (error.cause instanceof Error && error.cause.name === "AbortError")
  ) {
    return new LLMTimeoutError(providerName, timeoutMs);
  }
  if (error.status !== undefined && error.status >= 500) {
    return new LLMServerError(providerName, error.status, error.message);
  }
  return new LLMProviderError(providerName, error.message, error.status);
}

function errorMessage(error: unknown): string {
  const unwrapped = unwrapCannotRetryError(error);
  if (unwrapped !== error) return errorMessage(unwrapped);
  if (error instanceof Error) return error.message;
  if (
    error &&
    typeof error === "object" &&
    typeof (error as { message?: unknown }).message === "string"
  ) {
    return (error as { message: string }).message;
  }
  return String(error);
}

function unwrapCannotRetryError(error: unknown): unknown {
  if (
    error &&
    typeof error === "object" &&
    (error as { name?: unknown }).name === "CannotRetryError" &&
    "originalError" in error
  ) {
    return (error as { originalError: unknown }).originalError;
  }
  return error;
}
