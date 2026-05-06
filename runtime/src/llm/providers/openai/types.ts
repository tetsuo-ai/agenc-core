/**
 * Provider configuration types.
 *
 * @module
 */

import type { LLMProviderConfig } from "../../types.js";
import type { OAuthRefreshCallbacks } from "../../oauth/refresh-loop.js";

export interface OpenAIOAuthConfig extends OAuthRefreshCallbacks {
  readonly accessToken: string;
  readonly refreshToken?: string;
}

export type OpenAIProviderAuthStrategy =
  | "bearer"
  | "optional_bearer"
  | "none"
  | "google_api_key";

export interface OpenAIProviderConfig extends LLMProviderConfig {
  readonly apiKey?: string;
  readonly baseURL?: string;
  readonly contextWindowTokens?: number;
  readonly organization?: string;
  readonly project?: string;
  readonly useResponsesApi?: boolean;
  readonly store?: boolean;
  readonly authMode?: "api_key" | "oauth";
  readonly oauth?: OpenAIOAuthConfig;
  readonly defaultHeaders?: Readonly<Record<string, string>>;
  readonly fetchImpl?: typeof fetch;
  readonly providerName?: string;
  readonly apiKeyEnvLabel?: string;
  readonly authStrategy?: OpenAIProviderAuthStrategy;
  readonly basePath?: string;
}
