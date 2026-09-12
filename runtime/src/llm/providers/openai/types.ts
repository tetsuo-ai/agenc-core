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
  | "none";

export interface OpenAIProviderConfig extends LLMProviderConfig {
  readonly apiKey?: string;
  readonly baseURL?: string;
  readonly contextWindowTokens?: number;
  readonly organization?: string;
  readonly project?: string;
  readonly useResponsesApi?: boolean;
  readonly store?: boolean;
  /** Fixed ChatGPT subscription transport, distinct from the platform API. */
  readonly chatgptBackend?: boolean;
  readonly authMode?: "api_key" | "oauth";
  readonly oauth?: OpenAIOAuthConfig;
  readonly defaultHeaders?: Readonly<Record<string, string>>;
  readonly fetchImpl?: typeof fetch;
  readonly providerName?: string;
  readonly apiKeyEnvLabel?: string;
  readonly authStrategy?: OpenAIProviderAuthStrategy;
  readonly basePath?: string;
  /** Internal managed transport marker; direct provider credentials omit it. */
  readonly managedRequestId?: boolean;
  /**
   * Zero data retention as a request-level routing preference. Only
   * subclasses whose API has such a control act on it (OpenRouter sends
   * `provider.zdr = true`); the base adapter ignores it.
   */
  readonly zeroDataRetention?: boolean;
  /**
   * Fields merged verbatim into every chat-completions request body after
   * shaping, for provider-specific routing preferences the shared wire
   * layer does not model. Never carries user-controlled input.
   */
  readonly extraBody?: Readonly<Record<string, unknown>>;
}
