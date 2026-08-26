import {
  resolveModel as resolveEnvModel,
  resolveProvider as resolveEnvProvider,
  resolveProviderApiKey as resolveEnvProviderApiKey,
  resolveProviderBaseURL as resolveEnvProviderBaseURL,
  type EnvSnapshot,
} from "./env.js";
import {
  BUILT_IN_PROVIDER_DEFAULT_MODELS,
  resolveBuiltInProviderSlug,
} from "../llm/registry/provider-info.js";
import type { ProviderSlug } from "./provider-model-authority.js";
import { normalizeProviderIdentity } from "../provider-identity.js";
import type {
  AgenCConfig,
  ProviderCapabilityOverrides,
  ProviderConfig,
  ProviderFallbackTargetConfig,
} from "./schema.js";
import { resolveGrokProviderApiKey } from "../llm/xai-capability-config.js";
import { resolveSecureStorageHome } from "../utils/secureStorage/home.js";

export {
  BUILT_IN_PROVIDER_BASE_URLS,
  BUILT_IN_PROVIDER_DEFAULT_MODELS,
  BUILT_IN_PROVIDER_MODEL_CATALOG,
} from "../llm/registry/provider-info.js";
export { buildProviderModelCatalog } from "./provider-model-authority.js";
export type { ProviderSlug } from "./provider-model-authority.js";

export function isAgencModelShortcut(
  model: string | undefined,
): boolean {
  return model?.trim().toLowerCase() === "agenc";
}

export interface ResolvedProviderSettings {
  readonly provider: ProviderSlug;
  readonly apiKey?: string;
  readonly baseURL?: string;
  readonly defaultModel?: string;
  readonly contextWindowTokens?: number;
  readonly maxOutputTokens?: number;
  /** Request timeout in ms; inter-chunk idle for streams. 0 disables. */
  readonly timeoutMs?: number;
  readonly capabilityOverrides?: ProviderCapabilityOverrides;
  readonly fallbackTargets?: readonly ProviderFallbackTargetConfig[];
  readonly fallbackMaxFailures?: number;
  readonly fallbackStatuses?: readonly number[];
}

export { resolveBuiltInProviderSlug as resolveProviderSlug };

export function readProviderConfig(
  config: AgenCConfig,
  provider: string | undefined,
): ProviderConfig | undefined {
  const slug = resolveBuiltInProviderSlug(provider);
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
    resolveBuiltInProviderSlug(params.cliProvider) ??
    resolveBuiltInProviderSlug(resolveEnvProvider(params.env));
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
    resolveBuiltInProviderSlug(params.config.model_provider) ??
    params.fallback
  );
}

export function resolveProviderSettings(
  provider: string | undefined,
  config: AgenCConfig,
  env: EnvSnapshot = process.env,
): ResolvedProviderSettings | undefined {
  const slug = resolveBuiltInProviderSlug(provider);
  if (!slug) return undefined;
  const providerConfig = readProviderConfig(config, slug);
  // Grok: /grok-login OAuth ALWAYS wins over env BYOK (dead keys in the shell
  // must not shadow subscription access). Other providers: env as before.
  const apiKey =
    slug === "grok"
      ? resolveGrokProviderApiKey(
          resolveSecureStorageHome(env),
          resolveEnvProviderApiKey(slug, env),
          env,
        )
      : resolveEnvProviderApiKey(slug, env);
  const envBaseURL = resolveEnvProviderBaseURL(slug, env);
  const configuredBaseURL = providerConfig?.base_url?.trim();
  const baseURL = envBaseURL ?? configuredBaseURL;
  const contextWindowTokens = positiveInteger(
    providerConfig?.context_window_tokens,
  );
  const maxOutputTokens = positiveInteger(providerConfig?.max_output_tokens);
  const timeoutMs = nonNegativeInteger(providerConfig?.timeout_ms);
  const fallbackTargets = normalizeProviderFallbackTargets(slug, providerConfig);
  const fallbackMaxFailures = positiveInteger(
    providerConfig?.fallback?.max_failures,
  );
  const fallbackStatuses = normalizePositiveIntegerArray(
    providerConfig?.fallback?.statuses,
  );
  return {
    provider: slug,
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
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
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

// 0 is meaningful for timeout_ms: it disables the timeout rather than being
// dropped like an invalid value.
function nonNegativeInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const normalized = Math.floor(value);
  return normalized >= 0 ? normalized : undefined;
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
      ? normalizeProviderIdentity(trimmedProvider, "provider fallback target")
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
  return Object.freeze(out);
}
