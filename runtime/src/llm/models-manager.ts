import {
  normalizeProviderSlug,
  type AgenCConfig,
} from "./_deps/config.js";
import {
  ModelRegistry,
  modelRegistryEntryToModelInfo,
  type ModelMetadataResolverOptions,
} from "./model-registry.js";
import type { ModelsManager } from "../session/session.js";
import type { ModelInfo } from "../session/turn-context.js";

export class StaticModelsManager implements ModelsManager {
  private readonly fallbackProvider?: string;
  private readonly configDefaultProvider?: string;
  private readonly availableModels: readonly ModelInfo[];
  private readonly modelRegistry: ModelRegistry;
  private readonly modelInfoCache = new Map<string, Promise<ModelInfo>>();

  constructor(params: {
    readonly config: AgenCConfig;
    readonly fallbackProvider?: string;
    readonly metadata?: ModelMetadataResolverOptions;
  }) {
    this.fallbackProvider = normalizeProviderSlug(params.fallbackProvider);
    this.configDefaultProvider = normalizeProviderSlug(
      params.config.model_provider,
    );
    this.modelRegistry = new ModelRegistry({
      config: params.config,
      metadata: params.metadata,
    });
    this.availableModels = this.modelRegistry
      .listEntriesSync()
      .map((entry) => modelRegistryEntryToModelInfo(entry));
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

  tryListModels(): ReadonlyArray<ModelInfo> | undefined {
    return this.availableModels;
  }

  async listModels(): Promise<ReadonlyArray<ModelInfo>> {
    return this.availableModels;
  }

  private async resolveModelInfo(params: {
    readonly provider: string;
    readonly model: string;
  }): Promise<ModelInfo> {
    const key = `${params.provider}:${params.model}`;
    const cached = this.modelInfoCache.get(key);
    if (cached) return await cached;
    const resolved = this.buildResolvedModelInfo(params);
    this.modelInfoCache.set(key, resolved);
    return await resolved;
  }

  private async buildResolvedModelInfo(params: {
    readonly provider: string;
    readonly model: string;
  }): Promise<ModelInfo> {
    return modelRegistryEntryToModelInfo(
      await this.modelRegistry.resolve(params),
    );
  }
}
