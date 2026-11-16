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
  readonly maxRefreshAttempts?: number;
  readonly accountId?: string;
  /** Fresh native storage read after a rejected ChatGPT credential. */
  readonly reloadCredentials?: () => Promise<{
    readonly accessToken: string;
    readonly refreshToken?: string;
    readonly accountId?: string;
  } | undefined>;
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
  /**
   * How streamed Responses calls of the `openai` provider travel: `http`
   * (SSE) or `websocket` (one socket per session that sends only new input
   * items when it can, with HTTP as the fallback). Unset, the calls of a
   * Light session use `websocket` and every other call `http`. Other
   * providers built on this adapter ignore it.
   */
  readonly responsesTransport?: "http" | "websocket";
  /**
   * How the `openai` provider declares apply_patch on the Responses API:
   * `freeform` sends OpenAI's custom tool form (plain patch text under a Lark
   * grammar) to GPT-5 and later; unset or `function` keeps the JSON function
   * tool. Other providers built on this adapter ignore it.
   */
  readonly responsesToolFormat?: "function" | "freeform";
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
   * `provider.zdr = true`, on by default); the base adapter ignores it.
   */
  readonly zeroDataRetention?: boolean;
  /**
   * Fields merged verbatim into every chat-completions request body after
   * shaping, for provider-specific routing preferences the shared wire
   * layer does not model. Never carries user-controlled input.
   */
  readonly extraBody?: Readonly<Record<string, unknown>>;
}
