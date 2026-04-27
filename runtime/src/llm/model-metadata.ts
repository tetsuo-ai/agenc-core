import {
  normalizeProviderSlug,
  readProviderConfig,
  type AgenCConfig,
} from "./_deps/config.js";

export const CONSERVATIVE_CONTEXT_WINDOW_TOKENS = 128_000;

const DEFAULT_METADATA_TIMEOUT_MS = 1_000;
const MODELS_DEV_API_URL = "https://models.dev/api.json";
const LITELLM_MODEL_MAP_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

const DEFAULT_PROVIDER_BASE_URLS: Readonly<Record<string, string>> =
  Object.freeze({
    grok: "https://api.x.ai/v1",
    openai: "https://api.openai.com/v1",
    lmstudio: "http://localhost:1234/v1",
    openrouter: "https://openrouter.ai/api/v1",
    groq: "https://api.groq.com/openai/v1",
    deepseek: "https://api.deepseek.com/v1",
  });

const DEFAULT_PROVIDER_API_KEY_ENVS: Readonly<Record<string, string>> =
  Object.freeze({
    grok: "XAI_API_KEY",
    openai: "OPENAI_API_KEY",
    lmstudio: "LMSTUDIO_API_KEY",
    openrouter: "OPENROUTER_API_KEY",
    groq: "GROQ_API_KEY",
    deepseek: "DEEPSEEK_API_KEY",
  });

const LIVE_METADATA_PROVIDERS = new Set([
  "grok",
  "openai",
  "lmstudio",
  "groq",
  "deepseek",
]);

export type ModelMetadataSource =
  | "explicit_config"
  | "live_endpoint"
  | "openrouter_registry"
  | "models_dev"
  | "litellm"
  | "built_in_heuristic"
  | "conservative_fallback";

export interface ResolvedModelMetadata {
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
  readonly source: ModelMetadataSource;
  readonly usedFallbackModelMetadata: boolean;
}

export interface ModelMetadataResolverOptions {
  readonly fetchImpl?: typeof fetch;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
}

interface LookupParams {
  readonly provider: string;
  readonly model: string;
  readonly config: AgenCConfig;
}

interface ModelMetadataValues {
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
}

interface FetchJsonOptions {
  readonly headers?: Readonly<Record<string, string>>;
}

export class ModelMetadataResolver {
  private readonly fetchImpl?: typeof fetch;
  private readonly env: Readonly<Record<string, string | undefined>>;
  private readonly timeoutMs: number;
  private readonly jsonCache = new Map<string, Promise<unknown | undefined>>();

  constructor(options: ModelMetadataResolverOptions = {}) {
    this.fetchImpl = options.fetchImpl;
    this.env = options.env ?? process.env;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_METADATA_TIMEOUT_MS;
  }

  resolveSync(params: LookupParams): ResolvedModelMetadata {
    const explicit = readExplicitConfigMetadata(params);
    if (hasAnyMetadata(explicit)) {
      return {
        ...explicit,
        source: "explicit_config",
        usedFallbackModelMetadata: false,
      };
    }

    const builtIn = inferBuiltInMetadata(params.provider, params.model);
    if (hasAnyMetadata(builtIn)) {
      return {
        ...builtIn,
        source: "built_in_heuristic",
        usedFallbackModelMetadata: false,
      };
    }

    return conservativeFallback();
  }

