import {
  resolveProviderSlug,
} from "../config/resolve-provider.js";
import type { AgenCConfig } from "../config/schema.js";
import {
  ModelRegistry,
  modelRegistryEntryToModelInfo,
  type ModelMetadataResolverOptions,
} from "./model-registry.js";
import { rememberSuccessfulLookup } from "./remember-successful-lookup.js";
import { resolveModelCatalogMetadata } from "./registry/model-catalog.js";
import type { ModelsManager } from "../session/session.js";
import type { ModelInfo } from "../session/turn-context.js";

export class StaticModelsManager implements ModelsManager {
  private readonly fallbackProvider?: string;
  private readonly configDefaultProvider?: string;
  private availableModels: readonly ModelInfo[] | undefined;
  private readonly modelRegistry: ModelRegistry;
  private metadataRevision = 0;
  private inFlightModelInfo = new Map<string, Promise<ModelInfo>>();
  private modelInfoCache = new Map<string, ModelInfo>();
  private catalogRefreshes = new Set<string>();

  constructor(params: {
    readonly config: AgenCConfig;
    readonly fallbackProvider?: string;
    readonly metadata?: ModelMetadataResolverOptions;
  }) {
    this.fallbackProvider = resolveProviderSlug(params.fallbackProvider);
    this.configDefaultProvider = resolveProviderSlug(
      params.config.model_provider,
    );
    this.modelRegistry = new ModelRegistry({
      config: params.config,
      metadata: params.metadata,
    });
  }

  modelCostRegistry() {
    return this.modelRegistry.modelCostRegistry();
  }

  async getProviderDefaultModel(provider: string): Promise<string | undefined> {
    const model = await this.modelRegistry.defaultModelForProvider(provider);
    this.availableModels = undefined;
    return model;
  }

  async getModelInfo(modelSlug: string): Promise<ModelInfo> {
    const trimmed = modelSlug.trim();
    const fallbackProvider =
      trimmed.length === 0
        ? this.fallbackProvider ?? "grok"
        : this.fallbackProvider ?? this.configDefaultProvider ?? "grok";
    return await this.resolveModelInfo(
      this.modelRegistry.resolveSelection(trimmed, fallbackProvider),
    );
  }

  async getModelInfoForProvider(provider: string, model: string): Promise<ModelInfo> {
    return await this.resolveModelInfo({ provider, model });
  }

  /** Read completed discovery without starting or waiting for a lookup. */
  tryGetModelInfoForProvider(provider: string, model: string): ModelInfo | undefined {
    if (this.modelRegistry.metadataRevision({ provider, model }) !== this.metadataRevision) {
      return undefined;
    }
    return this.modelInfoCache.get(`${provider}:${model}`);
  }

  tryListModels(): ReadonlyArray<ModelInfo> | undefined {
    return this.pickerModels();
  }

  async listModels(): Promise<ReadonlyArray<ModelInfo>> {
    const provider = this.fallbackProvider ?? this.configDefaultProvider;
    if (provider !== "venice") return this.pickerModels();
    const entries = await this.modelRegistry.listEntries(provider);
    return this.availableModels = entries.map(modelRegistryEntryToModelInfo)
      .filter(model => model.showInPicker !== false && model.visibility !== "hide" && model.visibility !== "none");
  }

  /** A new session needs one selected model, not every picker entry. */
  private pickerModels(): readonly ModelInfo[] {
    return this.availableModels ??= this.modelRegistry.listEntriesSync()
      .map((entry) => modelRegistryEntryToModelInfo(entry))
      .filter((model) => model.showInPicker !== false && model.visibility !== "hide" && model.visibility !== "none");
  }

  private async resolveModelInfo(params: {
    readonly provider: string;
    readonly model: string;
  }): Promise<ModelInfo> {
    const revision = this.modelRegistry.metadataRevision(params);
    if (revision !== this.metadataRevision) {
      this.inFlightModelInfo = new Map();
      this.modelInfoCache = new Map();
      this.catalogRefreshes = new Set();
      this.availableModels = undefined;
      this.metadataRevision = revision;
    }
    const key = `${params.provider}:${params.model}`;
    if (
      params.provider === "deepseek" &&
      resolveModelCatalogMetadata(params) !== undefined &&
      !this.modelInfoCache.has(key)
    ) {
      // A proxy URL does not make a catalogued DeepSeek model unknown. Start
      // the turn with its registered limits; discovery can update later turns.
      // Explicit configured limits still go through the usual resolver below.
      const entry = this.modelRegistry.resolveSync(params);
      if (entry.metadata.source === "built_in_heuristic") {
        const cache = this.modelInfoCache;
        const pending = this.catalogRefreshes;
        if (!pending.has(key)) {
          pending.add(key);
          void this.buildResolvedModelInfo(params).then((info) => {
            if (cache === this.modelInfoCache && !info.usedFallbackModelMetadata) {
              cache.set(key, info);
            }
          }, () => {
            // Discovery is best effort. Keep the static catalog available if
            // the endpoint fails or its authority changes during the refresh.
          }).finally(() => pending.delete(key));
        }
        return modelRegistryEntryToModelInfo(entry);
      }
    }
    return await rememberSuccessfulLookup(
      { inFlight: this.inFlightModelInfo, success: this.modelInfoCache },
      key,
      () => this.buildResolvedModelInfo(params),
      (info) => !info.usedFallbackModelMetadata,
    );
  }

  private async buildResolvedModelInfo(params: {
    readonly provider: string;
    readonly model: string;
  }): Promise<ModelInfo> {
    const entry = await this.modelRegistry.resolve(params);
    if (params.provider === "venice") this.availableModels = undefined;
    return modelRegistryEntryToModelInfo(entry);
  }
}
