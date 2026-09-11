import { OpenAIProvider } from "../openai/adapter.js";
import type { OpenAIProviderConfig } from "../openai/types.js";
import { OLLAMA_CLOUD_BASE_URL } from "../../registry/ollama-cloud-models.js";

/** Direct Cloud inference, independent of the local Ollama daemon. */
export class OllamaCloudProvider extends OpenAIProvider {
  constructor(config: OpenAIProviderConfig) {
    if (config.baseURL !== undefined && config.baseURL.replace(/\/+$/, "") !== OLLAMA_CLOUD_BASE_URL) {
      throw new Error(`Ollama Cloud requires ${OLLAMA_CLOUD_BASE_URL}`);
    }
    const fetchImpl = config.fetchImpl ?? fetch;
    super({
      ...config,
      baseURL: OLLAMA_CLOUD_BASE_URL,
      providerName: "ollama-cloud",
      useResponsesApi: false,
      authMode: "api_key",
      oauth: undefined,
      fetchImpl: (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.origin !== "https://ollama.com") {
          throw new Error("Ollama Cloud requests must stay on https://ollama.com");
        }
        return fetchImpl(input, { ...init, redirect: "error" });
      },
    });
  }
}
