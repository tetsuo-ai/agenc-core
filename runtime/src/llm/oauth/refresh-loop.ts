/**
 * Shared OAuth refresh retry loop for provider adapters.
 *
 * @module
 */

export const MAX_CONSECUTIVE_AUTH_FAILURES = 10;

export interface OAuthRefreshState {
  accessToken: string;
  refreshToken?: string;
  consecutiveAuthFailures: number;
}

export type OAuthRefreshOutcome =
  | {
    readonly kind: "refreshed";
    readonly accessToken: string;
    readonly refreshToken?: string;
  }
  | {
    readonly kind: "exhausted";
    readonly reason: string;
  };

export interface OAuthRefreshCallbacks {
  refreshAccessToken(context: {
    readonly attempt: number;
    readonly refreshToken?: string;
    readonly previousError: Error & { readonly status?: number };
  }): Promise<OAuthRefreshOutcome>;
}

export interface RetryWithOAuthRefreshOptions {
  readonly maxConsecutiveFailures?: number;
  readonly onAuthFailure?: (consecutiveFailures: number) => void;
}

export interface RetryWithOAuthRefreshResult<T> {
  readonly value: T;
  readonly state: OAuthRefreshState;
}

function isUnauthorized(error: unknown): error is Error & { readonly status?: number } {
  return (
    error instanceof Error &&
    ((error as { readonly status?: number }).status === 401 ||
      (error as { readonly statusCode?: number }).statusCode === 401)
  );
}

export async function retryWithOAuthRefresh<T>(
  state: OAuthRefreshState,
  operation: (accessToken: string) => Promise<T>,
  callbacks: OAuthRefreshCallbacks,
  options: RetryWithOAuthRefreshOptions = {},
): Promise<RetryWithOAuthRefreshResult<T>> {
  const maxFailures = Math.max(
    1,
    options.maxConsecutiveFailures ?? MAX_CONSECUTIVE_AUTH_FAILURES,
  );

  for (;;) {
    try {
      const value = await operation(state.accessToken);
      state.consecutiveAuthFailures = 0;
      return { value, state };
    } catch (error) {
      if (!isUnauthorized(error)) {
        throw error;
      }
      state.consecutiveAuthFailures += 1;
      options.onAuthFailure?.(state.consecutiveAuthFailures);
      if (state.consecutiveAuthFailures >= maxFailures) {
        throw error;
      }

      const outcome = await callbacks.refreshAccessToken({
        attempt: state.consecutiveAuthFailures,
        refreshToken: state.refreshToken,
        previousError: error,
      });
      if (outcome.kind !== "refreshed") {
        throw error;
      }
      state.accessToken = outcome.accessToken;
      state.refreshToken = outcome.refreshToken ?? state.refreshToken;
    }
  }
}
