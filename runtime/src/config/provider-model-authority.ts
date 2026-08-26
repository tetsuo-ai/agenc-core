import {
  BUILT_IN_PROVIDER_DEFAULT_MODELS,
  BUILT_IN_PROVIDER_MODEL_CATALOG,
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

export type ProviderSlug = BuiltInProviderSlug;

export function buildProviderModelCatalog(
  config?: AgenCConfig,
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
      const model = providerConfig.default_model?.trim();
      if (!slug || !model) continue;
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
  throw new Error(
    `unknown provider '${raw}'. Expected one of: ${Object.keys(BUILT_IN_PROVIDER_DEFAULT_MODELS).join(", ")}`,
  );
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

function explicitQualification(model: string): ProviderModelPair | undefined {
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
  if (
    qualification === undefined ||
    !catalog[qualification.provider]?.includes(model)
  ) return undefined;
  return Object.freeze({ provider: qualification.provider, model });
}

function resolveExplicitPair(
  provider: ProviderSlug,
  model: string,
  catalog: Readonly<Record<string, readonly string[]>>,
): ProviderModelPair {
  if (model === "agenc") {
    if (provider !== "agenc") {
      throw selectionConflict(provider, model, "agenc");
    }
    return Object.freeze({ provider: "agenc", model: "agenc" });
  }
  const catalogQualified = catalogQualifiedModel(model, catalog);
  if (catalogQualified !== undefined) {
    if (catalogQualified.provider !== provider) {
      throw selectionConflict(provider, model, catalogQualified.provider);
    }
    return catalogQualified;
  }

  try {
    const resolved = resolveModelDisambiguated(model, catalog);
    if (resolved.provider !== provider) {
      throw selectionConflict(provider, model, resolved.provider);
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
      const qualification = explicitQualification(model);
      if (qualification !== undefined) {
        if (qualification.provider !== provider) {
          throw selectionConflict(provider, model, qualification.provider);
        }
        return qualification;
      }
      return Object.freeze({ provider, model });
    }
    throw error;
  }
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
      selection = resolveExplicitPair(provider, modelInput, catalog);
    } else {
      const defaultModel =
        combined.providers?.[provider]?.default_model?.trim() ||
        BUILT_IN_PROVIDER_DEFAULT_MODELS[provider];
      selection = resolveExplicitPair(provider, defaultModel, catalog);
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
          selection = qualification ?? Object.freeze({
            provider: resolveProviderSlugOrThrow(
              base.model_provider ?? combined.model_provider ?? "",
            ),
            model: modelInput,
          });
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