  async resolve(params: LookupParams): Promise<ResolvedModelMetadata> {
    const explicit = readExplicitConfigMetadata(params);
    if (hasAnyMetadata(explicit)) {
      return {
        ...explicit,
        source: "explicit_config",
        usedFallbackModelMetadata: false,
      };
    }

    const builtIn = inferBuiltInMetadata(params.provider, params.model);
    if (
      hasAnyMetadata(builtIn) &&
      !shouldPreferDynamicMetadata(params, this.env)
    ) {
      return {
        ...builtIn,
        source: "built_in_heuristic",
        usedFallbackModelMetadata: false,
      };
    }

    const live = await this.resolveLiveEndpointMetadata(params);
    if (hasAnyMetadata(live)) {
      return {
        ...live,
        source: "live_endpoint",
        usedFallbackModelMetadata: false,
      };
    }

    const openrouter = await this.resolveOpenRouterMetadata(params);
    if (hasAnyMetadata(openrouter)) {
      return {
        ...openrouter,
        source: "openrouter_registry",
        usedFallbackModelMetadata: false,
      };
    }

    const modelsDev = await this.resolveModelsDevMetadata(params);
    if (hasAnyMetadata(modelsDev)) {
      return {
        ...modelsDev,
        source: "models_dev",
        usedFallbackModelMetadata: false,
      };
    }

    const litellm = await this.resolveLiteLlmMetadata(params);
    if (hasAnyMetadata(litellm)) {
      return {
        ...litellm,
        source: "litellm",
        usedFallbackModelMetadata: false,
      };
    }

    if (hasAnyMetadata(builtIn)) {
      return {
        ...builtIn,
        source: "built_in_heuristic",
        usedFallbackModelMetadata: false,
      };
    }

    return conservativeFallback();
  }

  private async resolveLiveEndpointMetadata(
    params: LookupParams,
  ): Promise<ModelMetadataValues | undefined> {
    const provider = normalizeProvider(params.provider);
    if (!LIVE_METADATA_PROVIDERS.has(provider)) return undefined;
    if (!shouldQueryLiveEndpoint(params, this.env)) return undefined;
    const baseUrl = providerBaseUrl(params.config, provider, this.env);
    if (!baseUrl) return undefined;
    const response = await this.fetchJson(modelsUrlFromBaseUrl(baseUrl), {
      headers: authHeaders(params.config, provider, this.env),
    });
    return metadataFromOpenAiModelsResponse(response, params.model);
  }

  private async resolveOpenRouterMetadata(
    params: LookupParams,
  ): Promise<ModelMetadataValues | undefined> {
    if (normalizeProvider(params.provider) !== "openrouter") return undefined;
    const response = await this.fetchJson(OPENROUTER_MODELS_URL);
    return metadataFromOpenAiModelsResponse(response, params.model);
  }

  private async resolveModelsDevMetadata(
    params: LookupParams,
  ): Promise<ModelMetadataValues | undefined> {
    const response = await this.fetchJson(MODELS_DEV_API_URL);
    return metadataFromModelsDev(response, params.provider, params.model);
  }

  private async resolveLiteLlmMetadata(
    params: LookupParams,
  ): Promise<ModelMetadataValues | undefined> {
    const response = await this.fetchJson(LITELLM_MODEL_MAP_URL);
    return metadataFromLiteLlm(response, params.provider, params.model);
  }

  private async fetchJson(
    url: string,
    options: FetchJsonOptions = {},
  ): Promise<unknown | undefined> {
    if (!this.fetchImpl) return undefined;
    const cacheKey = `${url}\n${JSON.stringify(options.headers ?? {})}`;
    const cached = this.jsonCache.get(cacheKey);
    if (cached) return await cached;
    const request = this.fetchJsonUncached(url, options);
    this.jsonCache.set(cacheKey, request);
    return await request;
  }

