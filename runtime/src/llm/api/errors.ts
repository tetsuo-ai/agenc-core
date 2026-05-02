/**
 * Ports upstream `src/services/api/errors.ts` API-error classification
 * onto AgenC's typed LLM error primitives.
 *
 * Why this lives here / shape difference from upstream:
 *   - The upstream file renders assistant-message UI payloads directly.
 *     AgenC keeps this layer UI-neutral and maps to runtime LLM errors.
 *
 * Cross-cuts deliberately NOT carried:
 *   - Subscription, internal-user, analytics, and provider-specific auth copy.
 *   - PDF/image UI recovery text; only pure classifiers are exposed here.
 */

import {
  LLMAuthenticationError,
  LLMContextWindowExceededError,
  LLMProviderError,
  LLMRateLimitError,
  LLMServerError,
  LLMTimeoutError,
} from "../errors.js";

export const API_ERROR_MESSAGE_PREFIX = "API Error";
export const PROMPT_TOO_LONG_ERROR_MESSAGE = "Prompt is too long";
export const REPEATED_529_ERROR_MESSAGE = "Repeated 529 Overloaded errors";

export type AgenCApiErrorKind =
  | "aborted"
  | "api_timeout"
  | "auth_error"
  | "client_error"
  | "connection_error"
  | "context_overflow"
  | "image_too_large"
  | "network_error"
  | "pdf_password_protected"
  | "pdf_too_large"
  | "prompt_too_long"
  | "rate_limit"
  | "server_error"
  | "server_overload"
  | "unknown";

export interface AgenCApiErrorOptions {
  readonly status?: number;
  readonly headers?: Headers;
  readonly body?: unknown;
  readonly retryAfterMs?: number;
  readonly url?: string;
  readonly kind?: AgenCApiErrorKind;
  readonly cause?: unknown;
}

export class AgenCApiError extends Error {
  readonly status?: number;
  readonly headers?: Headers;
  readonly body?: unknown;
  readonly retryAfterMs?: number;
  readonly url?: string;
  readonly kind: AgenCApiErrorKind;
  override readonly cause?: unknown;

  constructor(message: string, options: AgenCApiErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AgenCApiError";
    this.status = options.status;
    this.headers = options.headers;
    this.body = options.body;
    this.retryAfterMs = options.retryAfterMs;
    this.url = options.url;
    this.kind = options.kind ?? classifyApiErrorLike({
      status: options.status,
      message,
    });
    this.cause = options.cause;
  }
}

export function startsWithApiErrorPrefix(text: string): boolean {
  return text.startsWith(API_ERROR_MESSAGE_PREFIX);
}

export function parsePromptTooLongTokenCounts(rawMessage: string): {
  readonly actualTokens: number | undefined;
  readonly limitTokens: number | undefined;
} {
  const match = rawMessage.match(
    /prompt is too long[^0-9]*(\d+)\s*tokens?\s*>\s*(\d+)/i,
  );
  return {
    actualTokens: match ? Number.parseInt(match[1]!, 10) : undefined,
    limitTokens: match ? Number.parseInt(match[2]!, 10) : undefined,
  };
}

export function getPromptTooLongTokenGap(
  rawMessage: string,
): number | undefined {
  const { actualTokens, limitTokens } =
    parsePromptTooLongTokenCounts(rawMessage);
  if (actualTokens === undefined || limitTokens === undefined) {
    return undefined;
  }
  const gap = actualTokens - limitTokens;
  return gap > 0 ? gap : undefined;
}

export function isMediaSizeError(raw: string): boolean {
  return (
    (raw.includes("image exceeds") && raw.includes("maximum")) ||
    (raw.includes("image dimensions exceed") && raw.includes("many-image")) ||
    /maximum of \d+ PDF pages/.test(raw)
  );
}

export function extractApiErrorMessage(
  body: unknown,
  fallback: string,
): string {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    if (typeof record.message === "string" && record.message.trim()) {
      return record.message.trim();
    }
    if (typeof record.error === "string" && record.error.trim()) {
      return record.error.trim();
    }
    if (record.error && typeof record.error === "object") {
      const nested = record.error as Record<string, unknown>;
      if (typeof nested.message === "string" && nested.message.trim()) {
        return nested.message.trim();
      }
      if (typeof nested.type === "string" && nested.type.trim()) {
        return nested.type.trim();
      }
    }
  }
  if (typeof body === "string" && body.trim()) return body.trim();
  return fallback;
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

function errorStatus(error: unknown): number | undefined {
  const unwrapped = unwrapCannotRetryError(error);
  if (unwrapped !== error) return errorStatus(unwrapped);
  const raw =
    error instanceof AgenCApiError
      ? error.status
      : error && typeof error === "object"
        ? (error as { status?: unknown; statusCode?: unknown }).status ??
          (error as { statusCode?: unknown }).statusCode
        : undefined;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string") {
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function classifyApiErrorLike(args: {
  readonly status?: number;
  readonly message: string;
}): AgenCApiErrorKind {
  const lower = args.message.toLowerCase();
  if (args.status === 429) return "rate_limit";
  if (args.status === 529 || lower.includes("overloaded_error")) {
    return "server_overload";
  }
  if (args.status === 401 || args.status === 403) return "auth_error";
  if (args.status === 408 || lower.includes("timeout")) return "api_timeout";
  if (
    args.status === 413 ||
    lower.includes("prompt is too long") ||
    lower.includes("context length") ||
    lower.includes("maximum context") ||
    lower.includes("input length") ||
    lower.includes("payload too large")
  ) {
    return lower.includes("prompt is too long")
      ? "prompt_too_long"
      : "context_overflow";
  }
  if (/maximum of \d+ pdf pages/i.test(args.message)) return "pdf_too_large";
  if (lower.includes("pdf specified is password protected")) {
    return "pdf_password_protected";
  }
  if (
    args.message.includes("image exceeds") ||
    args.message.includes("image dimensions exceed")
  ) {
    return "image_too_large";
  }
  if (lower.includes("econn") || lower.includes("socket")) {
    return "connection_error";
  }
  if (lower.includes("network") || lower.includes("fetch failed")) {
    return "network_error";
  }
  if (args.status !== undefined && args.status >= 500) return "server_error";
  if (args.status !== undefined && args.status >= 400) return "client_error";
  return "unknown";
}

export function classifyApiError(error: unknown): AgenCApiErrorKind {
  const unwrapped = unwrapCannotRetryError(error);
  if (unwrapped !== error) return classifyApiError(unwrapped);
  if (error instanceof Error && error.name === "AbortError") return "aborted";
  const message = errorMessage(error);
  if (message === "Request was aborted.") return "aborted";
  if (message.includes(REPEATED_529_ERROR_MESSAGE)) return "server_overload";
  return classifyApiErrorLike({ status: errorStatus(error), message });
}

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
