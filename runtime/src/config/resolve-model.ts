import {
  resolveModel as resolveEnvModel,
  type EnvSnapshot,
} from "./env.js";
import {
  BUILT_IN_PROVIDER_DEFAULT_MODELS,
  buildProviderModelCatalog,
  isAgencModelShortcut,
  normalizeProviderSlug,
  readProviderConfig,
  type ProviderSlug,
} from "./resolve-provider.js";
import type { AgenCConfig, ProviderModelPair } from "./schema.js";
import { resolveModelDisambiguated } from "./schema.js";
import {
  REGISTERED_MODEL_CATALOG,
  resolveRegisteredModelCatalogEntry,
} from "../llm/registry/model-catalog.js";

// Whether `model` is registered (exact/namespaced/prefix match) to some
// provider OTHER than `provider`, and not also to `provider` itself. Used to
// reject a foreign model leaking to a provider that cannot serve it when
// `model_provider` is absent. This generalizes the original grok-only guard:
// a model owned exclusively by, say, openai ("gpt-5") must not be offered to
// anthropic, just as a grok-only model must not be offered to openai. Models
// with no registered owner (e.g. an unknown openai-compatible id) are NOT
// treated as foreign — they fall through to the queried provider, preserving
// the same-provider behaviour for un-catalogued ids.
// `resolveRegisteredModelCatalogEntry` performs the same exact/namespaced/
// prefix matching the registry uses for resolution.
function isRegisteredToOtherProvider(
  model: string,
  provider: ProviderSlug,
): boolean {
  if (resolveRegisteredModelCatalogEntry({ provider, model }) !== undefined) {
    // Owned by the queried provider too — not foreign.
    return false;
  }
  const owningProviders = new Set(
    REGISTERED_MODEL_CATALOG.map((entry) => entry.provider),
  );
  for (const owner of owningProviders) {
    if (resolveRegisteredModelCatalogEntry({ provider: owner, model }) !== undefined) {
      return true;
    }
  }
  return false;
}

export function configuredModelForProvider(
  config: AgenCConfig,
  provider: ProviderSlug,
): string | undefined {
  const providerDefault = readProviderConfig(config, provider)?.default_model?.trim();
  const configuredModel = config.model?.trim();
  const configuredProvider = normalizeProviderSlug(config.model_provider);

  // An explicit top-level `model` that is unambiguously selected for THIS
  // provider (i.e. `model_provider` is set and resolves to it) is the user's
  // direct choice — written by `agenc config set model` and surfaced by
  // `agenc config get model`. It must win over the provider's `default_model`,
  // which is only a fallback for when no model has been selected. Without this,
  // a `[providers.<p>] default_model` silently shadows `config set model`, and
  // the configured model never actually runs.
  if (configuredModel && configuredProvider === provider) {
    return configuredModel;
  }

  if (providerDefault) {
    return providerDefault;
  }

  if (!configuredModel) return undefined;

  if (configuredProvider && configuredProvider !== provider) {
    return undefined;
  }
  if (
    !configuredProvider &&
    isRegisteredToOtherProvider(configuredModel, provider)
  ) {
    return undefined;
  }
  return configuredModel;
}

export function defaultModelForProvider(provider: ProviderSlug): string {
  // The single source of truth for "which model is default" is
  // BUILT_IN_PROVIDER_DEFAULT_MODELS; every provider slug has an entry there.
  return BUILT_IN_PROVIDER_DEFAULT_MODELS[provider];
}

export function resolveModelSelection(params: {
  readonly cliModel?: string;
  readonly config: AgenCConfig;
  readonly provider?: ProviderSlug;
  readonly env?: EnvSnapshot;
}): string {
  if (params.cliModel?.trim()) {
    return params.cliModel.trim();
  }

  const envModel = params.env ? resolveEnvModel("", params.env).trim() : "";
  if (envModel) {
    return envModel;
  }

  if (!params.provider && isAgencModelShortcut(params.config.model)) {
    return "agenc";
  }

  if (params.provider) {
    return (
      configuredModelForProvider(params.config, params.provider) ??
      defaultModelForProvider(params.provider)
    );
  }

  const configuredModel = params.config.model?.trim();
  if (configuredModel) {
    return configuredModel;
  }

  // Ultimate default reads from the one defaults map rather than a literal.
  return BUILT_IN_PROVIDER_DEFAULT_MODELS.grok;
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
