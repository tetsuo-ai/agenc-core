/**
 * LMStudio provider module.
 *
 * @module
 */

import { OpenAIProvider } from "../openai/adapter.js";
import type { OpenAIProviderConfig } from "../openai/types.js";
import type {
  LLMChatOptions,
  LLMMessage,
  LLMResponse,
  StreamProgressCallback,
} from "../../types.js";
import { withLmstudioHealthSidecar } from "./health.js";

export type LMStudioProviderConfig = OpenAIProviderConfig;

const DEFAULT_LMSTUDIO_BASE_URL = "http://localhost:1234/v1";

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
      baseURL: config.baseURL ?? DEFAULT_LMSTUDIO_BASE_URL,
    });
  }

  async chatStream(
    messages: LLMMessage[],
    onChunk: StreamProgressCallback,
    options?: LLMChatOptions,
  ): Promise<LLMResponse> {
    return await withLmstudioHealthSidecar({
      signal: options?.signal,
      healthCheck: async () => await super.healthCheck(),
      operation: async (signal) =>
        await super.chatStream(messages, onChunk, {
          ...(options ?? {}),
          signal,
        }),
    });
  }
}
