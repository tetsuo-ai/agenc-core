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
import { isInitialProviderHttpRejection, type ProviderAuthHeaderContext } from "../../client-session.js";
import {
  isLLMPreGenerationRejection,
  LLMAuthenticationError,
  LLMProviderError,
  markLLMPreGenerationRejection,
} from "../../errors.js";
import { providerApiKeyEnvironmentLabel } from "../../registry/provider-info.js";
import type { OpenAIProviderConfig } from "./types.js";

interface AuthorizedOperationOptions {
  readonly singleWireAttempt?: boolean;
  readonly openAiAuthRetryAttempt?: number;
  readonly signal?: AbortSignal;
}

/** Credentials recovered, but the rejected wire attempt must settle first. */
export class OpenAIAuthRetryError extends LLMProviderError {
  constructor() {
    super("openai", "ChatGPT credentials recovered; a new admission is required.", 401);
    markLLMPreGenerationRejection(this, "openai");
  }
}

interface OpenAIAuthState extends OAuthRefreshState {
  readonly accountId?: string;
}

export class OpenAIAuthSession {
  private readonly config: OpenAIProviderConfig;
  private oauthState: OpenAIAuthState | null;
  private oauthExhaustedMessage: string | null = null;
  private readonly operationState = new AsyncLocalStorage<OpenAIAuthState>();
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
          accountId: config.oauth.accountId,
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
    if (this.providerName === "openai" && this.config.chatgptBackend === true) {
      return this.withChatGptOperation(operation, options);
    }
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

  private async withChatGptOperation<T>(
    operation: () => Promise<T>,
    options: AuthorizedOperationOptions,
  ): Promise<T> {
    let attempt = options.openAiAuthRetryAttempt ?? 0;
    for (;;) {
      options.signal?.throwIfAborted();
      const exhaustedMessage = this.oauthExhaustedMessage;
      if (exhaustedMessage) {
        if (!await waitForOAuthRefresh(this.reloadChatGptCredentials(this.oauthState!), options.signal)) {
          // No wire request was made while this generation remains exhausted.
          throw markLLMPreGenerationRejection(
            new LLMAuthenticationError("openai", 401, exhaustedMessage), "openai",
          );
        }
      }
      const state = this.oauthState!;
      try {
        const value = await this.operationState.run(state, operation);
        if (this.oauthState === state) state.consecutiveAuthFailures = 0;
        return value;
      } catch (error) {
        if (!isUnauthorizedStatus(error)) throw error;
        options.signal?.throwIfAborted();
        const rejected = isInitialProviderHttpRejection(error) ||
          isLLMPreGenerationRejection(error, "openai");
        // Never replay a stream that has already started generating.
        if (rejected && attempt < 2) {
          if (attempt === 0 && this.oauthState === state) {
            try {
              await waitForOAuthRefresh(this.refreshOAuthState(state, error, this.config.oauth!), options.signal);
            } catch {
              options.signal?.throwIfAborted();
              // A revoked refresh token can race a fresh interactive sign-in.
            }
          }
          if (this.oauthState !== state ||
              await waitForOAuthRefresh(this.reloadChatGptCredentials(state), options.signal)) {
            options.signal?.throwIfAborted();
            if (options.singleWireAttempt) throw new OpenAIAuthRetryError();
            attempt += 1;
            continue;
          }
        }
        const message = `${chatGptServerMessage(error)} ChatGPT sign-in recovery failed. Run agenc openai-login to sign in again.`;
        if (this.oauthState === state) this.oauthExhaustedMessage = message;
        const failure = new LLMAuthenticationError("openai", 401, message);
        throw rejected ? markLLMPreGenerationRejection(failure, "openai") : failure;
      }
    }
  }

  private async reloadChatGptCredentials(state: OpenAIAuthState): Promise<boolean> {
    const stored = await this.config.oauth?.reloadCredentials?.().catch(() => undefined);
    if (this.oauthState !== state) return true;
    if (!stored || stored.accessToken === state.accessToken) return false;
    this.oauthState = { ...stored, consecutiveAuthFailures: 0 };
    this.oauthExhaustedMessage = null;
    return true;
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
    if (authFailures > (oauth.maxRefreshAttempts ?? MAX_CONSECUTIVE_AUTH_FAILURES - 1)) {
      throw this.oauthState === state ? this.exhaustedError(state) : error;
    }
    if (this.oauthState !== state) return;
    await waitForOAuthRefresh(this.refreshOAuthState(state, error, oauth), options.signal);
  }

  private exhaustedError(state: OAuthRefreshState): LLMProviderError {
    const message = `OAuth refresh exhausted - re-authenticate via ${this.providerName} login.`;
    if (this.oauthState === state && !(this.providerName === "openai" && this.config.chatgptBackend)) {
      this.oauthExhaustedMessage = message;
    }
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
      accountId: "accountId" in outcome && typeof outcome.accountId === "string"
        ? outcome.accountId : (state as OpenAIAuthState).accountId,
      consecutiveAuthFailures: state.consecutiveAuthFailures,
    };
    this.oauthExhaustedMessage = null;
  }

  resolveHeaders(
    _context?: ProviderAuthHeaderContext,
  ): Readonly<Record<string, string>> {
    const state = this.operationState.getStore() ?? this.oauthState;
    if (state) {
      return {
        ...this.headersForBearerToken(state.accessToken),
        ...(this.providerName === "openai" && this.config.chatgptBackend && state.accountId
          ? { "ChatGPT-Account-ID": state.accountId } : {}),
      };
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

function chatGptServerMessage(error: Error): string {
  const body = (error as Error & { readonly body?: unknown }).body;
  let value: unknown = body;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { /* A plain-text refusal is valid. */ }
  }
  if (value && typeof value === "object") {
    const record = value as { message?: unknown; error?: { message?: unknown } | string };
    value = typeof record.error === "string" ? record.error : record.error?.message ?? record.message;
  }
  return (typeof value === "string" && value.trim() ? value : error.message).replace(/\s+/g, " ").trim();
}

function waitForOAuthRefresh<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason ?? new DOMException("Operation aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
    if (signal.aborted) onAbort();
  });
}
