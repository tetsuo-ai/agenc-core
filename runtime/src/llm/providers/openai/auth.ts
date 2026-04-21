/**
 * OpenAI auth resolver.
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
import type { OpenAIProviderConfig } from "./types.js";

export class OpenAIAuthSession {
  private readonly config: OpenAIProviderConfig;
  private oauthState: OAuthRefreshState | null;

  constructor(config: OpenAIProviderConfig) {
    this.config = config;
    this.oauthState =
      config.authMode === "oauth" && config.oauth
        ? {
          accessToken: config.oauth.accessToken,
          refreshToken: config.oauth.refreshToken,
          consecutiveAuthFailures: 0,
        }
        : null;
  }

  async withAuthHeaders<T>(
    operation: (headers: Record<string, string>) => Promise<T>,
  ): Promise<T> {
    if (this.oauthState && this.config.oauth) {
      const result = await retryWithOAuthRefresh(
        this.oauthState,
        async (accessToken) =>
          operation(this.headersForToken(accessToken)),
        this.config.oauth,
      );
      this.oauthState = result.state;
      return result.value;
    }

    const apiKey = assertNonEmptyApiKey(
      "openai",
      this.config.apiKey,
      "OPENAI_API_KEY",
    );
    return operation(this.headersForToken(apiKey));
  }

  private headersForToken(token: string): Record<string, string> {
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
