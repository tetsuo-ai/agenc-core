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
import type { ModelsManager } from "../session/session.js";
import type { ModelInfo } from "../session/turn-context.js";

export class StaticModelsManager implements ModelsManager {
  private readonly fallbackProvider?: string;
  private readonly configDefaultProvider?: string;
  private availableModels: readonly ModelInfo[] | undefined;
  private readonly modelRegistry: ModelRegistry;
  private readonly inFlightModelInfo = new Map<string, Promise<ModelInfo>>();
  private readonly modelInfoCache = new Map<string, ModelInfo>();

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

  tryListModels(): ReadonlyArray<ModelInfo> | undefined {
    return this.pickerModels();
  }

  async listModels(): Promise<ReadonlyArray<ModelInfo>> {
    return this.pickerModels();
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
    const key = `${params.provider}:${params.model}`;
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
    return modelRegistryEntryToModelInfo(
      await this.modelRegistry.resolve(params),
    );
  }
}
