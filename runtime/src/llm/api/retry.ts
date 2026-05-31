/**
 * Provider-neutral retry arithmetic and rate-limit parsing helpers ported from
 * upstream `src/services/api/withRetry.ts`.
 *
 * Scope: this module exposes only the pure backoff/delay math and header
 * parsing used by the provider adapters' fallback ladders
 * (`getRetryDelay`, `sleepMs`, `getRateLimitResetDelayMs`, `parseOpenAIDuration`,
 * `is529Error`, `parseMaxTokensContextOverflowError`). The actual
 * retry/backoff/Retry-After orchestration on the live request path lives in
 * `src/llm/client-session.ts` (`requestWithRetry` / `acquireStreamAttempt`),
 * which is the authoritative loop; this module is intentionally not a driver.
 */

const BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 32_000;
const MAX_RETRY_AFTER_MS = 300_000;
const PERSISTENT_RESET_CAP_MS = 6 * 60 * 60 * 1000;

export interface MaxTokensContextOverflow {
  readonly inputTokens: number;
  readonly maxTokens: number;
  readonly contextLimit: number;
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

function parseRetryAfterMs(
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
