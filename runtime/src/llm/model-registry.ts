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
import { resolveRegisteredModelCatalogEntry } from "./registry/model-catalog.js";
import { modelSupportsPersonality } from "../context/personality-spec-instructions.js";
import {
  DEFAULT_MODEL_COSTS,
  DEFAULT_UNKNOWN_MODEL_COST,
  resolveModelCostEntry,
  type ModelCostEntry,
} from "../session/cost.js";
import type { ModelInfo, ReasoningEffort } from "../session/turn-context.js";

const DEFAULT_EFFECTIVE_CONTEXT_WINDOW_PERCENT = 95;

export type { ModelMetadataResolverOptions } from "./model-metadata.js";

export interface ModelRegistryCostEntry {
  readonly entry: ModelCostEntry;
  readonly known: boolean;
  readonly matchedKey?: string;
}

export interface ModelRegistryEntry {
  readonly provider: string;
  readonly model: string;
  readonly metadata: ResolvedModelMetadata;
  readonly capabilities: ProviderCapabilityRegistryEntry;
  readonly cost: ModelRegistryCostEntry;
}

export interface ModelRegistryOptions {
  readonly config: AgenCConfig;
  readonly metadata?: ModelMetadataResolverOptions;
  readonly costRegistry?: Readonly<Record<string, ModelCostEntry>>;
}

function inferReasoningLevels(
  entry: ModelRegistryEntry,
): readonly ReasoningEffort[] {
  const catalog = resolveRegisteredModelCatalogEntry({
    provider: entry.provider,
    model: entry.model,
  });
  if (catalog?.supportedReasoningLevels.length) {
    return catalog.supportedReasoningLevels;
  }
  return entry.capabilities.acceptsReasoningEffort
    ? (["low", "medium", "high"] as const)
    : [];
}

function inferDefaultReasoningLevel(
  entry: ModelRegistryEntry,
  supportedReasoningLevels: readonly ReasoningEffort[],
): ReasoningEffort | undefined {
  const catalog = resolveRegisteredModelCatalogEntry({
    provider: entry.provider,
    model: entry.model,
  });
  if (
    catalog?.defaultReasoningLevel !== undefined &&
    supportedReasoningLevels.includes(catalog.defaultReasoningLevel)
  ) {
    return catalog.defaultReasoningLevel;
  }
  return supportedReasoningLevels.length > 0 ? "medium" : undefined;
}

function resolveCostEntry(params: {
  readonly provider: string;
  readonly model: string;
  readonly registry: Readonly<Record<string, ModelCostEntry>>;
}): ModelRegistryCostEntry {
  const match = resolveModelCostEntry(
    { provider: params.provider, model: params.model },
    params.registry,
  );
  return {
    entry: match?.entry ?? DEFAULT_UNKNOWN_MODEL_COST,
    known: match !== null,
    ...(match ? { matchedKey: match.key } : {}),
  };
}

function normalizeRegistryProvider(provider: string): string {
  return normalizeProviderSlug(provider) ?? provider.trim().toLowerCase();
}

function normalizeRegistrySelection(params: {
  readonly provider: string;
  readonly model: string;
}): { readonly provider: string; readonly model: string } {
  return {
    provider: normalizeRegistryProvider(params.provider),
    model: params.model.trim(),
  };
}

