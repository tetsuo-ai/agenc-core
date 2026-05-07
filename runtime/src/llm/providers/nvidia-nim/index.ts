import { OpenAIProvider } from "../openai/adapter.js";
import type { OpenAIProviderConfig } from "../openai/types.js";
import {
  BUILT_IN_PROVIDER_API_KEY_ENVS,
  BUILT_IN_PROVIDER_BASE_URLS,
} from "../../registry/provider-info.js";

export type NvidiaNimProviderConfig = OpenAIProviderConfig;

export class NvidiaNimProvider extends OpenAIProvider {
  constructor(config: NvidiaNimProviderConfig) {
    super({
      ...config,
      providerName: "nvidia-nim",
      apiKeyEnvLabel: BUILT_IN_PROVIDER_API_KEY_ENVS["nvidia-nim"],
      useResponsesApi: false,
      baseURL: config.baseURL ?? BUILT_IN_PROVIDER_BASE_URLS["nvidia-nim"],
    });
  }
}
