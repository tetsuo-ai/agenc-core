import { endpointMetadataForTransport } from "../../endpoint-metadata-cache.js";
import { veniceFetch } from "./transport.js";
import { LLMProviderError } from "../../errors.js";
import { OpenAIProvider } from "../openai/adapter.js";
import type { OpenAIProviderConfig } from "../openai/types.js";
import type { LLMChatOptions, LLMMessage, StreamProgressCallback } from "../../types.js";
import { ModelMetadataResolver } from "../../model-metadata.js";
import { VENICE_MODELS, type VeniceModel } from "../../registry/venice-models.js";
import type { AgenCConfig } from "../../../config/schema.js";

/** Venice uses Chat Completions with the session's own prompt and tools. */
export class VeniceProvider extends OpenAIProvider {
  readonly #model: string;
  readonly #metadata: ModelMetadataResolver;
  readonly #catalogConfig: AgenCConfig;
  #models: readonly VeniceModel[] = VENICE_MODELS;

  constructor(config: OpenAIProviderConfig) {
    const fetchImpl = veniceFetch(config.fetchImpl ?? fetch, config.apiKey);
    super({
      ...config,
      fetchImpl,
      providerName: "venice",
      useResponsesApi: false,
      extraBody: {
        ...config.extraBody,
        venice_parameters: {
          include_venice_system_prompt: false,
          enable_web_search: "off",
          enable_web_scraping: false,
          enable_web_citations: false,
          enable_x_search: false,
        },
      },
    });
    this.#model = config.model;
    this.#catalogConfig = { providers: { venice: { base_url: config.baseURL } } };
    this.#metadata = new ModelMetadataResolver({ fetchImpl, env: { VENICE_API_KEY: config.apiKey },
      endpointCatalogs: endpointMetadataForTransport(config.fetchImpl ?? fetch) });
  }

  async #refresh(): Promise<readonly VeniceModel[] | undefined> {
    const discovered = await this.#metadata.discoverVeniceModels(this.#catalogConfig);
    this.#models = discovered ?? VENICE_MODELS;
    return discovered;
  }

  async #discover(model: string): Promise<void> {
    const discovered = await this.#refresh();
    // Selection accepts any Venice ID (its catalog is this live list), so a
    // mistyped one stops here, before any request.
    if (discovered && !discovered.some(entry => entry.model === model)) {
      throw new LLMProviderError("venice", `${model} is not an online Venice text model that supports function calling.`);
    }
  }

  /**
   * Admission reserves before the request: read Venice's list first, so the
   * reservation uses this model's published price. An unlisted model is
   * refused by chat() and chatStream(), not here.
   */
  override async getExecutionProfile(options?: LLMChatOptions) {
    await this.#refresh();
    return super.getExecutionProfile(options);
  }

  override async chat(messages: LLMMessage[], options?: LLMChatOptions) {
    await this.#discover(options?.model?.trim() || this.#model);
    return super.chat(messages, options);
  }

  override async chatStream(messages: LLMMessage[], onChunk: StreamProgressCallback, options?: LLMChatOptions) {
    await this.#discover(options?.model?.trim() || this.#model);
    return super.chatStream(messages, onChunk, options);
  }

  protected override chatCapabilityHints(model: string) {
    const entry = this.#models.find(entry => entry.model === model);
    return {
      ...super.chatCapabilityHints(model),
      acceptsReasoningEffort: (entry?.supportedReasoningLevels.length ?? 0) > 0,
      reasoningEffortAllowedValues: new Set(entry?.supportedReasoningLevels ?? []),
      acceptsDirectImageInput: entry?.supportsVision === true,
      toolResultImagePolicy: entry?.supportsVision ? "relay_as_user" as const : "strip" as const,
    };
  }
}
