import { OpenAIProvider } from "../openai/adapter.js";
import type { OpenAIProviderConfig } from "../openai/types.js";

export type MetaProviderConfig = OpenAIProviderConfig;

/**
 * Meta Model API adapter. Muse Spark uses the OpenAI-compatible Chat
 * Completions wire; Muse Wonder uses the Responses wire, the only Meta
 * surface that replays reasoning between turns (see `meta-models.ts`).
 */
export class MetaProvider extends OpenAIProvider {
  constructor(config: MetaProviderConfig) {
    super({
      ...config,
      providerName: "meta",
      useResponsesApi: false,
    });
  }
}
