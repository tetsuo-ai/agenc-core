/**
 * Ports upstream `src/services/api/withRetry.ts` retry arithmetic and
 * transient-error classification onto a provider-neutral AgenC helper.
 *
 * Why this lives here / shape difference from upstream:
 *   - Upstream retries are coupled to one SDK, auth refresh, analytics, and
 *     foreground/background query sources. AgenC exposes the pure retry core
 *     so providers can opt into the same backoff semantics.
 *
 * Cross-cuts deliberately NOT carried:
 *   - Subscriber gates, fast-mode fallback, persistent unattended heartbeats,
 *     and provider-specific auth cache mutation.
 */

import { AgenCApiError } from "./errors.js";
import {
  evaluateProviderFallback,
  type ProviderFallbackLadderOptions,
} from "./fallback-ladder.js";

export const DEFAULT_MAX_RETRIES = 10;
export const BASE_DELAY_MS = 500;
export const DEFAULT_MAX_DELAY_MS = 32_000;
export const MAX_RETRY_AFTER_MS = 300_000;
export const PERSISTENT_RESET_CAP_MS = 6 * 60 * 60 * 1000;
export const FLOOR_OUTPUT_TOKENS = 3000;
export const MAX_TOKENS_CONTEXT_SAFETY_BUFFER = 1000;

export interface MaxTokensContextOverflow {
  readonly inputTokens: number;
  readonly maxTokens: number;
  readonly contextLimit: number;
}

export interface RetryContext {
  readonly attempt: number;
  readonly maxRetries: number;
  readonly lastError?: unknown;
  readonly maxTokensContextOverflow?: MaxTokensContextOverflow;
  readonly maxTokensOverride?: number;
}

export interface WithRetryOptions {
  readonly maxRetries?: number;
  readonly maxDelayMs?: number;
  readonly retryStatuses?: ReadonlySet<number> | readonly number[];
  readonly signal?: AbortSignal;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly random?: () => number;
  readonly maxTokensContext?: {
    readonly floorOutputTokens?: number;
    readonly safetyBufferTokens?: number;
    readonly minRequiredTokens?: number;
  };
  readonly fallback?: ProviderFallbackLadderOptions;
  readonly onRetry?: (event: {
    readonly attempt: number;
    readonly delayMs: number;
    readonly error: unknown;
    readonly maxTokensOverride?: number;
  }) => void;
  readonly emitWarning?: (warning: {
    readonly cause: string;
    readonly message: string;
  }) => void;
}

export class CannotRetryError extends Error {
  readonly originalError: unknown;
  readonly retryContext: RetryContext;

  constructor(originalError: unknown, retryContext: RetryContext) {
    const message =
      originalError instanceof Error ? originalError.message : String(originalError);
    super(message);
    this.name = "CannotRetryError";
    this.originalError = originalError;
    this.retryContext = retryContext;
    if (originalError instanceof Error && originalError.stack) {
      this.stack = originalError.stack;
    }
  }
}

export class RetryAfterTooLongError extends Error {
  readonly retryAfterMs: number;
  readonly maxRetryAfterMs: number;

  constructor(retryAfterMs: number, maxRetryAfterMs = MAX_RETRY_AFTER_MS) {
    super(
      `Retry-After ${retryAfterMs}ms exceeds maximum ${maxRetryAfterMs}ms`,
    );
    this.name = "RetryAfterTooLongError";
    this.retryAfterMs = retryAfterMs;
    this.maxRetryAfterMs = maxRetryAfterMs;
  }
}

export function parseMaxTokensContextOverflowError(
  error: unknown,
): MaxTokensContextOverflow | undefined {
  const candidate = error as { status?: unknown; message?: unknown };
  const status =
    typeof candidate?.status === "number"
      ? candidate.status
      : Number.parseInt(String(candidate?.status ?? ""), 10);
  const message =
    typeof candidate?.message === "string" ? candidate.message : "";

  if (status !== 400 || !message) return undefined;
  if (!message.includes("input length and `max_tokens` exceed context limit")) {
    return undefined;
  }

  const match = message.match(
    /input length and `max_tokens` exceed context limit: (\d+) \+ (\d+) > (\d+)/,
  );
  if (!match) return undefined;

  const inputTokens = Number.parseInt(match[1]!, 10);
  const maxTokens = Number.parseInt(match[2]!, 10);
  const contextLimit = Number.parseInt(match[3]!, 10);
  if (
    Number.isNaN(inputTokens) ||
    Number.isNaN(maxTokens) ||
    Number.isNaN(contextLimit)
  ) {
    return undefined;
  }
  return { inputTokens, maxTokens, contextLimit };
}