  private async fetchJsonUncached(
    url: string,
    options: FetchJsonOptions,
  ): Promise<unknown | undefined> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl!(url, {
        headers: options.headers,
        signal: controller.signal,
      });
      if (!response.ok) return undefined;
      return await response.json();
    } catch {
      return undefined;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function readExplicitProviderContextWindowTokens(
  config: AgenCConfig,
  provider: string | undefined,
): number | undefined {
  return readExplicitConfigMetadata({ config, provider: provider ?? "", model: "" })
    .contextWindow;
}

export function readExplicitProviderMaxOutputTokens(
  config: AgenCConfig,
  provider: string | undefined,
): number | undefined {
  return readExplicitConfigMetadata({ config, provider: provider ?? "", model: "" })
    .maxOutputTokens;
}

function conservativeFallback(): ResolvedModelMetadata {
  return {
    contextWindow: CONSERVATIVE_CONTEXT_WINDOW_TOKENS,
    source: "conservative_fallback",
    usedFallbackModelMetadata: true,
  };
}

function shouldPreferDynamicMetadata(
  params: LookupParams,
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  const provider = normalizeProvider(params.provider);
  return provider === "openrouter" || shouldQueryLiveEndpoint(params, env);
}

function shouldQueryLiveEndpoint(
  params: LookupParams,
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  const provider = normalizeProvider(params.provider);
  const providerConfig = readProviderConfig(params.config, provider);
  return (
    provider === "lmstudio" ||
    Boolean(providerConfig?.base_url?.trim()) ||
    Boolean(envBaseUrl(provider, env))
  );
}

function readExplicitConfigMetadata(
  params: LookupParams,
): ModelMetadataValues {
  const providerConfig = readProviderConfig(params.config, params.provider) as
    | Record<string, unknown>
    | undefined;
  return {
    ...(readPositiveInteger(
      providerConfig,
      "context_window_tokens",
      "contextWindowTokens",
    ) !== undefined
      ? {
        contextWindow: readPositiveInteger(
          providerConfig,
          "context_window_tokens",
          "contextWindowTokens",
        ),
      }
      : {}),
    ...(readPositiveInteger(
      providerConfig,
      "max_output_tokens",
      "maxOutputTokens",
      "maxTokens",
    ) !== undefined
      ? {
        maxOutputTokens: readPositiveInteger(
          providerConfig,
          "max_output_tokens",
          "maxOutputTokens",
          "maxTokens",
        ),
      }
      : {}),
  };
}

function inferBuiltInMetadata(
  provider: string,
  model: string,
): ModelMetadataValues | undefined {
  const normalizedProvider = normalizeProvider(provider);
  const normalizedModel = model.trim().toLowerCase();
  switch (normalizedProvider) {
    case "grok":
      if (!normalizedModel.startsWith("grok-")) return undefined;
      return {
        contextWindow: normalizedModel.startsWith("grok-code-fast-1")
          ? 256_000
          : 2_000_000,
        maxOutputTokens: 32_768,
      };
    case "openai":
      if (
        !/(?:^|[/:])(gpt-5|gpt-4|gpt-4o|gpt-3\.5|o1|o3|o4)(?:$|[-_.:])/.test(
          normalizedModel,
        )
      ) {
        return undefined;
      }
      return {
        contextWindow: /(?:^|[/:])(gpt-5|o3|o4|o1)(?:$|[-_.:])/.test(
          normalizedModel,
        )
          ? 1_000_000
          : 128_000,
        ...(/(?:^|[/:])gpt-5(?:$|[-_.:])/.test(normalizedModel)
          ? { maxOutputTokens: 128_000 }
          : {}),
      };
    case "anthropic":
      if (!normalizedModel.includes("claude")) return undefined;
      return { contextWindow: 200_000 };
    case "openrouter":
      if (!/(?:gpt-5|o3|o4|o1|gemini-2\.5)/.test(normalizedModel)) {
        return undefined;
      }
      return {
        contextWindow: 1_000_000,
      };
    case "groq":
      if (
        !/^(?:llama-3\.[13]|mixtral-8x7b)/.test(normalizedModel)
      ) {
        return undefined;
      }
      return { contextWindow: 128_000 };
    case "deepseek":
      if (!normalizedModel.startsWith("deepseek-")) return undefined;
      return { contextWindow: 128_000 };
    case "gemini":
      if (!normalizedModel.startsWith("gemini-")) return undefined;
      return { contextWindow: 1_000_000 };
    default:
      return undefined;
  }
}

function metadataFromOpenAiModelsResponse(
  response: unknown,
  model: string,
): ModelMetadataValues | undefined {
  const data = asRecord(response)?.data;
  if (!Array.isArray(data)) return undefined;
  const match = data.find((entry) => modelObjectMatches(entry, model));
  if (!match) return undefined;
  const modelObject = asRecord(match);
  if (!modelObject) return undefined;
  return metadataFromGenericRecord(modelObject);
}

function metadataFromModelsDev(
  response: unknown,
  provider: string,
  model: string,
): ModelMetadataValues | undefined {
  const registry = asRecord(response);
  if (!registry) return undefined;
  const providerIds = providerAliases(provider);
  for (const providerId of providerIds) {
    const providerRecord = asRecord(registry[providerId]);
    const models = asRecord(providerRecord?.models);
    const metadata = metadataFromModelsDevModels(models, provider, model);
    if (hasAnyMetadata(metadata)) return metadata;
  }

  for (const providerRecord of Object.values(registry)) {
    const models = asRecord(asRecord(providerRecord)?.models);
    const metadata = metadataFromModelsDevModels(models, provider, model);
    if (hasAnyMetadata(metadata)) return metadata;
  }
  return undefined;
}

function metadataFromModelsDevModels(
  models: Record<string, unknown> | undefined,
  provider: string,
  model: string,
): ModelMetadataValues | undefined {
  if (!models) return undefined;
  for (const [modelId, modelRecord] of Object.entries(models)) {
    if (!modelKeyMatches(modelId, provider, model)) continue;
    const limit = asRecord(asRecord(modelRecord)?.limit);
    return {
      ...(readPositiveInteger(limit, "context", "input") !== undefined
        ? { contextWindow: readPositiveInteger(limit, "context", "input") }
        : {}),
      ...(readPositiveInteger(limit, "output") !== undefined
        ? { maxOutputTokens: readPositiveInteger(limit, "output") }
        : {}),
    };
  }
  return undefined;
}

function metadataFromLiteLlm(
  response: unknown,
  provider: string,
  model: string,
): ModelMetadataValues | undefined {
  const registry = asRecord(response);
  if (!registry) return undefined;
  for (const [modelId, modelRecord] of Object.entries(registry)) {
    if (modelId === "sample_spec") continue;
    if (!modelKeyMatches(modelId, provider, model)) continue;
    const record = asRecord(modelRecord);
    if (!record) return undefined;
    return {
      ...(readPositiveInteger(
        record,
        "max_input_tokens",
        "max_context_tokens",
        "max_tokens",
      ) !== undefined
        ? {
          contextWindow: readPositiveInteger(
            record,
            "max_input_tokens",
            "max_context_tokens",
            "max_tokens",
          ),
        }
        : {}),
      ...(readPositiveInteger(record, "max_output_tokens") !== undefined
        ? { maxOutputTokens: readPositiveInteger(record, "max_output_tokens") }
        : {}),
    };
  }
  return undefined;
}

function metadataFromGenericRecord(
  record: Record<string, unknown>,
): ModelMetadataValues {
  const topProvider = asRecord(record.top_provider);
  return {
    ...(readPositiveInteger(
      record,
      "max_model_len",
      "context_length",
      "max_context_length",
      "max_input_tokens",
      "max_tokens",
    ) !== undefined
      ? {
        contextWindow: readPositiveInteger(
          record,
          "max_model_len",
          "context_length",
          "max_context_length",
          "max_input_tokens",
          "max_tokens",
        ),
      }
      : readPositiveInteger(topProvider, "context_length") !== undefined
        ? { contextWindow: readPositiveInteger(topProvider, "context_length") }
        : {}),
    ...(readPositiveInteger(
      record,
      "max_output_tokens",
      "max_completion_tokens",
    ) !== undefined
      ? {
        maxOutputTokens: readPositiveInteger(
          record,
          "max_output_tokens",
          "max_completion_tokens",
        ),
      }
      : readPositiveInteger(topProvider, "max_completion_tokens") !== undefined
        ? {
          maxOutputTokens: readPositiveInteger(
            topProvider,
            "max_completion_tokens",
          ),
        }
        : {}),
  };
}

function modelObjectMatches(entry: unknown, model: string): boolean {
  const record = asRecord(entry);
  if (!record) return false;
  return ["id", "canonical_slug", "root"].some((key) => {
    const value = record[key];
    return typeof value === "string" && modelIdMatches(value, model);
  });
}

function modelKeyMatches(
  key: string,
  provider: string,
  model: string,
): boolean {
  if (modelIdMatches(key, model)) return true;
  const normalized = normalizeId(key);
  const normalizedModel = normalizeId(model);
  const prefixes = providerAliases(provider).map((entry) => normalizeId(entry));
  return prefixes.some((prefix) => normalized === `${prefix}/${normalizedModel}`);
}

function modelIdMatches(candidate: string, model: string): boolean {
  return normalizeId(candidate) === normalizeId(model);
}

function providerAliases(provider: string): readonly string[] {
  const normalized = normalizeProvider(provider);
  switch (normalized) {
    case "grok":
      return ["grok", "xai", "x-ai"];
    case "lmstudio":
      return ["lmstudio", "openai", "openai-compatible"];
    default:
      return [normalized];
  }
}

function normalizeProvider(provider: string): string {
  return normalizeProviderSlug(provider) ?? provider.trim().toLowerCase();
}

function normalizeId(value: string): string {
  return value.trim().toLowerCase();
}

function providerBaseUrl(
  config: AgenCConfig,
  provider: string,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const providerConfig = readProviderConfig(config, provider);
  const configured = providerConfig?.base_url?.trim();
  const envBaseURL = envBaseUrl(provider, env);
  return envBaseURL || configured || DEFAULT_PROVIDER_BASE_URLS[provider];
}

function modelsUrlFromBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  if (trimmed.endsWith("/models")) return trimmed;
  if (/\/(?:v\d+(?:beta)?|api\/v\d+)$/i.test(trimmed)) {
    return `${trimmed}/models`;
  }
  return `${trimmed}/v1/models`;
}

