import { OpenAIProvider } from "../openai/adapter.js";
import type { OpenAIProviderConfig } from "../openai/types.js";
import {
  BUILT_IN_PROVIDER_API_KEY_ENVS,
  BUILT_IN_PROVIDER_BASE_URLS,
} from "../../registry/provider-info.js";

export type MiniMaxProviderConfig = OpenAIProviderConfig;

export class MiniMaxProvider extends OpenAIProvider {
  constructor(config: MiniMaxProviderConfig) {
    super({
      ...config,
      providerName: "minimax",
      apiKeyEnvLabel: BUILT_IN_PROVIDER_API_KEY_ENVS.minimax,
      useResponsesApi: false,
      baseURL: config.baseURL ?? BUILT_IN_PROVIDER_BASE_URLS.minimax,
    });
  }
}