export function modelRegistryEntryToModelInfo(
  entry: ModelRegistryEntry,
): ModelInfo {
  const supportedReasoningLevels = inferReasoningLevels(entry);
  const defaultReasoningLevel = inferDefaultReasoningLevel(
    entry,
    supportedReasoningLevels,
  );
  const catalog = resolveRegisteredModelCatalogEntry({
    provider: entry.provider,
    model: entry.model,
  });
  const visibility = catalog?.visibility ?? "list";
  return {
    slug: entry.model,
    ...(entry.metadata.contextWindow !== undefined
      ? { contextWindow: entry.metadata.contextWindow }
      : {}),
    ...(entry.metadata.maxOutputTokens !== undefined
      ? { maxOutputTokens: entry.metadata.maxOutputTokens }
      : {}),
    ...(entry.metadata.maxOutputTokensUpperLimit !== undefined
      ? { maxOutputTokensUpperLimit: entry.metadata.maxOutputTokensUpperLimit }
      : {}),
    ...(entry.metadata.maxOutputTokensExplicit !== undefined
      ? { maxOutputTokensExplicit: entry.metadata.maxOutputTokensExplicit }
      : {}),
    ...(entry.metadata.maxOutputTokensCappedDefault !== undefined
      ? {
        maxOutputTokensCappedDefault:
          entry.metadata.maxOutputTokensCappedDefault,
      }
      : {}),
    effectiveContextWindowPercent:
      entry.metadata.usedFallbackModelMetadata
        ? 100
        : DEFAULT_EFFECTIVE_CONTEXT_WINDOW_PERCENT,
    supportedReasoningLevels,
    ...(defaultReasoningLevel !== undefined ? { defaultReasoningLevel } : {}),
    defaultReasoningSummary: catalog?.defaultReasoningSummary ?? "auto",
    truncationPolicy: "off",
    supportsToolUse: entry.capabilities.supportsToolUse,
    supportsParallelToolCalls: catalog?.supportsParallelToolCalls ?? false,
    ...(catalog?.modelMessages !== undefined
      ? { modelMessages: catalog.modelMessages }
      : {}),
    supportsPersonality: modelSupportsPersonality(catalog?.modelMessages),
    visibility,
    showInPicker: visibility === "list",
    usedFallbackModelMetadata: entry.metadata.usedFallbackModelMetadata,
  };
}

export class ModelRegistry {
  private readonly config: AgenCConfig;
  private readonly metadataResolver: ModelMetadataResolver;
  private readonly costRegistry: Readonly<Record<string, ModelCostEntry>>;
  private readonly catalog: Readonly<Record<string, readonly string[]>>;

  constructor(options: ModelRegistryOptions) {
    this.config = options.config;
    this.metadataResolver = new ModelMetadataResolver(options.metadata);
    this.costRegistry = options.costRegistry ?? DEFAULT_MODEL_COSTS;
    this.catalog = buildProviderModelCatalog(options.config);
  }

  listEntriesSync(): readonly ModelRegistryEntry[] {
    return Object.freeze(
      Object.entries(this.catalog).flatMap(([provider, models]) =>
        models.map((model) => this.resolveSync({ provider, model })),
      ),
    );
  }

  resolveSelection(modelSlug: string, fallbackProvider: string): {
    readonly provider: string;
    readonly model: string;
  } {
    const trimmed = modelSlug.trim();
    if (trimmed.length === 0) {
      return normalizeRegistrySelection({
        provider: fallbackProvider,
        model: "unknown-model",
      });
    }

    const explicitSeparator = trimmed.indexOf(":");
    if (explicitSeparator > 0) {
      const explicitProvider = trimmed.slice(0, explicitSeparator);
      if (normalizeProviderSlug(explicitProvider) !== undefined) {
        return normalizeRegistrySelection({
          provider: explicitProvider,
          model: trimmed.slice(explicitSeparator + 1),
        });
      }
    }

    try {
      return normalizeRegistrySelection(resolveDisambiguatedModelSelection({
        slug: trimmed,
        config: this.config,
        catalog: this.catalog,
      }));
    } catch {
      return normalizeRegistrySelection({ provider: fallbackProvider, model: trimmed });
    }
  }

  resolveSync(params: {
    readonly provider: string;
    readonly model: string;
  }): ModelRegistryEntry {
    const selection = normalizeRegistrySelection(params);
    return this.buildEntry({
      ...selection,
      metadata: this.metadataResolver.resolveSync({
        provider: selection.provider,
        model: selection.model,
        config: this.config,
      }),
    });
  }

  async resolve(params: {
    readonly provider: string;
    readonly model: string;
  }): Promise<ModelRegistryEntry> {
    const selection = normalizeRegistrySelection(params);
    return this.buildEntry({
      ...selection,
      metadata: await this.metadataResolver.resolve({
        provider: selection.provider,
        model: selection.model,
        config: this.config,
      }),
    });
  }

  private buildEntry(params: {
    readonly provider: string;
    readonly model: string;
    readonly metadata: ResolvedModelMetadata;
  }): ModelRegistryEntry {
    const overrides = readProviderConfig(this.config, params.provider)
      ?.capability_overrides;
    return {
      provider: params.provider,
      model: params.model,
      metadata: params.metadata,
      capabilities: resolveProviderCapabilityEntry({
        provider: params.provider,
        model: params.model,
        overrides,
      }),
      cost: resolveCostEntry({
        provider: params.provider,
        model: params.model,
        registry: this.costRegistry,
      }),
    };
  }
}
