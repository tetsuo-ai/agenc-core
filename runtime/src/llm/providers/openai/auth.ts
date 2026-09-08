/**
 * Provider auth resolver.
 *
 * Supports API key and OAuth access-token modes.
 *
 * @module
 */

import { AsyncLocalStorage } from "node:async_hooks";
import {
  assertNonEmptyApiKey,
  buildBearerAuthHeaders,
} from "../../auth/bearer.js";
import {
  MAX_CONSECUTIVE_AUTH_FAILURES,
  type OAuthRefreshCallbacks,
  type OAuthRefreshOutcome,
  type OAuthRefreshState,
} from "../../oauth/refresh-loop.js";
import type { ProviderAuthHeaderContext } from "../../client-session.js";
import { LLMProviderError } from "../../errors.js";
import { providerApiKeyEnvironmentLabel } from "../../registry/provider-info.js";
import type { OpenAIProviderConfig } from "./types.js";

interface AuthorizedOperationOptions {
  readonly singleWireAttempt?: boolean;
  readonly signal?: AbortSignal;
}

export class OpenAIAuthSession {
  private readonly config: OpenAIProviderConfig;
  private oauthState: OAuthRefreshState | null;
  private oauthExhaustedMessage: string | null = null;
  private readonly operationState = new AsyncLocalStorage<OAuthRefreshState>();
  private refreshFlight: {
    readonly state: OAuthRefreshState;
    readonly promise: Promise<void>;
  } | null = null;
  private readonly providerName: string;
  private readonly apiKeyEnvLabel: string;

  constructor(config: OpenAIProviderConfig) {
    this.config = config;
    this.providerName = config.providerName ?? "openai";
    this.apiKeyEnvLabel =
      config.apiKeyEnvLabel ??
      providerApiKeyEnvironmentLabel(this.providerName) ??
      "API key";
    this.oauthState =
      config.authMode === "oauth" && config.oauth
        ? {
          accessToken: config.oauth.accessToken,
          refreshToken: config.oauth.refreshToken,
          consecutiveAuthFailures: 0,
        }
        : null;
  }

  async withAuthorizedOperation<T>(
    operation: () => Promise<T>,
    options: AuthorizedOperationOptions = {},
  ): Promise<T> {
    const oauth = this.config.oauth;
    if (!this.oauthState || !oauth) return await operation();
    let authFailures = 0;
    for (;;) {
      options.signal?.throwIfAborted();
      const state: OAuthRefreshState = this.oauthState;
      if (this.oauthExhaustedMessage) {
        throw this.exhaustedError(state);
      }
      try {
        const value = await this.operationState.run(state, operation);
        if (this.oauthState === state) state.consecutiveAuthFailures = 0;
        return value;
      } catch (error) {
        authFailures += 1;
        await this.recoverAuthFailure(state, error, options, authFailures);
      }
    }
  }

  private async recoverAuthFailure(
    state: OAuthRefreshState,
    error: unknown,
    options: AuthorizedOperationOptions,
    authFailures: number,
  ): Promise<void> {
    const oauth = this.config.oauth;
    if (!isUnauthorizedStatus(error) || options.singleWireAttempt === true || !oauth) {
      throw error;
    }
    options.signal?.throwIfAborted();
    if (authFailures >= MAX_CONSECUTIVE_AUTH_FAILURES) {
      throw this.oauthState === state ? this.exhaustedError(state) : error;
    }
    if (this.oauthState !== state) return;
    await waitForOAuthRefresh(this.refreshOAuthState(state, error, oauth), options.signal);
  }

  private exhaustedError(state: OAuthRefreshState): LLMProviderError {
    const message = `OAuth refresh exhausted - re-authenticate via ${this.providerName} login.`;
    if (this.oauthState === state) this.oauthExhaustedMessage = message;
    return new LLMProviderError(this.providerName, message, 401);
  }

  private async refreshOAuthState(
    state: OAuthRefreshState,
    previousError: Error & { readonly status?: number },
    callbacks: OAuthRefreshCallbacks,
  ): Promise<void> {
    if (this.refreshFlight?.state === state) return await this.refreshFlight.promise;
    if (this.oauthState !== state) return;
    if (this.oauthExhaustedMessage) throw this.exhaustedError(state);
    state.consecutiveAuthFailures += 1;
    if (state.consecutiveAuthFailures >= MAX_CONSECUTIVE_AUTH_FAILURES) {
      throw this.exhaustedError(state);
    }
    const promise = this.performOAuthRefresh(state, previousError, callbacks);
    this.refreshFlight = { state, promise };
    try {
      await promise;
    } finally {
      if (this.refreshFlight?.promise === promise) this.refreshFlight = null;
    }
  }

  private async performOAuthRefresh(
    state: OAuthRefreshState,
    previousError: Error & { readonly status?: number },
    callbacks: OAuthRefreshCallbacks,
  ): Promise<void> {
    let outcome: OAuthRefreshOutcome;
    try {
      outcome = await callbacks.refreshAccessToken({
        attempt: state.consecutiveAuthFailures,
        refreshToken: state.refreshToken,
        previousError,
      });
    } catch (error) {
      if (this.oauthState !== state) return;
      if (isUnauthorizedStatus(error)) throw this.exhaustedError(state);
      throw error;
    }
    if (this.oauthState !== state) return;
    if (outcome.kind !== "refreshed") throw this.exhaustedError(state);
    this.oauthState = {
      accessToken: outcome.accessToken,
      refreshToken: outcome.refreshToken ?? state.refreshToken,
      consecutiveAuthFailures: state.consecutiveAuthFailures,
    };
    this.oauthExhaustedMessage = null;
  }

  resolveHeaders(
    _context?: ProviderAuthHeaderContext,
  ): Readonly<Record<string, string>> {
    const state = this.operationState.getStore() ?? this.oauthState;
    if (state) {
      return this.headersForBearerToken(state.accessToken);
    }

    switch (this.config.authStrategy ?? "bearer") {
      case "none":
        return {};
      case "optional_bearer": {
        const token = this.config.apiKey?.trim();
        return token ? this.headersForBearerToken(token) : {};
      }
      case "bearer":
      default: {
        const apiKey = assertNonEmptyApiKey(
          this.providerName,
          this.config.apiKey,
          this.apiKeyEnvLabel,
        );
        return this.headersForBearerToken(apiKey);
      }
    }
  }

  private headersForBearerToken(token: string): Record<string, string> {
    return {
      ...buildBearerAuthHeaders({ apiKey: token }),
      ...(this.config.organization
        ? { "openai-organization": this.config.organization }
        : {}),
      ...(this.config.project
        ? { "openai-project": this.config.project }
        : {}),
    };
  }
}

function isUnauthorizedStatus(
  error: unknown,
): error is Error & { readonly status?: number; readonly statusCode?: number } {
  if (!(error instanceof Error)) return false;
  const status = (error as { readonly status?: unknown }).status;
  const statusCode = (error as { readonly statusCode?: unknown }).statusCode;
  return status === 401 || statusCode === 401;
}

function waitForOAuthRefresh(operation: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return operation;
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason ?? new DOMException("Operation aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
    if (signal.aborted) onAbort();
  });
}
