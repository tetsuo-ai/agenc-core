import { OpenAIProvider } from "../openai/adapter.js";
import type { OpenAIProviderConfig } from "../openai/types.js";

export type MiniMaxProviderConfig = OpenAIProviderConfig;

export class MiniMaxProvider extends OpenAIProvider {
  constructor(config: MiniMaxProviderConfig) {
    super({
      ...config,
      providerName: "minimax",
      useResponsesApi: false,
    });
  }
}
