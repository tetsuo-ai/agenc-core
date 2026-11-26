import { endpointMetadataForTransport } from "../../endpoint-metadata-cache.js";
import { trustedRouterFetch } from "./transport.js";
import { LLMCapabilityError } from "../../errors.js";
import { OpenAIProvider } from "../openai/adapter.js";
import type { OpenAIProviderConfig } from "../openai/types.js";
import type { LLMChatOptions, LLMMessage, StreamProgressCallback } from "../../types.js";
import { ModelMetadataResolver } from "../../model-metadata.js";
import {
  TRUSTEDROUTER_MODELS,
  type TrustedRouterModel,
} from "../../registry/trustedrouter-models.js";
import type { AgenCConfig } from "../../../config/schema.js";

const TRUSTEDROUTER_DEFAULT_REFERER = "https://agenc.tech";
const TRUSTEDROUTER_DEFAULT_TITLE = "AgenC";

function buildTrustedRouterHeaders(
  headers: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> {
  return {
    "HTTP-Referer": TRUSTEDROUTER_DEFAULT_REFERER,
    "X-Title": TRUSTEDROUTER_DEFAULT_TITLE,
    ...(headers ?? {}),
  };
}

/**
 * TrustedRouter over streaming OpenAI-compatible Chat Completions.
 * Discovers live models, presets (`trustedrouter/*`), and `nyte/*` aliases
 * from `GET /v1/models` before admission so limits, capabilities, and prices
 * reflect the live catalog.
 */
export class TrustedRouterProvider extends OpenAIProvider {
  readonly #model: string;
  readonly #metadata: ModelMetadataResolver;
  readonly #catalogConfig: AgenCConfig;
  #models: readonly TrustedRouterModel[] = TRUSTEDROUTER_MODELS;

  constructor(config: OpenAIProviderConfig) {
    const rawFetch = config.fetchImpl ?? fetch;
    const fetchImpl = trustedRouterFetch(rawFetch, config.apiKey);
    super({
      ...config,
      fetchImpl,
      providerName: "trustedrouter",
      useResponsesApi: false,
      defaultHeaders: buildTrustedRouterHeaders(config.defaultHeaders),
    });
    this.#model = config.model;
    this.#catalogConfig = {
      providers: { trustedrouter: { base_url: config.baseURL } },
    };
    this.#metadata = new ModelMetadataResolver({
      fetchImpl,
      env: { TRUSTEDROUTER_API_KEY: config.apiKey },
      endpointCatalogs: endpointMetadataForTransport(rawFetch),
    });
  }

  async #refresh(): Promise<readonly TrustedRouterModel[] | undefined> {
    const discovered = await this.#metadata.discoverTrustedRouterModels(
      this.#catalogConfig,
    );
    this.#models = discovered ?? TRUSTEDROUTER_MODELS;
    return discovered;
  }

  async #discover(model: string): Promise<void> {
    const discovered = await this.#refresh();
    // Selection accepts any TrustedRouter ID (its catalog is this live list),
    // so a mistyped or non-chat ID stops here, before any request.
    if (discovered && !discovered.some((entry) => entry.model === model)) {
      throw new LLMCapabilityError(
        "trustedrouter",
        "request_features",
        `${model} is not an available TrustedRouter chat model.`,
      );
    }
  }

  /**
   * Admission reserves before the request: read TrustedRouter's list first, so
   * the reservation uses this model's published price. Reject an unlisted model
   * from that same discovery before generation is admitted.
   */
  override async getExecutionProfile(options?: LLMChatOptions) {
    await this.#discover(options?.model?.trim() || this.#model);
    return super.getExecutionProfile(options);
  }

  override async chat(messages: LLMMessage[], options?: LLMChatOptions) {
    await this.#discover(options?.model?.trim() || this.#model);
    return super.chat(messages, options);
  }

  override async chatStream(
    messages: LLMMessage[],
    onChunk: StreamProgressCallback,
    options?: LLMChatOptions,
  ) {
    await this.#discover(options?.model?.trim() || this.#model);
    return super.chatStream(messages, onChunk, options);
  }

  protected override chatCapabilityHints(model: string) {
    const entry = this.#models.find((candidate) => candidate.model === model);
    return {
      ...super.chatCapabilityHints(model),
      acceptsReasoningEffort: (entry?.supportedReasoningLevels.length ?? 0) > 0,
      reasoningEffortAllowedValues: new Set(entry?.supportedReasoningLevels ?? []),
      acceptsDirectImageInput: entry?.supportsVision === true,
      toolResultImagePolicy: entry?.supportsVision
        ? ("relay_as_user" as const)
        : ("strip" as const),
    };
  }
}
