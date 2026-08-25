import { OpenAIProvider } from "../openai/adapter.js";
import type { OpenAIProviderConfig } from "../openai/types.js";

export type NvidiaNimProviderConfig = OpenAIProviderConfig;

export class NvidiaNimProvider extends OpenAIProvider {
  constructor(config: NvidiaNimProviderConfig) {
    super({
      ...config,
      providerName: "nvidia-nim",
      useResponsesApi: false,
    });
  }
}
