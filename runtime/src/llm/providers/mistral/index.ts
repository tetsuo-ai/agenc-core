import { OpenAIProvider } from "../openai/adapter.js";
import type { OpenAIProviderConfig } from "../openai/types.js";
import {
  BUILT_IN_PROVIDER_BASE_URLS,
  providerApiKeyEnvironmentLabel,
} from "../../registry/provider-info.js";

export type MistralProviderConfig = OpenAIProviderConfig;

export class MistralProvider extends OpenAIProvider {
  constructor(config: MistralProviderConfig) {
    super({
      ...config,
      providerName: "mistral",
      apiKeyEnvLabel: providerApiKeyEnvironmentLabel("mistral"),
      useResponsesApi: false,
      baseURL: config.baseURL ?? BUILT_IN_PROVIDER_BASE_URLS.mistral,
    });
  }
}
