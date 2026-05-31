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

export function configuredModelForProvider(
  config: AgenCConfig,
  provider: ProviderSlug,
): string | undefined {
  const providerDefault = readProviderConfig(config, provider)?.default_model?.trim();
  if (providerDefault) {
    return providerDefault;
  }

  const configuredModel = config.model?.trim();
  if (!configuredModel) return undefined;

  const configuredProvider = normalizeProviderSlug(config.model_provider);
  if (configuredProvider && configuredProvider !== provider) {
    return undefined;
  }
  if (
    !configuredProvider &&
    provider !== "grok" &&
    configuredModel === BUILT_IN_PROVIDER_DEFAULT_MODELS.grok
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
