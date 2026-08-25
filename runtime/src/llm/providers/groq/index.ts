import { OpenAIProvider } from "../openai/adapter.js";
import type { OpenAIProviderConfig } from "../openai/types.js";
import {
  BUILT_IN_PROVIDER_BASE_URLS,
  providerApiKeyEnvironmentLabel,
} from "../../registry/provider-info.js";

export type GroqProviderConfig = OpenAIProviderConfig;

export class GroqProvider extends OpenAIProvider {
  constructor(config: GroqProviderConfig) {
    super({
      ...config,
      providerName: "groq",
      apiKeyEnvLabel: providerApiKeyEnvironmentLabel("groq"),
      useResponsesApi: false,
      baseURL: config.baseURL ?? BUILT_IN_PROVIDER_BASE_URLS.groq,
    });
  }
}
