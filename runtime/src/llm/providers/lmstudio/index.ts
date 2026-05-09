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

  async chat(
    messages: LLMMessage[],
    options?: LLMChatOptions,
  ): Promise<LLMResponse> {
    // The non-streaming `chat()` path is what `--print` mode and the
    // synchronous `oneShotCLI` path use. Without the health sidecar
    // here, a closed local lmstudio port hangs the request until the
    // configured timeoutMs (default minutes) — the user sees no
    // output and no error. The sidecar's interval probe surfaces the
    // unreachable server within ~10s with a clear "restart lmstudio
    // and retry" message instead.
    return await withLmstudioHealthSidecar({
      signal: options?.signal,
      healthCheck: async () => await super.healthCheck(),
      operation: async (signal) =>
        await super.chat(messages, {
          ...(options ?? {}),
          signal,
        }),
    });
  }
}
