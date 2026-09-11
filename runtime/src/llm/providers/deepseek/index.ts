import { OpenAIProvider } from "../openai/adapter.js";
import type { OpenAIProviderConfig } from "../openai/types.js";
import { concurrentChatFetch } from "../concurrent-chat-fetch.js";

export type DeepSeekProviderConfig = OpenAIProviderConfig;

export class DeepSeekProvider extends OpenAIProvider {
  constructor(config: DeepSeekProviderConfig) {
    super({
      ...config,
      providerName: "deepseek",
      useResponsesApi: false,
      // Explicit transports remain authoritative; Bun has its own HTTP stack.
      ...(config.fetchImpl || typeof Bun !== "undefined"
        ? {}
        : { fetchImpl: concurrentChatFetch() }),
    });
  }
}