function authHeaders(
  config: AgenCConfig,
  provider: string,
  env: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> | undefined {
  const providerConfig = readProviderConfig(config, provider);
  const configuredApiKeyEnv = providerConfig?.api_key_env?.trim();
  const apiKey =
    configuredApiKeyEnv
      ? env[configuredApiKeyEnv]?.trim()
      : envApiKey(provider, env);
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined;
}

function envBaseUrl(
  provider: string,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  switch (provider) {
    case "openai":
      return nonEmpty(env.OPENAI_BASE_URL);
    case "lmstudio":
      return nonEmpty(env.LMSTUDIO_BASE_URL) ?? nonEmpty(env.OPENAI_BASE_URL);
    case "openrouter":
      return nonEmpty(env.OPENROUTER_BASE_URL);
    case "groq":
      return nonEmpty(env.GROQ_BASE_URL);
    case "deepseek":
      return nonEmpty(env.DEEPSEEK_BASE_URL);
    default:
      return undefined;
  }
}

function envApiKey(
  provider: string,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const primaryEnv = DEFAULT_PROVIDER_API_KEY_ENVS[provider];
  const primary = primaryEnv ? nonEmpty(env[primaryEnv]) : undefined;
  if (primary) return primary;
  return provider === "lmstudio" ? nonEmpty(env.OPENAI_API_KEY) : undefined;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function readPositiveInteger(
  source: Record<string, unknown> | undefined,
  ...keys: readonly string[]
): number | undefined {
  if (!source) return undefined;
  for (const key of keys) {
    const normalized = normalizePositiveInteger(source[key]);
    if (normalized !== undefined) return normalized;
  }
  return undefined;
}

function normalizePositiveInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const normalized = Math.floor(value);
    return normalized > 0 ? normalized : undefined;
  }
  if (typeof value === "string" && /^\d+(?:_\d+)*$/.test(value.trim())) {
    const parsed = Number.parseInt(value.replaceAll("_", ""), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  }
  return undefined;
}

function hasAnyMetadata(
  metadata: ModelMetadataValues | undefined,
): metadata is ModelMetadataValues {
  return (
    metadata !== undefined &&
    (metadata.contextWindow !== undefined ||
      metadata.maxOutputTokens !== undefined)
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