export function resolveMaxTokensContextOverflowOverride(
  overflow: MaxTokensContextOverflow,
  options: WithRetryOptions["maxTokensContext"] = {},
): number | undefined {
  const floorOutputTokens =
    options.floorOutputTokens ?? FLOOR_OUTPUT_TOKENS;
  const safetyBufferTokens =
    options.safetyBufferTokens ?? MAX_TOKENS_CONTEXT_SAFETY_BUFFER;
  const minRequiredTokens = options.minRequiredTokens ?? 1;
  const availableContext = Math.max(
    0,
    overflow.contextLimit - overflow.inputTokens - safetyBufferTokens,
  );
  if (availableContext < floorOutputTokens) return undefined;
  return Math.max(floorOutputTokens, availableContext, minRequiredTokens);
}

export function is529Error(error: unknown): boolean {
  const candidate = error as { status?: unknown; message?: unknown };
  return (
    candidate?.status === 529 ||
    (typeof candidate?.message === "string" &&
      candidate.message.includes("\"type\":\"overloaded_error\""))
  );
}

export function parseOpenAIDuration(value: string): number | null {
  if (!value) return null;
  const match = /^(?:(\d+)h)?(?:(\d+)m(?!s))?(?:(\d+)s)?(?:(\d+)ms)?$/.exec(
    value,
  );
  if (!match || match[0] === "") return null;
  const hours = Number.parseInt(match[1] ?? "0", 10);
  const minutes = Number.parseInt(match[2] ?? "0", 10);
  const seconds = Number.parseInt(match[3] ?? "0", 10);
  const milliseconds = Number.parseInt(match[4] ?? "0", 10);
  const total =
    hours * 3_600_000 + minutes * 60_000 + seconds * 1_000 + milliseconds;
  return total > 0 ? total : null;
}

export function getRateLimitResetDelayMs(
  headers: Headers | Readonly<Record<string, string | undefined>>,
  provider: "first_party" | "openai_compatible" | "generic" = "generic",
  nowMs = Date.now(),
): number | null {
  const get = (name: string): string | null => readHeader(headers, name);
  if (provider === "first_party") {
    const resetHeader = get("anthropic-ratelimit-unified-reset");
    if (!resetHeader) return null;
    const resetUnixSec = Number(resetHeader);
    if (!Number.isFinite(resetUnixSec)) return null;
    const delayMs = resetUnixSec * 1000 - nowMs;
    return delayMs > 0 ? Math.min(delayMs, PERSISTENT_RESET_CAP_MS) : null;
  }

  if (provider === "openai_compatible") {
    const reqHeader = get("x-ratelimit-reset-requests");
    const tokHeader = get("x-ratelimit-reset-tokens");
    const reqMs = reqHeader ? parseOpenAIDuration(reqHeader) : null;
    const tokMs = tokHeader ? parseOpenAIDuration(tokHeader) : null;
    if (reqMs === null && tokMs === null) return null;
    return Math.min(Math.max(reqMs ?? 0, tokMs ?? 0), PERSISTENT_RESET_CAP_MS);
  }

  return null;
}

export function parseRetryAfterMs(
  retryAfterHeader: string | null | undefined,
  nowMs = Date.now(),
): { readonly delayMs?: number; readonly exceedsMaxWait: boolean } {
  if (!retryAfterHeader) return { exceedsMaxWait: false };
  const trimmed = retryAfterHeader.trim();
  if (!trimmed) return { exceedsMaxWait: false };

  const seconds = Number.parseInt(trimmed, 10);
  if (Number.isFinite(seconds) && seconds >= 0) {
    const delayMs = seconds * 1000;
    return delayMs > MAX_RETRY_AFTER_MS
      ? { exceedsMaxWait: true }
      : { delayMs, exceedsMaxWait: false };
  }

  const absoluteMs = Date.parse(trimmed);
  if (!Number.isFinite(absoluteMs)) return { exceedsMaxWait: false };
  const delayMs = Math.max(0, absoluteMs - nowMs);
  return delayMs > MAX_RETRY_AFTER_MS
    ? { exceedsMaxWait: true }
    : { delayMs, exceedsMaxWait: false };
}

export function getRetryDelay(
  attempt: number,
  retryAfterHeader?: string | null,
  maxDelayMs = DEFAULT_MAX_DELAY_MS,
  random = Math.random,
): number {
  const retryAfter = parseRetryAfterMs(retryAfterHeader);
  if (retryAfter.exceedsMaxWait) {
    throw new RetryAfterTooLongError(MAX_RETRY_AFTER_MS + 1);
  }
  if (retryAfter.delayMs !== undefined) return retryAfter.delayMs;

  const baseDelay = Math.min(
    BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1),
    maxDelayMs,
  );
  const jitter = random() * 0.25 * baseDelay;
  return baseDelay + jitter;
}

export function shouldRetryApiError(
  error: unknown,
  retryStatuses: ReadonlySet<number> | readonly number[] = [
    408,
    409,
    429,
    500,
    502,
    503,
    504,
    529,
  ],
): boolean {
  if (isAbortError(error)) return false;
  if (is529Error(error)) return true;
  if (parseMaxTokensContextOverflowError(error)) return true;
  if (isRetryableNetworkError(error)) return true;

  const status = readStatus(error);
  if (status === undefined) return false;
  const statuses =
    retryStatuses instanceof Set ? retryStatuses : new Set(retryStatuses);
  return statuses.has(status);
}

