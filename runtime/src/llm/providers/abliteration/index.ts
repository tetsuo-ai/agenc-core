import { endpointMetadataForTransport } from "../../endpoint-metadata-cache.js";
import { LLMProviderError } from "../../errors.js";
import { ModelMetadataResolver } from "../../model-metadata.js";
import { OpenAIProvider } from "../openai/adapter.js";
import type { OpenAIProviderConfig } from "../openai/types.js";
import type { LLMChatOptions, LLMMessage, StreamProgressCallback } from "../../types.js";
import type { AgenCConfig } from "../../../config/schema.js";

/**
 * abliteration.ai over Chat Completions, with the session's own prompt and
 * tools. The model list (`GET /v1/models`) is read with the session's key
 * before admission, so limits, modalities and prices are the listed ones.
 * https://docs.abliteration.ai/api/openai-compatibility
 */
export class AbliterationProvider extends OpenAIProvider {
  readonly #model: string;
  readonly #metadata: ModelMetadataResolver;
  readonly #catalogConfig: AgenCConfig;

  constructor(config: OpenAIProviderConfig) {
    super({
      ...config,
      providerName: "abliteration",
      useResponsesApi: false,
    });
    const fetchImpl = config.fetchImpl ?? fetch;
    this.#model = config.model;
    this.#catalogConfig = { providers: { abliteration: { base_url: config.baseURL } } };
    this.#metadata = new ModelMetadataResolver({
      fetchImpl,
      env: { ABLIT_KEY: config.apiKey },
      endpointCatalogs: endpointMetadataForTransport(fetchImpl),
    });
  }

  /** Best effort: the bundled rows answer while the list cannot be read. */
  async #listed(): Promise<readonly string[] | undefined> {
    try {
      return (await this.#metadata.discoverAbliterationModels(this.#catalogConfig))?.map(entry => entry.model);
    } catch {
      return undefined;
    }
  }

  /**
   * A model the list leaves out (locked for the key's project, not ready, or
   * unknown) is refused here, before a request is sent or billed.
   */
  async #assertListed(model: string): Promise<void> {
    const listed = await this.#listed();
    if (listed !== undefined && !listed.includes(model)) {
      throw new LLMProviderError(
        "abliteration",
        `${model} is not available to this abliteration.ai API key. Its model list marks it locked or not ready, or does not list it.`,
      );
    }
  }

  /** Admission reserves before the request: read the list first, so it prices this model at its listed rate. */
  override async getExecutionProfile(options?: LLMChatOptions) {
    await this.#listed();
    return super.getExecutionProfile(options);
  }

  override async chat(messages: LLMMessage[], options?: LLMChatOptions) {
    await this.#assertListed(options?.model?.trim() || this.#model);
    return super.chat(messages, options);
  }

  override async chatStream(messages: LLMMessage[], onChunk: StreamProgressCallback, options?: LLMChatOptions) {
    await this.#assertListed(options?.model?.trim() || this.#model);
    return super.chatStream(messages, onChunk, options);
  }
}
