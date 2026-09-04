import { OpenAIProvider } from "../openai/adapter.js";
import type { OpenAIProviderConfig } from "../openai/types.js";

export type CerebrasProviderConfig = OpenAIProviderConfig;

/** Cerebras Inference adapter over its OpenAI-compatible chat wire. */
export class CerebrasProvider extends OpenAIProvider {
  constructor(config: CerebrasProviderConfig) {
    super({
      ...config,
      providerName: "cerebras",
      useResponsesApi: false,
      defaultHeaders: {
        ...Object.fromEntries(
          Object.entries(config.defaultHeaders ?? {}).filter(
            ([name]) => name.toLowerCase() !== "x-cerebras-version-patch",
          ),
        ),
        "X-Cerebras-Version-Patch": "2",
      },
    });
  }
}
