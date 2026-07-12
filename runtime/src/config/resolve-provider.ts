import {
  resolveModel as resolveEnvModel,
  resolveProvider as resolveEnvProvider,
  resolveProviderApiKey as resolveEnvProviderApiKey,
  resolveProviderBaseURL as resolveEnvProviderBaseURL,
  type EnvSnapshot,
} from "./env.js";
import {
  BUILT_IN_PROVIDER_DEFAULT_MODELS,
  BUILT_IN_PROVIDER_MODEL_CATALOG,
} from "../llm/registry/provider-info.js";
import type {
  AgenCConfig,
  ProviderCapabilityOverrides,
  ProviderConfig,
  ProviderFallbackTargetConfig,
} from "./schema.js";
import { resolveGrokProviderApiKey } from "../llm/xai-capability-config.js";

export {
  BUILT_IN_PROVIDER_BASE_URLS,
  BUILT_IN_PROVIDER_DEFAULT_MODELS,
  BUILT_IN_PROVIDER_MODEL_CATALOG,
} from "../llm/registry/provider-info.js";

export type ProviderSlug = keyof typeof BUILT_IN_PROVIDER_DEFAULT_MODELS;

export function isAgencModelShortcut(
  model: string | undefined,
): boolean {
  return model?.trim().toLowerCase() === "agenc";
}

export interface ResolvedProviderSettings {
  readonly provider: ProviderSlug;
  readonly apiKeyEnvVar?: string;
  readonly apiKey?: string;
  readonly baseURL?: string;
  readonly defaultModel?: string;
  readonly contextWindowTokens?: number;
  readonly maxOutputTokens?: number;
  readonly capabilityOverrides?: ProviderCapabilityOverrides;
  readonly fallbackTargets?: readonly ProviderFallbackTargetConfig[];
  readonly fallbackMaxFailures?: number;
  readonly fallbackStatuses?: readonly number[];
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

export function resolveProviderSelection(params: {
  readonly cliProvider?: string;
  readonly cliModel?: string;
  readonly config: AgenCConfig;
  readonly env?: EnvSnapshot;
  readonly fallback?: ProviderSlug;
}): ProviderSlug | undefined {
  const explicitProvider =
    normalizeProviderSlug(params.cliProvider) ??
    normalizeProviderSlug(resolveEnvProvider(params.env));
  if (explicitProvider) return explicitProvider;

  const envModel = resolveEnvModel("", params.env).trim();
  const resolved =
    isAgencModelShortcut(params.cliModel) ||
    isAgencModelShortcut(envModel) ||
    isAgencModelShortcut(params.config.model)
      ? "agenc"
      : undefined;
  return (
    resolved ??
    normalizeProviderSlug(params.config.model_provider) ??
    params.fallback
  );
}

export function resolveProviderSettings(
  provider: string | undefined,
  config: AgenCConfig,
  env: EnvSnapshot = process.env,
): ResolvedProviderSettings | undefined {
  const slug = normalizeProviderSlug(provider);
  if (!slug) return undefined;
  const providerConfig = readProviderConfig(config, slug);
  const apiKeyEnvVar = providerConfig?.api_key_env?.trim() || undefined;
  // Grok: /grok-login OAuth ALWAYS wins over env BYOK (dead keys in the shell
  // must not shadow subscription access). Other providers: env as before.
  const apiKey =
    slug === "grok"
      ? resolveGrokProviderApiKey(
          (apiKeyEnvVar ? env[apiKeyEnvVar] : undefined) ??
            resolveEnvProviderApiKey(slug, env),
          env,
        )
      : ((apiKeyEnvVar ? env[apiKeyEnvVar] : undefined) ??
        resolveEnvProviderApiKey(slug, env));
  const envBaseURL = resolveEnvProviderBaseURL(slug, env);
  const configuredBaseURL = providerConfig?.base_url?.trim();
  const baseURL = envBaseURL ?? configuredBaseURL;
  const contextWindowTokens = positiveInteger(
    providerConfig?.context_window_tokens,
  );
  const maxOutputTokens = positiveInteger(providerConfig?.max_output_tokens);
  const fallbackTargets = normalizeProviderFallbackTargets(slug, providerConfig);
  const fallbackMaxFailures = positiveInteger(
    providerConfig?.fallback?.max_failures,
  );
  const fallbackStatuses = normalizePositiveIntegerArray(
    providerConfig?.fallback?.statuses,
  );
  return {
    provider: slug,
    ...(apiKeyEnvVar ? { apiKeyEnvVar } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(baseURL ? { baseURL } : {}),
    ...(providerConfig?.default_model?.trim()
      ? { defaultModel: providerConfig.default_model.trim() }
      : {
          defaultModel: BUILT_IN_PROVIDER_DEFAULT_MODELS[slug],
        }),
    ...(contextWindowTokens !== undefined
      ? { contextWindowTokens }
      : {}),
    ...(maxOutputTokens !== undefined
      ? { maxOutputTokens }
      : {}),
    ...(providerConfig?.capability_overrides
      ? { capabilityOverrides: providerConfig.capability_overrides }
      : {}),
    ...(fallbackTargets.length > 0 ? { fallbackTargets } : {}),
    ...(fallbackMaxFailures !== undefined
      ? { fallbackMaxFailures }
      : {}),
    ...(fallbackStatuses.length > 0 ? { fallbackStatuses } : {}),
  };
}

function positiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : undefined;
}

function normalizePositiveIntegerArray(
  values: unknown,
): readonly number[] {
  if (!Array.isArray(values)) return Object.freeze([]);
  const out: number[] = [];
  const seen = new Set<number>();
  for (const value of values) {
    const normalized = positiveInteger(value);
    if (normalized === undefined || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return Object.freeze(out);
}

function unknownArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function normalizeProviderFallbackTargets(
  provider: string,
  config: ProviderConfig | undefined,
): readonly ProviderFallbackTargetConfig[] {
  const out: ProviderFallbackTargetConfig[] = [];
  const seen = new Set<string>();

  const append = (target: ProviderFallbackTargetConfig): void => {
    const model = target.model.trim();
    if (!model) return;
    const trimmedProvider = target.provider?.trim();
    const targetProvider = trimmedProvider
      ? normalizeProviderSlug(trimmedProvider) ?? trimmedProvider.toLowerCase()
      : provider;
    const reason = target.reason?.trim();
    const key = `${targetProvider}\0${model}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      provider: targetProvider,
      model,
      ...(reason ? { reason } : {}),
    });
  };

  for (const target of unknownArray(config?.fallback?.targets)) {
    if (!target || typeof target !== "object" || Array.isArray(target)) continue;
    const record = target as Partial<ProviderFallbackTargetConfig>;
    if (typeof record.model !== "string") continue;
    append({
      ...(typeof record.provider === "string"
        ? { provider: record.provider }
        : {}),
      model: record.model,
      ...(typeof record.reason === "string" ? { reason: record.reason } : {}),
    });
  }
  for (const model of unknownArray(config?.fallback?.models)) {
    if (typeof model !== "string") continue;
    append({ provider, model });
  }
  for (const model of unknownArray(config?.fallback_models)) {
    if (typeof model !== "string") continue;
    append({ provider, model });
  }

  return Object.freeze(out);
}

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
