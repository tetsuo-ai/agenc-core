import {
  BUILT_IN_PROVIDER_DEFAULT_MODELS,
  BUILT_IN_PROVIDER_MODEL_CATALOG,
  providerCatalogModelId,
  providerLocalModelIdFromCatalog,
  resolveBuiltInProviderSlug,
  type BuiltInProviderSlug,
} from "../llm/registry/provider-info.js";
import type { AgenCConfig, ProviderModelPair } from "./schema.js";
import {
  AmbiguousModelError,
  mergeConfigs,
  resolveModelDisambiguated,
  UnknownModelError,
} from "./schema.js";
import { resolveProviderModelAlias } from "../utils/model/configs.js";

export type ProviderSlug = BuiltInProviderSlug;

export interface ProviderModelCatalogOptions {
  /** Include the selected top-level pair in model-list projections. */
  readonly includeConfiguredSelection?: boolean;
}

export class UnknownProviderError extends Error {
  readonly provider: string;
  readonly expectedProviders: readonly ProviderSlug[];

  constructor(
    provider: string,
    expectedProviders: readonly ProviderSlug[] = Object.keys(
      BUILT_IN_PROVIDER_DEFAULT_MODELS,
    ) as ProviderSlug[],
  ) {
    const expected = Object.freeze([...expectedProviders]);
    super(
      `unknown provider '${provider}'. Expected one of: ${expected.join(", ")}`,
    );
    this.name = "UnknownProviderError";
    this.provider = provider;
    this.expectedProviders = expected;
  }
}

