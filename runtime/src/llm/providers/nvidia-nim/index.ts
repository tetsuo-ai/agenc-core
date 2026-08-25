import { OpenAIProvider } from "../openai/adapter.js";
import type { OpenAIProviderConfig } from "../openai/types.js";
import {
  BUILT_IN_PROVIDER_BASE_URLS,
  providerApiKeyEnvironmentLabel,
} from "../../registry/provider-info.js";

export type NvidiaNimProviderConfig = OpenAIProviderConfig;

export class NvidiaNimProvider extends OpenAIProvider {
  constructor(config: NvidiaNimProviderConfig) {
    super({
      ...config,
      providerName: "nvidia-nim",
      apiKeyEnvLabel: providerApiKeyEnvironmentLabel("nvidia-nim"),
      useResponsesApi: false,
      baseURL: config.baseURL ?? BUILT_IN_PROVIDER_BASE_URLS["nvidia-nim"],
    });
  }
}
