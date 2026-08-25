import { OpenAIProvider } from "../openai/adapter.js";
import type { OpenAIProviderConfig } from "../openai/types.js";

export type MistralProviderConfig = OpenAIProviderConfig;

export class MistralProvider extends OpenAIProvider {
  constructor(config: MistralProviderConfig) {
    super({
      ...config,
      providerName: "mistral",
      useResponsesApi: false,
    });
  }
}
