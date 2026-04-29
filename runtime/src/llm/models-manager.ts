import {
  buildProviderModelCatalog,
  normalizeProviderSlug,
  readProviderConfig,
  resolveDisambiguatedModelSelection,
  type AgenCConfig,
} from "./_deps/config.js";
import {
  resolveProviderCapabilityEntry,
  type ProviderCapabilityRegistryEntry,
} from "./capabilities.js";
import {
  ModelMetadataResolver,
  type ModelMetadataResolverOptions,
  type ResolvedModelMetadata,
} from "./model-metadata.js";
import type { ModelsManager } from "../session/session.js";
import type { ModelInfo, ReasoningEffort } from "../session/turn-context.js";

const DEFAULT_EFFECTIVE_CONTEXT_WINDOW_PERCENT = 95;

function inferReasoningLevels(
  caps: ProviderCapabilityRegistryEntry,
): readonly ReasoningEffort[] {
  return caps.acceptsReasoningEffort
    ? (["low", "medium", "high"] as const)
    : [];
}

function buildModelInfo(params: {
  readonly provider: string;
  readonly model: string;
  readonly config: AgenCConfig;
  readonly metadata: ResolvedModelMetadata;
}): ModelInfo {
  const overrides = readProviderConfig(params.config, params.provider)
    ?.capability_overrides;
  const caps = resolveProviderCapabilityEntry({
    provider: params.provider,
    model: params.model,
    overrides,
  });
  const supportedReasoningLevels = inferReasoningLevels(caps);
  return {
    slug: params.model,
    ...(params.metadata.contextWindow !== undefined
      ? { contextWindow: params.metadata.contextWindow }
      : {}),
    ...(params.metadata.maxOutputTokens !== undefined
      ? { maxOutputTokens: params.metadata.maxOutputTokens }
      : {}),
    ...(params.metadata.maxOutputTokensUpperLimit !== undefined
      ? { maxOutputTokensUpperLimit: params.metadata.maxOutputTokensUpperLimit }
      : {}),
    ...(params.metadata.maxOutputTokensExplicit !== undefined
      ? { maxOutputTokensExplicit: params.metadata.maxOutputTokensExplicit }
      : {}),
    ...(params.metadata.maxOutputTokensCappedDefault !== undefined
      ? {
        maxOutputTokensCappedDefault:
          params.metadata.maxOutputTokensCappedDefault,
      }
      : {}),
    effectiveContextWindowPercent:
      params.metadata.usedFallbackModelMetadata
        ? 100
        : DEFAULT_EFFECTIVE_CONTEXT_WINDOW_PERCENT,
    supportedReasoningLevels,
    ...(supportedReasoningLevels.length > 0
      ? { defaultReasoningLevel: "medium" as const }
      : {}),
    defaultReasoningSummary: "auto",
    truncationPolicy: "off",
    usedFallbackModelMetadata: params.metadata.usedFallbackModelMetadata,
  };
}

export class StaticModelsManager implements ModelsManager {
  private readonly catalog: Readonly<Record<string, readonly string[]>>;
  private readonly config: AgenCConfig;
  private readonly fallbackProvider?: string;
  private readonly availableModels: readonly ModelInfo[];
  private readonly metadataResolver: ModelMetadataResolver;
  private readonly modelInfoCache = new Map<string, Promise<ModelInfo>>();

  constructor(params: {
    readonly config: AgenCConfig;
    readonly fallbackProvider?: string;
    readonly metadata?: ModelMetadataResolverOptions;
  }) {
    this.config = params.config;
    this.fallbackProvider = normalizeProviderSlug(params.fallbackProvider);
    this.catalog = buildProviderModelCatalog(params.config);
    this.metadataResolver = new ModelMetadataResolver(params.metadata);
    this.availableModels = Object.freeze(
      Object.entries(this.catalog).flatMap(([provider, models]) =>
        models.map((model) =>
          buildModelInfo({
            provider,
            model,
            config: this.config,
            metadata: this.metadataResolver.resolveSync({
              provider,
              model,
              config: this.config,
            }),
          }),
        ),
      ),
    );
  }

  async getModelInfo(modelSlug: string): Promise<ModelInfo> {
    const trimmed = modelSlug.trim();
    if (trimmed.length === 0) {
      return await this.resolveModelInfo({
        provider: this.fallbackProvider ?? "grok",
        model: "unknown-model",
      });
    }

    const explicitSeparator = trimmed.indexOf(":");
    if (explicitSeparator > 0) {
      const provider = trimmed.slice(0, explicitSeparator);
      const model = trimmed.slice(explicitSeparator + 1);
      return await this.resolveModelInfo({
        provider,
        model,
      });
    }

    try {
      const resolved = resolveDisambiguatedModelSelection({
        slug: trimmed,
        config: this.config,
        catalog: this.catalog,
      });
      return await this.resolveModelInfo({
        provider: resolved.provider,
        model: resolved.model,
      });
    } catch {
      return await this.resolveModelInfo({
        provider:
          this.fallbackProvider ??
          normalizeProviderSlug(this.config.model_provider) ??
          "grok",
        model: trimmed,
      });
    }
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
    return buildModelInfo({
      provider: params.provider,
      model: params.model,
      config: this.config,
      metadata: await this.metadataResolver.resolve({
        provider: params.provider,
        model: params.model,
        config: this.config,
      }),
    });
  }
}
