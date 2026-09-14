/**
 * Recognizes xAI's refusal of a request from an account that has run out of
 * credits or reached its spending limit.
 *
 * Observed 2026-09-14 on a grok.com subscription sign-in: every request, the
 * model list included, came back HTTP 403 with a flat body
 * `{"code":"personal-team-blocked:spending-limit","error":"You have run out of credits or need a Grok subscription. ..."}`.
 * The OpenAI SDK reads `code` from inside `error`, so for this body the thrown
 * error keeps the status and the text but loses the code. Mapped as an
 * authentication failure, the refusal read "grok authentication failed
 * (HTTP 403)" with no reason, and an OAuth session refreshed its token before
 * the same refusal came back.
 *
 * @module
 */

import { LLMProviderError } from "../../errors.js";

const BILLING_REFUSAL_STATUSES: ReadonlySet<number> = new Set([402, 403]);
const BILLING_REFUSAL_CODE_RE = /^personal-team-blocked:/i;
const BILLING_REFUSAL_TEXT_RE = /\brun out of credits\b|\bspending[\s-]limit\b/i;

export interface XaiBillingRefusal {
  readonly status: number;
  /** Present only when the thrown error still carries xAI's code. */
  readonly code?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function readXaiBillingRefusal(
  error: unknown,
): XaiBillingRefusal | undefined {
  const record = asRecord(error);
  const status = record?.status ?? record?.statusCode;
  if (
    record === undefined ||
    typeof status !== "number" ||
    !BILLING_REFUSAL_STATUSES.has(status)
  ) {
    return undefined;
  }
  const nested = asRecord(record.error);
  const code = [record.code, nested?.code]
    .find(
      (value): value is string =>
        typeof value === "string" && BILLING_REFUSAL_CODE_RE.test(value.trim()),
    )
    ?.trim();
  const texts = [record.error, nested?.message, record.message].filter(
    (value): value is string => typeof value === "string",
  );
  if (
    code === undefined &&
    !texts.some((text) => BILLING_REFUSAL_TEXT_RE.test(text))
  ) {
    return undefined;
  }
  return code === undefined ? { status } : { status, code };
}

/**
 * The provider error for a billing refusal, or undefined for any other
 * failure. xAI's own text is not echoed: a later wording could carry a word
 * the transient-failure classifiers match, and the raw body stays in the
 * provider trace.
 */
export function xaiBillingRefusalError(
  providerName: string,
  error: unknown,
): LLMProviderError | undefined {
  if (error instanceof LLMProviderError) return undefined;
  const refusal = readXaiBillingRefusal(error);
  if (refusal === undefined) return undefined;
  const code = refusal.code === undefined ? "" : ` (${refusal.code})`;
  return new LLMProviderError(
    providerName,
    "xAI refused the request: the account has run out of credits, reached " +
      `its spending limit, or needs a Grok subscription${code}. This is a ` +
      "billing limit, not a sign-in problem, so signing in again will not " +
      "help. Add credits, raise the limit, or upgrade the account, then retry.",
    refusal.status,
  );
}
