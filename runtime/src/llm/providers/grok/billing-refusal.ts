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
 * (HTTP 403)" with no reason. The auth-refresh wrapper also took it for an
 * expired bearer, so outside a single wire attempt an OAuth session would
 * refresh its token and resend before the same refusal came back. That part is
 * a code and test finding: the observed calls were single wire attempts on an
 * API key and never refreshed.
 *
 * Only that status, that code and that wording are recognized. Another
 * `personal-team-blocked:` reason, or a permission denial that merely mentions
 * credits, stays an authentication failure with its token refresh.
 *
 * @module
 */

import { LLMProviderError, LLMFundsError } from "../../errors.js";

const SPENDING_LIMIT_STATUS = 403;
const SPENDING_LIMIT_CODE = "personal-team-blocked:spending-limit";
/**
 * xAI's wording at the start of the text, as the SDK keeps it: the body's
 * `error` string, or the thrown message `403 "<that string>"`.
 */
const OUT_OF_CREDITS_WORDING_RE =
  /^(?:403 )?"?You have run out of credits or need a Grok subscription\b/;

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
  if (record === undefined) return undefined;
  if ((record.status ?? record.statusCode) !== SPENDING_LIMIT_STATUS) {
    return undefined;
  }
  const nested = asRecord(record.error);
  if (
    record.code === SPENDING_LIMIT_CODE ||
    nested?.code === SPENDING_LIMIT_CODE
  ) {
    return { status: SPENDING_LIMIT_STATUS, code: SPENDING_LIMIT_CODE };
  }
  const worded = [record.error, nested?.message, record.message].some(
    (text) => typeof text === "string" && OUT_OF_CREDITS_WORDING_RE.test(text),
  );
  return worded ? { status: SPENDING_LIMIT_STATUS } : undefined;
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
  const funds = new LLMFundsError(
    providerName,
    refusal.status,
    "xAI refused the request: the account has run out of credits, reached " +
      `its spending limit, or needs a Grok subscription${code}. This is a ` +
      "billing limit, not a sign-in problem, so signing in again will not " +
      "help. Add credits, raise the limit, or upgrade the account, then retry.",
  );
  const metadata = error as { readonly headers?: unknown; readonly retryAfterMs?: unknown };
  if (metadata.headers instanceof Headers ||
      (metadata.headers !== null && typeof metadata.headers === "object")) {
    Object.assign(funds, { headers: metadata.headers });
  }
  if (typeof metadata.retryAfterMs === "number") {
    Object.assign(funds, { retryAfterMs: metadata.retryAfterMs });
  }
  return funds;
}
