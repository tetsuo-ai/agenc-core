import {
  resolveProvider as resolveEnvProvider,
  resolveProviderApiKey as resolveEnvProviderApiKey,
  resolveProviderBaseURL as resolveEnvProviderBaseURL,
  type EnvSnapshot,
} from "./env.js";
import type {
  AgenCConfig,
  ProviderCapabilityOverrides,
  ProviderConfig,
} from "./schema.js";

export const BUILT_IN_PROVIDER_DEFAULT_MODELS = Object.freeze({
  grok: "grok-4-fast",
  openai: "gpt-5",
  anthropic: "claude-opus-4-7",
  ollama: "llama3.3",
  lmstudio: "gpt-4o-mini",
  openrouter: "openai/gpt-5",
  groq: "llama-3.3-70b-versatile",
  deepseek: "deepseek-reasoner",
  gemini: "gemini-2.5-pro",
} as const);

export const BUILT_IN_PROVIDER_BASE_URLS = Object.freeze({
  grok: "https://api.x.ai/v1",
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  ollama: "http://localhost:11434",
  lmstudio: "http://localhost:1234/v1",
  openrouter: "https://openrouter.ai/api/v1",
  groq: "https://api.groq.com/openai/v1",
  deepseek: "https://api.deepseek.com/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta",
} as const);

export const BUILT_IN_PROVIDER_MODEL_CATALOG: Readonly<
  Record<string, readonly string[]>
> = Object.freeze({
  grok: Object.freeze([
    "grok-4-fast",
    "grok-4",
    "grok-3",
    "grok-2",
    "grok-2-mini",
    "grok-beta",
    "grok-code-fast-1",
  ]),
  openai: Object.freeze(["gpt-5", "o3"]),
  anthropic: Object.freeze(["claude-opus-4-7"]),
  ollama: Object.freeze(["llama3.3"]),
  lmstudio: Object.freeze(["gpt-4o-mini"]),
  openrouter: Object.freeze(["openai/gpt-5"]),
  groq: Object.freeze(["llama-3.3-70b-versatile"]),
  deepseek: Object.freeze(["deepseek-reasoner"]),
  gemini: Object.freeze(["gemini-2.5-pro"]),
});

export type ProviderSlug = keyof typeof BUILT_IN_PROVIDER_DEFAULT_MODELS;

export interface ResolvedProviderSettings {
  readonly provider: ProviderSlug;
  readonly apiKeyEnvVar?: string;
  readonly apiKey?: string;
  readonly baseURL?: string;
  readonly defaultModel?: string;
  readonly contextWindowTokens?: number;
  readonly maxOutputTokens?: number;
  readonly capabilityOverrides?: ProviderCapabilityOverrides;
}

export function normalizeProviderSlug(
  provider: string | undefined,
): ProviderSlug | undefined {
  const normalized = provider?.trim().toLowerCase();
  if (!normalized) return undefined;
  const slug = normalized === "xai" ? "grok" : normalized;
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
  readonly config: AgenCConfig;
  readonly env?: EnvSnapshot;
  readonly fallback?: ProviderSlug;
}): ProviderSlug | undefined {
  const resolved =
    normalizeProviderSlug(params.cliProvider) ??
    normalizeProviderSlug(resolveEnvProvider(params.env)) ??
    normalizeProviderSlug(params.config.model_provider) ??
    params.fallback;
  return resolved;
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
  const apiKey =
    (apiKeyEnvVar ? env[apiKeyEnvVar] : undefined) ??
    resolveEnvProviderApiKey(slug, env);
  const envBaseURL = resolveEnvProviderBaseURL(slug, env);
  const configuredBaseURL = providerConfig?.base_url?.trim();
  const baseURL = envBaseURL ?? configuredBaseURL;
  const contextWindowTokens = positiveInteger(
    providerConfig?.context_window_tokens,
  );
  const maxOutputTokens = positiveInteger(providerConfig?.max_output_tokens);
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
  };
}

function positiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : undefined;
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
