import { isProviderFundsFailure } from "../llm/funds.js";
import { getRateLimitResetDelayMs } from "../llm/api/retry.js";
import { LLMRateLimitError, LLMTimeoutError, LLMAuthenticationError,
  LLMMissingCredentialsError,
  LLMContextWindowExceededError, LLMManagedUsagePendingError,
  LLMMessageValidationError, LLMManagedAdmissionError, LLMFundsError,
  LLMModelUnavailableError } from "../llm/errors.js";

export type ChildTerminalReason =
  | "completed" | "insufficient_funds" | "rate_limited" | "provider_unavailable"
  | "timeout" | "auth_required" | "model_unavailable" | "context_insufficient"
  | "tool_protocol_unreliable" | "model_refused" | "parent_cancelled"
  | "policy_revoked" | "resume_blocked" | "cost_cap_reached"
  | "effect_outcome_unknown" | "consent_denied" | "consent_unavailable";

export interface ChildTerminalOutcome {
  readonly [key: string]: string | number | boolean | undefined;
  readonly provider: string;
  readonly model: string;
  readonly reason: ChildTerminalReason;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly dispatch: "not_sent" | "sent" | "unknown";
  /** Text the child actually produced before its terminal boundary. */
  readonly completedWork: string;
  readonly unfinishedWork: string;
  /** Reconciled cost only; absent when admission has no known price. */
  readonly costUsd?: number;
}

function statusOf(error: unknown): number | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const item = error as { status?: unknown; statusCode?: unknown };
  const raw = item.status ?? item.statusCode;
  return typeof raw === "number" ? raw : undefined;
}

/** Whether the failed sampling attempt crossed the provider wire boundary. */
export function childDispatchCertainty(error: unknown): ChildTerminalOutcome["dispatch"] {
  for (let depth = 0; depth < 5; depth += 1) {
    if (error instanceof LLMMissingCredentialsError) return "not_sent";
    if (error instanceof LLMManagedAdmissionError || error instanceof LLMMessageValidationError)
      return "not_sent";
    if (error instanceof LLMFundsError || statusOf(error) !== undefined) return "sent";
    if (error === null || typeof error !== "object") break;
    const next = (error as { cause?: unknown; originalError?: unknown }).cause ??
      (error as { originalError?: unknown }).originalError;
    if (next === undefined || next === error) break;
    error = next;
  }
  return "unknown";
}

function retryAfterOf(error: unknown): number | undefined {
  for (let depth = 0; depth < 5; depth += 1) {
    if (error instanceof LLMRateLimitError) return error.retryAfterMs;
    if (error === null || typeof error !== "object") return undefined;
    const item = error as { retryAfterMs?: unknown; headers?: Headers | Record<string, string>; cause?: unknown; originalError?: unknown };
    if (typeof item.retryAfterMs === "number") return item.retryAfterMs;
    const raw = item.headers instanceof Headers ? item.headers.get("retry-after")
      : item.headers?.["retry-after"];
    if (raw !== undefined && raw !== null) {
      const seconds = Number(raw);
      if (Number.isFinite(seconds)) return seconds * 1000;
      const absolute = Date.parse(raw);
      if (Number.isFinite(absolute)) return Math.max(0, absolute - Date.now());
    }
    if (item.headers !== undefined) {
      const reset = getRateLimitResetDelayMs(item.headers, "openai_compatible");
      if (reset !== null) return reset;
      const resetAt = item.headers instanceof Headers
        ? item.headers.get("x-ratelimit-reset")
        : item.headers["x-ratelimit-reset"];
      const unixSeconds = Number(resetAt);
      if (resetAt !== undefined && resetAt !== null && Number.isFinite(unixSeconds)) {
        return Math.max(0, unixSeconds * 1000 - Date.now());
      }
    }
    error = item.cause ?? item.originalError;
  }
  return undefined;
}

