/**
 * Provider auth resolver.
 *
 * Supports API key and OAuth access-token modes.
 *
 * @module
 */

import {
  assertNonEmptyApiKey,
  buildBearerAuthHeaders,
} from "../../auth/bearer.js";
import {
  retryWithOAuthRefresh,
  type OAuthRefreshState,
} from "../../oauth/refresh-loop.js";
import type { ProviderAuthHeaderContext } from "../../client-session.js";
import { LLMProviderError } from "../../errors.js";
import type { OpenAIProviderConfig } from "./types.js";

export class OpenAIAuthSession {
  private readonly config: OpenAIProviderConfig;
  private oauthState: OAuthRefreshState | null;
  private oauthExhaustedMessage: string | null = null;
  private readonly providerName: string;
  private readonly apiKeyEnvLabel: string;

  constructor(config: OpenAIProviderConfig) {
    this.config = config;
    this.providerName = config.providerName ?? "openai";
    this.apiKeyEnvLabel = config.apiKeyEnvLabel ?? "OPENAI_API_KEY";
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
    options: { readonly singleWireAttempt?: boolean } = {},
  ): Promise<T> {
    if (this.oauthState && this.config.oauth) {
      if (this.oauthExhaustedMessage) {
        throw new LLMProviderError(
          this.providerName,
          this.oauthExhaustedMessage,
          401,
        );
      }

      try {
        if (options.singleWireAttempt === true) {
          return await operation();
        }
        const result = await retryWithOAuthRefresh(
          this.oauthState,
          async () => await operation(),
          this.config.oauth,
        );
        this.oauthState = result.state;
        this.oauthExhaustedMessage = null;
        return result.value;
      } catch (error) {
        if (isUnauthorizedStatus(error)) {
          this.oauthExhaustedMessage =
            `OAuth refresh exhausted - re-authenticate via ${this.providerName} login.`;
          throw new LLMProviderError(
            this.providerName,
            this.oauthExhaustedMessage,
            401,
          );
        }
        throw error;
      }
    }

    return await operation();
  }

  resolveHeaders(
    _context?: ProviderAuthHeaderContext,
  ): Readonly<Record<string, string>> {
    if (this.oauthState) {
      return this.headersForBearerToken(this.oauthState.accessToken);
    }

    switch (this.config.authStrategy ?? "bearer") {
      case "none":
        return {};
      case "optional_bearer": {
        const token = this.config.apiKey?.trim();
        return token ? this.headersForBearerToken(token) : {};
      }
      case "google_api_key": {
        const apiKey = assertNonEmptyApiKey(
          this.providerName,
          this.config.apiKey,
          this.apiKeyEnvLabel,
        );
        return {
          "x-goog-api-key": apiKey,
          ...(this.config.project
            ? { "x-goog-user-project": this.config.project }
            : {}),
        };
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
  const status = (error as { readonly status?: unknown }).status;
  const statusCode = (error as { readonly statusCode?: unknown }).statusCode;
  return status === 401 || statusCode === 401;
}