export async function withRetry<T>(
  operation: (context: RetryContext) => Promise<T>,
  options: WithRetryOptions = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const sleep = options.sleep ?? sleepMs;
  let lastError: unknown;
  let maxTokensContextOverflow: MaxTokensContextOverflow | undefined;
  let maxTokensOverride: number | undefined;
  let consecutiveFallbackFailures = 0;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
    if (options.signal?.aborted) {
      throw abortReasonToError(options.signal.reason);
    }

    const context: RetryContext = {
      attempt,
      maxRetries,
      lastError,
      maxTokensContextOverflow,
      maxTokensOverride,
    };
    try {
      return await operation(context);
    } catch (error) {
      lastError = error;
      if (attempt > maxRetries) {
        throw new CannotRetryError(error, context);
      }

      const overflow = parseMaxTokensContextOverflowError(error);
      if (overflow) {
        const override = resolveMaxTokensContextOverflowOverride(
          overflow,
          options.maxTokensContext,
        );
        if (override === undefined) {
          throw new CannotRetryError(error, context);
        }
        maxTokensContextOverflow = overflow;
        maxTokensOverride = override;
        options.onRetry?.({
          attempt,
          delayMs: 0,
          error,
          maxTokensOverride,
        });
        continue;
      }

      let shouldRetryFallback = false;
      if (options.fallback) {
        const fallbackDecision = evaluateProviderFallback({
          ...options.fallback,
          error,
          consecutiveFailures: consecutiveFallbackFailures,
        });
        if (fallbackDecision.kind === "trigger") {
          throw fallbackDecision.error;
        }
        consecutiveFallbackFailures =
          fallbackDecision.kind === "wait"
            ? fallbackDecision.consecutiveFailures
            : 0;
        shouldRetryFallback = fallbackDecision.kind === "wait";
      }

      if (
        !shouldRetryFallback &&
        !shouldRetryApiError(error, options.retryStatuses)
      ) {
        throw new CannotRetryError(error, context);
      }

      const retryAfterHeader = getRetryAfterHeader(error);
      const parsedRetryAfter = parseRetryAfterMs(retryAfterHeader);
      if (parsedRetryAfter.exceedsMaxWait) {
        options.emitWarning?.({
          cause: "retry_after_exceeds_max_wait",
          message: `provider requested a Retry-After longer than ${MAX_RETRY_AFTER_MS}ms; aborting retry instead of sleeping unbounded`,
        });
        throw new CannotRetryError(error, context);
      }

      const delayMs =
        parsedRetryAfter.delayMs ??
        getRetryDelay(
          attempt,
          undefined,
          options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS,
          options.random ?? Math.random,
        );
      options.onRetry?.({ attempt, delayMs, error, maxTokensOverride });
      await sleep(delayMs, options.signal);
    }
  }

  throw new CannotRetryError(lastError, {
    attempt: maxRetries + 1,
    maxRetries,
    lastError,
  });
}

function readStatus(error: unknown): number | undefined {
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

function readHeader(
  headers: Headers | Readonly<Record<string, string | undefined>>,
  name: string,
): string | null {
  if (typeof (headers as Headers).get === "function") {
    return (headers as Headers).get(name);
  }
  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowerName) return value ?? null;
  }
  return null;
}

function getRetryAfterHeader(error: unknown): string | null {
  const headers =
    error instanceof AgenCApiError
      ? error.headers
      : error && typeof error === "object"
        ? (error as { headers?: unknown }).headers
        : undefined;
  if (!headers) return null;
  if (typeof (headers as Headers).get === "function") {
    return (headers as Headers).get("retry-after");
  }
  if (typeof headers === "object") {
    return readHeader(
      headers as Readonly<Record<string, string | undefined>>,
      "retry-after",
    );
  }
  return null;
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" ||
      (error as { code?: string }).code === "ABORT_ERR")
  );
}

function isRetryableNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (isAbortError(error)) return false;
  return /socket connection was closed unexpectedly|ECONNRESET|EPIPE|socket hang up|Connection reset by peer|fetch failed|network/i.test(
    error.message,
  );
}

function abortReasonToError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  if (typeof reason === "string" && reason.length > 0) return new Error(reason);
  const err = new Error("request aborted");
  err.name = "AbortError";
  return err;
}

export function sleepMs(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      if (typeof (timer as { unref?: () => void }).unref === "function") {
        (timer as { unref: () => void }).unref();
      }
    });
  }
  if (signal.aborted) return Promise.reject(abortReasonToError(signal.reason));

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(abortReasonToError(signal.reason));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    if (typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as { unref: () => void }).unref();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
