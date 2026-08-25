/**
 * Generic compatible provider module.
 *
 * @module
 */

import { OpenAIProvider } from "../openai/adapter.js";
import type { OpenAIProviderConfig } from "../openai/types.js";

export type OpenAICompatibleProviderConfig = OpenAIProviderConfig;

export class OpenAICompatibleProvider extends OpenAIProvider {
  constructor(config: OpenAICompatibleProviderConfig) {
    super({
      ...config,
      providerName: "openai-compatible",
      authStrategy:
        config.authStrategy ??
        (config.apiKey?.trim() ? "optional_bearer" : "none"),
      useResponsesApi: false,
    });
  }
}
