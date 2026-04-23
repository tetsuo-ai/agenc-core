import {
  buildProviderModelCatalog,
  normalizeProviderSlug,
  readProviderConfig,
  resolveDisambiguatedModelSelection,
  type AgenCConfig,
} from "../config/index.js";
import {
  resolveProviderCapabilityEntry,
  type ProviderCapabilityRegistryEntry,
} from "./capabilities.js";
import type { ModelsManager } from "../session/session.js";
import type { ModelInfo, ReasoningEffort } from "../session/turn-context.js";

const DEFAULT_EFFECTIVE_CONTEXT_WINDOW_PERCENT = 95;

function inferContextWindow(
  provider: string,
  model: string,
): number | undefined {
  const normalizedProvider = normalizeProviderSlug(provider);
  const normalizedModel = model.trim().toLowerCase();
  switch (normalizedProvider) {
    case "grok":
      return 256_000;
    case "openai":
      return /(?:^|[/:])(gpt-5|o3|o4|o1)(?:$|[-_.:])/.test(normalizedModel)
        ? 1_000_000
        : 128_000;
    case "anthropic":
      return 200_000;
    case "openrouter":
      return /(?:gpt-5|o3|o4|o1|gemini-2\.5)/.test(normalizedModel)
        ? 1_000_000
        : 200_000;
    case "groq":
    case "deepseek":
      return 128_000;
    case "gemini":
      return 1_000_000;
    default:
      return undefined;
  }
}

function inferMaxOutputTokens(
  provider: string,
  model: string,
): number | undefined {
  const normalizedProvider = normalizeProviderSlug(provider);
  const normalizedModel = model.trim().toLowerCase();
  if (normalizedProvider === "openai" && /(?:^|[/:])gpt-5(?:$|[-_.:])/.test(normalizedModel)) {
    return 128_000;
  }
  if (normalizedProvider === "grok") {
    return 32_768;
  }
  return undefined;
}

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
  readonly usedFallbackModelMetadata: boolean;
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
    ...(inferContextWindow(params.provider, params.model) !== undefined
      ? { contextWindow: inferContextWindow(params.provider, params.model) }
      : {}),
    ...(inferMaxOutputTokens(params.provider, params.model) !== undefined
      ? { maxOutputTokens: inferMaxOutputTokens(params.provider, params.model) }
      : {}),
    effectiveContextWindowPercent:
      params.usedFallbackModelMetadata
        ? 100
        : DEFAULT_EFFECTIVE_CONTEXT_WINDOW_PERCENT,
    supportedReasoningLevels,
    ...(supportedReasoningLevels.length > 0
      ? { defaultReasoningLevel: "medium" as const }
      : {}),
    defaultReasoningSummary: "auto",
    truncationPolicy: "off",
    usedFallbackModelMetadata: params.usedFallbackModelMetadata,
  };
}

export class StaticModelsManager implements ModelsManager {
  private readonly catalog: Readonly<Record<string, readonly string[]>>;
  private readonly config: AgenCConfig;
  private readonly fallbackProvider?: string;
  private readonly availableModels: readonly ModelInfo[];

  constructor(params: {
    readonly config: AgenCConfig;
    readonly fallbackProvider?: string;
  }) {
    this.config = params.config;
    this.fallbackProvider = normalizeProviderSlug(params.fallbackProvider);
    this.catalog = buildProviderModelCatalog(params.config);
    this.availableModels = Object.freeze(
      Object.entries(this.catalog).flatMap(([provider, models]) =>
        models.map((model) =>
          buildModelInfo({
            provider,
            model,
            config: this.config,
            usedFallbackModelMetadata: false,
          }),
        ),
      ),
    );
  }

  async getModelInfo(modelSlug: string): Promise<ModelInfo> {
    const trimmed = modelSlug.trim();
    if (trimmed.length === 0) {
      return buildModelInfo({
        provider: this.fallbackProvider ?? "grok",
        model: "unknown-model",
        config: this.config,
        usedFallbackModelMetadata: true,
      });
    }

    const explicitSeparator = trimmed.indexOf(":");
    if (explicitSeparator > 0) {
      const provider = trimmed.slice(0, explicitSeparator);
      const model = trimmed.slice(explicitSeparator + 1);
      return buildModelInfo({
        provider,
        model,
        config: this.config,
        usedFallbackModelMetadata: false,
      });
    }

    try {
      const resolved = resolveDisambiguatedModelSelection({
        slug: trimmed,
        config: this.config,
        catalog: this.catalog,
      });
      return buildModelInfo({
        provider: resolved.provider,
        model: resolved.model,
        config: this.config,
        usedFallbackModelMetadata: false,
      });
    } catch {
      return buildModelInfo({
        provider:
          this.fallbackProvider ??
          normalizeProviderSlug(this.config.model_provider) ??
          "grok",
        model: trimmed,
        config: this.config,
        usedFallbackModelMetadata: true,
      });
    }
  }

  tryListModels(): ReadonlyArray<ModelInfo> | undefined {
    return this.availableModels;
  }

  async listModels(): Promise<ReadonlyArray<ModelInfo>> {
    return this.availableModels;
  }
}
