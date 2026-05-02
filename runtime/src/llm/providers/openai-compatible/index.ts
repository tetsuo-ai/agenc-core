/**
 * Generic OpenAI-compatible provider module.
 *
 * @module
 */

import { OpenAIProvider } from "../openai/adapter.js";
import type { OpenAIProviderConfig } from "../openai/types.js";

export type OpenAICompatibleProviderConfig = OpenAIProviderConfig;

export const OPENAI_COMPATIBLE_DEFAULT_BASE_URL = "http://localhost:8000/v1";
export const OPENAI_COMPATIBLE_DEFAULT_MODEL = "local-model";

export class OpenAICompatibleProvider extends OpenAIProvider {
  constructor(config: OpenAICompatibleProviderConfig) {
    super({
      ...config,
      providerName: "openai-compatible",
      apiKeyEnvLabel: "OPENAI_COMPATIBLE_API_KEY",
      authStrategy:
        config.authStrategy ??
        (config.apiKey?.trim() ? "optional_bearer" : "none"),
      useResponsesApi: false,
      baseURL: config.baseURL ?? OPENAI_COMPATIBLE_DEFAULT_BASE_URL,
    });
  }
}
