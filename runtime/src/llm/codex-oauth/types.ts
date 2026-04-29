/**
 * OpenAI Codex OAuth provider configuration.
 *
 * The provider reuses the local Codex CLI ChatGPT OAuth credential store
 * (`$CODEX_HOME/auth.json`, falling back to `~/.codex/auth.json`) instead of
 * requiring an API key in AgenC config.
 *
 * @module
 */

import type { LLMProviderConfig } from "../types.js";

export const DEFAULT_CODEX_OAUTH_BASE_URL =
  "https://chatgpt.com/backend-api/codex";
export const DEFAULT_CODEX_OAUTH_MODEL = "gpt-5.4";
export const DEFAULT_CODEX_OAUTH_CONTEXT_WINDOW_TOKENS = 272_000;
export const DEFAULT_CODEX_CLIENT_VERSION = "0.124.0";

export interface CodexOAuthProviderConfig
  extends Omit<LLMProviderConfig, "model">
{
  /** Model identifier; defaults to the Codex CLI's current default. */
  model?: string;
  /** Override the Codex backend URL. Defaults to ChatGPT's Codex endpoint. */
  baseUrl?: string;
  /** Override `$CODEX_HOME`; defaults to process.env.CODEX_HOME or `~/.codex`. */
  codexHome?: string;
  /** Full path to a Codex `auth.json` file. Takes precedence over codexHome. */
  codexAuthPath?: string;
  /** Override token refresh URL, primarily for tests/private deployments. */
  refreshTokenUrl?: string;
  /** Version header sent to the Codex backend. */
  codexClientVersion?: string;
  /** Optional operator override for effective context window budgeting. */
  contextWindowTokens?: number;
  /** Allow the model to emit multiple tool calls in parallel. */
  parallelToolCalls?: boolean;
}