export function buildProviderModelCatalog(
  config?: AgenCConfig,
  options: ProviderModelCatalogOptions = {},
): Readonly<Record<string, readonly string[]>> {
  const catalog: Record<string, string[]> = Object.fromEntries(
    Object.entries(BUILT_IN_PROVIDER_MODEL_CATALOG).map(([provider, models]) => [
      provider,
      [...models],
    ]),
  );

  if (config?.providers) {
    for (const [provider, providerConfig] of Object.entries(config.providers)) {
      const slug = resolveBuiltInProviderSlug(provider);
      const configuredModel = providerConfig.default_model?.trim();
      if (!slug || !configuredModel) continue;
      const model = providerCatalogModelId(slug, configuredModel);
      const entries = catalog[slug] ?? [];
      if (!entries.includes(model)) entries.push(model);
      catalog[slug] = entries;
    }
  }

  if (
    options.includeConfiguredSelection === true &&
    config?.model_provider &&
    config.model?.trim()
  ) {
    const slug = resolveBuiltInProviderSlug(config.model_provider);
    if (slug !== undefined) {
      const model = providerCatalogModelId(slug, config.model.trim());
      const entries = catalog[slug] ?? [];
      if (!entries.includes(model)) entries.push(model);
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

export function resolveProviderSlugOrThrow(raw: string): ProviderSlug {
  const provider = resolveBuiltInProviderSlug(raw);
  if (provider !== undefined) return provider;
  throw new UnknownProviderError(raw);
}

function selectionConflict(
  provider: ProviderSlug,
  model: string,
  modelProvider: string,
): Error {
  return new Error(
    `model '${model}' belongs to provider '${modelProvider}', not explicitly selected provider '${provider}'`,
  );
}

function explicitQualification(model: string):
  | { readonly provider: ProviderSlug; readonly model: string }
  | undefined {
  const separator = model.indexOf(":");
  if (separator <= 0) return undefined;
  const provider = resolveBuiltInProviderSlug(model.slice(0, separator));
  if (provider === undefined) return undefined;
  const qualifiedModel = model.slice(separator + 1).trim();
  if (qualifiedModel.length === 0) {
    throw new Error("provider-qualified model values must include a model");
  }
  return Object.freeze({
    provider,
    model: qualifiedModel,
  });
}

function requireSelectionValue(
  value: string | undefined,
  field: "provider" | "model",
): string {
  const normalized = value?.trim();
  if (normalized) return normalized;
  throw new Error(`${field} selection values must be non-empty`);
}

function catalogQualifiedModel(
  model: string,
  catalog: Readonly<Record<string, readonly string[]>>,
): ProviderModelPair | undefined {
  const qualification = explicitQualification(model);
  if (qualification === undefined) return undefined;
  return (
    providerCatalogPair(qualification.provider, model, catalog) ??
    providerCatalogPair(
      qualification.provider,
      qualification.model,
      catalog,
    )
  );
}

function providerCatalogPair(
  provider: ProviderSlug,
  model: string,
  catalog: Readonly<Record<string, readonly string[]>>,
): ProviderModelPair | undefined {
  const localInput = providerLocalModelIdFromCatalog(provider, model);
  const entry = catalog[provider]?.find(
    (candidate) =>
      candidate === model ||
      providerLocalModelIdFromCatalog(provider, candidate) === localInput,
  );
  if (entry === undefined) return undefined;
  return Object.freeze({
    provider,
    model: providerLocalModelIdFromCatalog(provider, entry),
  });
}

function resolveExplicitPair(
  provider: ProviderSlug,
  model: string,
  catalog: Readonly<Record<string, readonly string[]>>,
  config: AgenCConfig,
): ProviderModelPair {
  if (model === "agenc") {
    if (provider !== "agenc") {
      throw selectionConflict(provider, model, "agenc");
    }
    return Object.freeze({ provider: "agenc", model: "agenc" });
  }
  const providerCatalog = providerCatalogPair(provider, model, catalog);
  if (providerCatalog !== undefined) return providerCatalog;
  const providerLocalModel = providerLocalModelIdFromCatalog(provider, model);
  if (providerLocalModel !== model) {
    return Object.freeze({ provider, model: providerLocalModel });
  }
  const catalogQualified = catalogQualifiedModel(model, catalog);
  if (catalogQualified !== undefined) {
    if (catalogQualified.provider !== provider) {
      throw selectionConflict(provider, model, catalogQualified.provider);
    }
    return catalogQualified;
  }
  const qualification = explicitQualification(model);
  if (qualification !== undefined) {
    if (qualification.provider !== provider) {
      throw selectionConflict(provider, model, qualification.provider);
    }
    return resolveExplicitPair(
      provider,
      qualification.model,
      catalog,
      config,
    );
  }
  const projectedModel = resolveProviderModelAlias(
    provider,
    model,
    config.modelOverrides,
  );
  if (projectedModel !== model) {
    return (
      providerCatalogPair(provider, projectedModel, catalog) ??
      Object.freeze({ provider, model: projectedModel })
    );
  }

  try {
    const resolved = resolveModelDisambiguated(projectedModel, catalog);
    if (resolved.provider !== provider) {
      throw selectionConflict(provider, projectedModel, resolved.provider);
    }
    return resolved;
  } catch (error) {
    if (error instanceof AmbiguousModelError) {
      const selected = error.candidates.find(
        (candidate) => candidate.provider === provider,
      );
      if (selected !== undefined) return Object.freeze({ ...selected });
    }
    if (error instanceof UnknownModelError) {
      return Object.freeze({ provider, model: projectedModel });
    }
    throw error;
  }
}

/**
 * Resolve a model lookup against one known runtime provider. Provider-local
 * entries win. A uniquely owned foreign model selects its owner, while an
 * unknown model stays on the runtime provider.
 */
export function resolveProviderModelInput(
  config: AgenCConfig,
  fallbackProviderInput: string,
  modelInput: string,
): ProviderModelPair {
  const fallbackProvider = resolveProviderSlugOrThrow(fallbackProviderInput);
  const model = requireSelectionValue(modelInput, "model");
  const catalog = buildProviderModelCatalog(config, {
    includeConfiguredSelection: true,
  });
  const qualification = explicitQualification(model);
  if (qualification !== undefined) {
    return resolveExplicitPair(
      qualification.provider,
      model,
      catalog,
      config,
    );
  }

  const providerPair = providerCatalogPair(
    fallbackProvider,
    model,
    catalog,
  );
  if (providerPair !== undefined) return providerPair;

  const projectedModel = resolveProviderModelAlias(
    fallbackProvider,
    model,
    config.modelOverrides,
  );
  if (projectedModel !== model) {
    return resolveExplicitPair(
      fallbackProvider,
      projectedModel,
      catalog,
      config,
    );
  }

  try {
    const resolved = resolveModelDisambiguated(model, catalog);
    const provider = resolveProviderSlugOrThrow(resolved.provider);
    return Object.freeze({
      provider,
      model: providerLocalModelIdFromCatalog(provider, resolved.model),
    });
  } catch (error) {
    if (error instanceof AmbiguousModelError) {
      const selected = error.candidates.find(
        (candidate) => candidate.provider === fallbackProvider,
      );
      if (selected !== undefined) {
        return Object.freeze({
          provider: fallbackProvider,
          model: providerLocalModelIdFromCatalog(
            fallbackProvider,
            selected.model,
          ),
        });
      }
    }
    if (!(error instanceof UnknownModelError)) throw error;
  }

  return resolveExplicitPair(
    fallbackProvider,
    model,
    catalog,
    config,
  );
}

/**
 * Couple provider/model intent at one configuration-layer boundary.
 *
 * A provider-only layer selects that provider's configured or built-in
 * default. A model-only layer resolves its provider from the catalog. A layer
 * specifying both may use an uncatalogued model, but cannot bind a known model
 * to the wrong provider. The catalog deliberately excludes the merged
 * top-level pair so a lower-layer provider cannot claim a higher-layer model.
 */
export function resolveProviderModelLayer(
  base: AgenCConfig,
  layer: AgenCConfig,
): AgenCConfig {
  const hasProvider = Object.prototype.hasOwnProperty.call(
    layer,
    "model_provider",
  );
  const hasModel = Object.prototype.hasOwnProperty.call(layer, "model");
  if (!hasProvider && !hasModel) return layer;

  const combined = mergeConfigs(base, layer);
  const catalog = buildProviderModelCatalog(combined);
  let selection: ProviderModelPair;

  if (hasProvider) {
    const providerInput = requireSelectionValue(
      layer.model_provider,
      "provider",
    );
    const provider = resolveProviderSlugOrThrow(providerInput);
    if (hasModel) {
      const modelInput = requireSelectionValue(layer.model, "model");
      selection = resolveExplicitPair(provider, modelInput, catalog, combined);
    } else {
      const configuredProvider = resolveBuiltInProviderSlug(
        base.model_provider ?? "",
      );
      const configuredModel =
        configuredProvider === provider ? base.model?.trim() : undefined;
      const defaultModel =
        configuredModel ||
        combined.providers?.[provider]?.default_model?.trim() ||
        BUILT_IN_PROVIDER_DEFAULT_MODELS[provider];
      selection = resolveExplicitPair(provider, defaultModel, catalog, combined);
    }
  } else if (hasModel) {
    const modelInput = requireSelectionValue(layer.model, "model");
    if (modelInput === "agenc") {
      selection = Object.freeze({ provider: "agenc", model: "agenc" });
    } else {
      const catalogQualified = catalogQualifiedModel(modelInput, catalog);
      if (catalogQualified !== undefined) {
        selection = catalogQualified;
      } else {
        try {
          selection = resolveModelDisambiguated(modelInput, catalog);
        } catch (error) {
          if (!(error instanceof UnknownModelError)) throw error;
          const qualification = explicitQualification(modelInput);
          if (qualification === undefined) {
            const inheritedProvider =
              base.model_provider?.trim() ??
              combined.model_provider?.trim();
            if (!inheritedProvider) return layer;
            const provider = resolveProviderSlugOrThrow(inheritedProvider);
            selection = resolveExplicitPair(
              provider,
              modelInput,
              catalog,
              combined,
            );
          } else {
            selection = resolveExplicitPair(
              qualification.provider,
              modelInput,
              catalog,
              combined,
            );
          }
        }
      }
    }
  } else {
    return layer;
  }

  return Object.freeze({
    ...layer,
    model_provider: selection.provider,
    model: selection.model,
  });
}

/** Merge one configuration layer while preserving provider/model coupling. */
export function mergeProviderModelLayer(
  base: AgenCConfig,
  layer: AgenCConfig,
): AgenCConfig {
  return mergeConfigs(base, resolveProviderModelLayer(base, layer));
}
