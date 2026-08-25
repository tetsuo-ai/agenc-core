import { OpenAIProvider } from "../openai/adapter.js";
import type { OpenAIProviderConfig } from "../openai/types.js";

export type DeepSeekProviderConfig = OpenAIProviderConfig;

export class DeepSeekProvider extends OpenAIProvider {
  constructor(config: DeepSeekProviderConfig) {
    super({
      ...config,
      providerName: "deepseek",
      useResponsesApi: false,
    });
  }
}
