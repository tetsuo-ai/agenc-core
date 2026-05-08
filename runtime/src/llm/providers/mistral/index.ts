import { OpenAIProvider } from "../openai/adapter.js";
import type { OpenAIProviderConfig } from "../openai/types.js";
import {
  BUILT_IN_PROVIDER_API_KEY_ENVS,
  BUILT_IN_PROVIDER_BASE_URLS,
} from "../../registry/provider-info.js";

export type MistralProviderConfig = OpenAIProviderConfig;

export class MistralProvider extends OpenAIProvider {
  constructor(config: MistralProviderConfig) {
    super({
      ...config,
      providerName: "mistral",
      apiKeyEnvLabel: BUILT_IN_PROVIDER_API_KEY_ENVS.mistral,
      useResponsesApi: false,
      baseURL: config.baseURL ?? BUILT_IN_PROVIDER_BASE_URLS.mistral,
    });
  }
}
