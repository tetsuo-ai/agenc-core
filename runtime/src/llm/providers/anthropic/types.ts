/**
 * Anthropic provider configuration types.
 *
 * @module
 */

import type { LLMProviderConfig } from "../../types.js";

export interface AnthropicProviderConfig extends LLMProviderConfig {
  readonly apiKey: string;
  readonly baseURL?: string;
  readonly anthropicVersion?: string;
  readonly betaHeaders?: readonly string[];
  readonly defaultHeaders?: Readonly<Record<string, string>>;
  readonly fetchImpl?: typeof fetch;
}
