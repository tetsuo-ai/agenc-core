/**
 * Auth-refresh retry wrapper for the Grok compatible
 * Responses API adapter.
 *
 * Hand-port of agenc runtime `core/src/client.rs::stream_responses` retry loop
 * (lines 1154-1211). On an HTTP 401 from the provider, the adapter
 * must ask its `AuthManager` for a refreshed token, rebuild the
 * request with the new bearer, and retry — exactly once per
 * token-refresh attempt, up to a bounded number of attempts.
 *
 * Invariants covered here:
 *   I-14 (`previous_response_id` server-side expiration retry):
 *        orthogonal to auth refresh; handled by `incremental.ts`.
 *        This module handles ONLY 401 auth recovery.
 *
 * The retry loop has three exit paths (matching agenc runtime 1191-1208):
 *   - Ok(stream)                      → return to caller
 *   - Err(401 with recovery available) → refresh + continue
 *   - Err(other)                       → map + throw
 *
 * The refresh side is a callback surface: the caller supplies a
 * `refreshBearer()` function and receives a retry wrapper that detects
 * 401, invokes the refresh, and retries. Bearer-token Grok calls pass no
 * refresh callback, so `retryWithAuthRefresh` no-ops.
 *
 * @module
 */

/**
 * Default max refresh attempts. Matches agenc runtime's implicit cap: agenc runtime
 * loops only while the AuthManager returns a `RecoveryDecision`, and
 * the manager's own state machine limits to ~2 refresh attempts
 * before surfacing the failure (see agenc runtime `AuthManager::unauthorized_recovery`).
 */
const DEFAULT_MAX_AUTH_REFRESHES = 2;

/**
 * Error shape the retry wrapper recognizes as a 401. Any error the
 * caller can classify as "auth failed, refresh and retry" should
 * satisfy `isUnauthorized(error) === true`.
 */
export interface UnauthorizedError extends Error {
  readonly status: 401;
}

export function isUnauthorizedError(error: unknown): error is UnauthorizedError {
  if (!(error instanceof Error)) return false;
  const status = (error as { status?: unknown }).status;
  return status === 401;
}

/**
 * Result of a refresh attempt.
 *
 *   - "refreshed"  → use the returned bearer + retry
 *   - "exhausted"  → no more refreshes possible; caller should bail
 *   - "skipped"    → refresh was declined (e.g. auth mode is
 *                    `local_no_auth` — no bearer to refresh); caller
 *                    should propagate the original 401.
 */
export type AuthRefreshOutcome =
  | { readonly kind: "refreshed"; readonly bearer: string }
  | { readonly kind: "exhausted"; readonly reason: string }
  | { readonly kind: "skipped"; readonly reason: string };

export interface AuthRefreshCallbacks {
  /**
   * Produce a fresh bearer token. Called once per 401 that the wrapper
   * detects. Throws to abort the retry loop (treated as a hard error).
   */
  refreshBearer(context: {
    readonly attempt: number;
    readonly previousError: UnauthorizedError;
  }): Promise<AuthRefreshOutcome>;
}

export interface RetryWithAuthRefreshOptions {
  readonly maxAttempts?: number;
  /** Optional hook invoked before each retry. */
  readonly onRefresh?: (info: {
    readonly attempt: number;
    readonly outcome: AuthRefreshOutcome;
  }) => void;
}

/**
 * Wrap a bearer-consuming operation with auth-refresh retry. The
 * `op(bearer)` callback is called with the current bearer; on 401 it
 * is called again with the refreshed bearer, up to `maxAttempts` times.
 *
 * Usage:
 * ```
 * const stream = await retryWithAuthRefresh(
 *   initialBearer,
 *   bearer => client.streamRequest(bearer, request, options),
 *   authCallbacks,
 * );
 * ```
 *
 * Mirrors agenc runtime's `loop { client_setup = current_client_setup(); ...
 * if 401 { handle_unauthorized; continue; } else { ... } }`.
 */
export async function retryWithAuthRefresh<T>(
  initialBearer: string,
  op: (bearer: string) => Promise<T>,
  callbacks: AuthRefreshCallbacks,
  opts: RetryWithAuthRefreshOptions = {},
): Promise<T> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? DEFAULT_MAX_AUTH_REFRESHES);
  let bearer = initialBearer;
  // One extra iteration beyond maxAttempts because the initial call
  // doesn't count as a refresh.
  let refreshesPerformed = 0;

  for (;;) {
    try {
      return await op(bearer);
    } catch (error) {
      if (!isUnauthorizedError(error)) {
        throw error;
      }
      if (refreshesPerformed >= maxAttempts) {
        throw error;
      }
      refreshesPerformed += 1;
      const outcome = await callbacks.refreshBearer({
        attempt: refreshesPerformed,
        previousError: error,
      });
      opts.onRefresh?.({ attempt: refreshesPerformed, outcome });
      if (outcome.kind === "refreshed") {
        bearer = outcome.bearer;
        continue;
      }
      // skipped / exhausted → bubble the original 401 up.
      throw error;
    }
  }
}
