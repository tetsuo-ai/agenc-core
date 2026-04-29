import { OpenAIProvider } from "../openai/adapter.js";
import type { OpenAIProviderConfig } from "../openai/types.js";

export type DeepSeekProviderConfig = OpenAIProviderConfig;

const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com/v1";

export class DeepSeekProvider extends OpenAIProvider {
  constructor(config: DeepSeekProviderConfig) {
    super({
      ...config,
      providerName: "deepseek",
      apiKeyEnvLabel: "DEEPSEEK_API_KEY",
      useResponsesApi: false,
      baseURL: config.baseURL ?? DEFAULT_DEEPSEEK_BASE_URL,
    });
  }
}
