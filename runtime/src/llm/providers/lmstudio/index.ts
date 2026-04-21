/**
 * LMStudio provider module.
 *
 * @module
 */

import { OpenAIProvider } from "../openai/adapter.js";
import type { OpenAIProviderConfig } from "../openai/types.js";

export type LMStudioProviderConfig = OpenAIProviderConfig;

export class LMStudioProvider extends OpenAIProvider {
  constructor(config: LMStudioProviderConfig) {
    super({
      ...config,
      providerName: "lmstudio",
      apiKeyEnvLabel: "LMSTUDIO_API_KEY",
      authStrategy:
        config.authStrategy ??
        (config.apiKey?.trim() ? "optional_bearer" : "none"),
      useResponsesApi: false,
    });
  }
}
