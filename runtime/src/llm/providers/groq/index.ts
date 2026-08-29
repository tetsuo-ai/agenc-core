import { OpenAIProvider } from "../openai/adapter.js";
import type { OpenAIProviderConfig } from "../openai/types.js";

export type GroqProviderConfig = OpenAIProviderConfig;

export class GroqProvider extends OpenAIProvider {
  constructor(config: GroqProviderConfig) {
    super({
      ...config,
      providerName: "groq",
      useResponsesApi: false,
    });
  }
}
