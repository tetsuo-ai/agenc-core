import { OpenAIProvider } from "../openai/adapter.js";
import type { OpenAIProviderConfig } from "../openai/types.js";
import type { LLMChatOptions } from "../../types.js";
import { OLLAMA_CLOUD_BASE_URL } from "../../registry/ollama-cloud-models.js";
import { ModelMetadataResolver } from "../../model-metadata.js";
import { publishedModelDetailRecordedAt } from "../../registry/published-model-catalog.js";

/**
 * How long a model row this process already read from Ollama is used as it
 * is before the provider reads it again. Ollama changes rows rarely.
 */
const SHOWN_ROW_REUSE_MS = 15 * 60_000;

/** Direct Cloud inference, independent of the local Ollama daemon. */
export class OllamaCloudProvider extends OpenAIProvider {
  readonly #model: string;
  readonly #metadata: ModelMetadataResolver;

  constructor(config: OpenAIProviderConfig) {
    if (config.baseURL !== undefined && config.baseURL.replace(/\/+$/, "") !== OLLAMA_CLOUD_BASE_URL) {
      throw new Error(`Ollama Cloud requires ${OLLAMA_CLOUD_BASE_URL}`);
    }
    const fetchImpl = config.fetchImpl ?? fetch;
    const pinnedFetch: typeof fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin !== "https://ollama.com") {
        throw new Error("Ollama Cloud requests must stay on https://ollama.com");
      }
      return fetchImpl(input, { ...init, redirect: "error" });
    };
    super({
      ...config,
      baseURL: OLLAMA_CLOUD_BASE_URL,
      providerName: "ollama-cloud",
      useResponsesApi: false,
      authMode: "api_key",
      oauth: undefined,
      fetchImpl: pinnedFetch,
    });
    this.#model = config.model;
    this.#metadata = new ModelMetadataResolver({
      fetchImpl: pinnedFetch,
      env: config.apiKey === undefined ? {} : { OLLAMA_API_KEY: config.apiKey },
      timeoutMs: 5_000,
    });
  }

  /**
   * Read Ollama's own row for the model (`/api/tags`, `/api/show`) before
   * admission, so capability flags and effort levels are the live ones for
   * a model the bundled snapshot does not know. Best effort.
   */
  override async getExecutionProfile(options?: LLMChatOptions) {
    const model = options?.model?.trim() || this.#model;
    // The session's own resolver reads this row when the session starts.
    // Reading it again here held the first request about 0.45 s after Enter
    // (a new connection plus /api/tags and /api/show, measured against
    // ollama.com), so a row read in the last minutes is used as it is.
    const shownAt = publishedModelDetailRecordedAt("ollama-cloud", model);
    if (shownAt === undefined || Date.now() - shownAt >= SHOWN_ROW_REUSE_MS) {
      try {
        await this.#metadata.discoverOllamaCloudModels({}, model);
      } catch {
        // The bundled rows answer while Ollama's list cannot be read.
      }
    }
    return super.getExecutionProfile(options);
  }
}
