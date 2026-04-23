import {
  resolveModel as resolveEnvModel,
  type EnvSnapshot,
} from "./env.js";
import {
  BUILT_IN_PROVIDER_DEFAULT_MODELS,
  buildProviderModelCatalog,
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
  if (!configuredProvider && provider !== "grok" && configuredModel === "grok-4-fast") {
    return undefined;
  }
  return configuredModel;
}

export function defaultModelForProvider(provider: ProviderSlug): string {
  return BUILT_IN_PROVIDER_DEFAULT_MODELS[provider] ?? "grok-4-fast";
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

  return "grok-4-fast";
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
