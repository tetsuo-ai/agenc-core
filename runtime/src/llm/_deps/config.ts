/**
 * Local _deps stub for the gut/AgenC crossing of `../config/index.js`.
 * Provides the minimal surface the LLM models-manager consumes:
 *   - AgenCConfig type (loose pass-through shape)
 *   - normalizeProviderSlug
 *   - readProviderConfig
 *   - buildProviderModelCatalog
 *   - resolveDisambiguatedModelSelection
 *
 * The full config tranche will replace this when it lands; here we keep
 * behaviour conservative and the type permissive (`any` payloads on the
 * deeper records, since this stub is not a parser).
 */

import {
  BUILT_IN_PROVIDER_DEFAULT_MODELS,
  BUILT_IN_PROVIDER_MODEL_CATALOG,
} from "../registry/provider-info.js";

export type ProviderSlug = keyof typeof BUILT_IN_PROVIDER_DEFAULT_MODELS;

export interface ProviderCapabilityOverrides {
  readonly supportsToolUse?: boolean;
  readonly supportsPromptCaching?: boolean;
  readonly supportsContextEdits?: boolean;
  readonly supportsImageInput?: boolean;
  readonly supportsAudioInput?: boolean;
  readonly supportsAudioOutput?: boolean;
  readonly supportsProviderNativeWebSearch?: boolean;
  readonly supportsExtendedThinking?: boolean;
  readonly acceptsImageHistory?: boolean;
  readonly acceptsAudioHistory?: boolean;
  readonly acceptsThinkingHistory?: boolean;
  readonly acceptsReasoningEffort?: boolean;
}

export interface ProviderConfig {
  readonly api_key_env?: string;
  readonly base_url?: string;
  readonly default_model?: string;
  readonly context_window_tokens?: number;
  readonly max_output_tokens?: number;
  readonly capability_overrides?: ProviderCapabilityOverrides;
}

export interface AgenCConfig {
  readonly model?: string;
  readonly model_provider?: string;
  readonly max_output_tokens?: number;
  readonly capped_default_max_output_tokens?: boolean;
  readonly providers?: Readonly<Record<string, ProviderConfig>>;
}

export interface ProviderModelPair {
  readonly provider: string;
  readonly model: string;
}

export class AmbiguousModelError extends Error {
  readonly candidates: readonly ProviderModelPair[];
  constructor(slug: string, candidates: readonly ProviderModelPair[]) {
    const recommended = candidates
      .map((c) => `${c.provider}:${c.model}`)
      .join(", ");
    super(
      `Model slug "${slug}" is ambiguous — matches ${candidates.length} providers. ` +
        `Recommend explicit provider:model form. Candidates: ${recommended}`,
    );
    this.name = "AmbiguousModelError";
    this.candidates = Object.freeze([...candidates]);
  }
}

export class UnknownModelError extends Error {
  readonly providers: readonly string[];
  constructor(slug: string, providers: readonly string[] = []) {
    const frozen = Object.freeze([...providers]);
    const providerList =
      frozen.length > 0 ? frozen.join(", ") : "(none configured)";
    super(
      `unknown model '${slug}'. Known providers: ${providerList}. ` +
        `Use provider:model form.`,
    );
    this.name = "UnknownModelError";
    this.providers = frozen;
  }
}

export function normalizeProviderSlug(
  provider: string | undefined,
): ProviderSlug | undefined {
  const normalized = provider?.trim().toLowerCase();
  if (!normalized) return undefined;
  const slug = normalized === "xai"
    ? "grok"
    : normalized === "custom" || normalized === "openai_compatible"
      ? "openai-compatible"
      : normalized;
  return slug in BUILT_IN_PROVIDER_DEFAULT_MODELS
    ? (slug as ProviderSlug)
    : undefined;
}

export function readProviderConfig(
  config: AgenCConfig,
  provider: string | undefined,
): ProviderConfig | undefined {
  const slug = normalizeProviderSlug(provider);
  if (!slug) return undefined;
  return config.providers?.[slug];
}

export function buildProviderModelCatalog(
  config?: AgenCConfig,
): Readonly<Record<string, readonly string[]>> {
  const catalog: Record<string, string[]> = Object.fromEntries(
    Object.entries(BUILT_IN_PROVIDER_MODEL_CATALOG).map(
      ([provider, models]) => [provider, [...models]],
    ),
  );

  if (config?.providers) {
    for (const [provider, providerConfig] of Object.entries(config.providers)) {
      const slug = normalizeProviderSlug(provider);
      const model = providerConfig.default_model?.trim();
      if (!slug || !model) continue;
      const entries = catalog[slug] ?? [];
      if (!entries.includes(model)) {
        entries.push(model);
      }
      catalog[slug] = entries;
    }
  }

  if (config?.model_provider && config.model?.trim()) {
    const slug = normalizeProviderSlug(config.model_provider);
    const model = config.model.trim();
    if (slug) {
      const entries = catalog[slug] ?? [];
      if (!entries.includes(model)) {
        entries.push(model);
      }
      catalog[slug] = entries;
    }
  }

  return Object.freeze(
    Object.fromEntries(
      Object.entries(catalog).map(([provider, models]) => [
        provider,
        Object.freeze([...models]),
      ]),
    ),
  );
}

function resolveModelDisambiguated(
  slug: string,
  providerCatalog: Readonly<Record<string, readonly string[]>>,
): ProviderModelPair {
  const providerIds = Object.keys(providerCatalog);
  const colonIdx = slug.indexOf(":");
  if (colonIdx > 0) {
    const provider = slug.slice(0, colonIdx);
    const model = slug.slice(colonIdx + 1);
    const providerModels = providerCatalog[provider];
    if (!providerModels) {
      throw new UnknownModelError(slug, providerIds);
    }
    if (!providerModels.includes(model)) {
      throw new UnknownModelError(slug, providerIds);
    }
    return Object.freeze({ provider, model });
  }

  const candidates: ProviderModelPair[] = [];
  for (const [provider, models] of Object.entries(providerCatalog)) {
    if (models.includes(slug)) {
      candidates.push({ provider, model: slug });
    }
  }

  if (candidates.length === 0) {
    throw new UnknownModelError(slug, providerIds);
  }
  if (candidates.length >= 2) {
    throw new AmbiguousModelError(slug, candidates);
  }
  return Object.freeze(candidates[0]!);
}

export function resolveDisambiguatedModelSelection(params: {
  readonly slug: string;
  readonly config?: AgenCConfig;
  readonly catalog?: Readonly<Record<string, readonly string[]>>;
}): ProviderModelPair {
  return resolveModelDisambiguated(
    params.slug,
    params.catalog ?? buildProviderModelCatalog(params.config),
  );
}