export function classifyChildFailure(provider: string, error: unknown): {
  readonly reason: ChildTerminalReason; readonly retryable: boolean; readonly retryAfterMs?: number;
} {
  if (isProviderFundsFailure(provider, error)) {
    const retryAfterMs = retryAfterOf(error);
    return { reason: "insufficient_funds", retryable: false,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
  }
  // StreamModelError and the daemon's turn wrapper retain the typed provider
  // failure on `cause`. Use it before parsing the wrapper's summary prose.
  for (let depth = 0; depth < 4; depth += 1) {
    if (error === null || typeof error !== "object") break;
    const cause = (error as { cause?: unknown }).cause;
    if (cause === undefined || cause === error) break;
    error = cause;
  }
  const message = (error instanceof Error ? error.message : String(error ?? "")).toLowerCase();
  const status = statusOf(error);
  if (error instanceof LLMModelUnavailableError)
    return { reason: "model_unavailable", retryable: false };
  if (error instanceof LLMRateLimitError || status === 429) {
    const retryAfterMs = retryAfterOf(error);
    return { reason: "rate_limited", retryable: true,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
  }
  if (error instanceof LLMTimeoutError || /(?:^|\b)(?:timeout|timed out|deadline_reached|role_timeout)(?:\b|$)/.test(message))
    return { reason: "timeout", retryable: true };
  if (/maxturns|max.turns|no.progress/.test(message)) return { reason: "timeout", retryable: false };
  if (error instanceof LLMAuthenticationError || status === 401 || status === 403)
    return { reason: "auth_required", retryable: false };
  if (error instanceof LLMContextWindowExceededError || status === 413 || /context|compact_failed/.test(message))
    return { reason: "context_insufficient", retryable: false };
  if (error instanceof LLMManagedUsagePendingError || /effect.*unknown|pending reconciliation/.test(message))
    return { reason: "effect_outcome_unknown", retryable: false };
  if (error instanceof LLMMessageValidationError || /tool.?protocol|invalid tool|tool.turn|malformed.*tool/.test(message))
    return { reason: "tool_protocol_unreliable", retryable: false };
  if (/cost cap|max_budget_usd|budget.exceeded/.test(message)) return { reason: "cost_cap_reached", retryable: false };
  if (/policy.revoked|provider.*no longer allowed|cross.provider.*disabled/.test(message)) return { reason: "policy_revoked", retryable: false };
  if (/resume.blocked|restart.*blocked|durability failed|worktree evidence/.test(message)) return { reason: "resume_blocked", retryable: false };
  if (/model.*(?:unavailable|not found|unsupported)|unknown model/.test(message) || status === 404)
    return { reason: "model_unavailable", retryable: false };
  if (/refus|safety|content.filter/.test(message)) return { reason: "model_refused", retryable: false };
  if (/empty.response|no assistant output/.test(message)) return { reason: "model_refused", retryable: false };
  if (/cancel|interrupt|aborted|worker_teardown/.test(message)) return { reason: "parent_cancelled", retryable: false };
  if (status === 408 || status === 504) return { reason: "timeout", retryable: true };
  return { reason: "provider_unavailable", retryable: status === undefined || status >= 500 };
}

export function childTerminalOutcome(args: {
  readonly provider: string; readonly model: string; readonly error?: unknown;
  readonly reason?: ChildTerminalReason; readonly dispatch: ChildTerminalOutcome["dispatch"];
  readonly retryable?: boolean;
  readonly completedWork?: string; readonly unfinishedWork?: string; readonly costUsd?: number;
}): ChildTerminalOutcome {
  const failure = args.reason === undefined ? classifyChildFailure(args.provider, args.error) :
    { reason: args.reason, retryable: args.reason === "rate_limited" || args.reason === "timeout" || args.reason === "provider_unavailable" };
  return { provider: args.provider, model: args.model, ...failure,
    retryable: args.retryable ?? failure.retryable, dispatch: args.dispatch,
    completedWork: args.completedWork ?? "", unfinishedWork: args.unfinishedWork ?? "",
    ...(args.costUsd !== undefined ? { costUsd: args.costUsd } : {}) };
}
