import {
  normalizeProviderSlug,
  readProviderConfig,
  type AgenCConfig,
} from "./_deps/config.js";
import { resolveModelCatalogMetadata } from "./registry/model-catalog.js";
import {
  BUILT_IN_PROVIDER_API_KEY_ENVS,
  BUILT_IN_PROVIDER_BASE_URLS,
} from "./registry/provider-info.js";
import {
  boundedOutputTokens,
  CAPPED_DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_MAX_OUTPUT_TOKENS_UPPER_LIMIT,
  ESCALATED_MAX_OUTPUT_TOKENS,
  getOpenAICompatibleContextWindow,
  getOpenAICompatibleMaxOutputTokens,
  OPENAI_COMPATIBLE_FALLBACK_CONTEXT_WINDOW,
} from "./openai-compatible-token-limits.js";
import { asRecord } from "../utils/record.js";

export const CONSERVATIVE_CONTEXT_WINDOW_TOKENS =
  OPENAI_COMPATIBLE_FALLBACK_CONTEXT_WINDOW;

const DEFAULT_METADATA_TIMEOUT_MS = 1_000;
const MODELS_DEV_API_URL = "https://models.dev/api.json";
const LITELLM_MODEL_MAP_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

const LIVE_METADATA_PROVIDERS = new Set([
  "grok",
  "openai",
  "lmstudio",
  "openai-compatible",
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
  readonly maxOutputTokensUpperLimit?: number;
  readonly maxOutputTokensExplicit?: boolean;
  readonly maxOutputTokensCappedDefault?: boolean;
  readonly source: ModelMetadataSource;
  readonly usedFallbackModelMetadata: boolean;
}

export interface ModelMetadataResolverOptions {
  readonly fetchImpl?: typeof fetch;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
  readonly onWarn?: (msg: string) => void;
}

interface LookupParams {
  readonly provider: string;
  readonly model: string;
  readonly config: AgenCConfig;
}

interface ModelMetadataValues {
  readonly contextWindow?: number;
  readonly maxContextWindow?: number;
  readonly maxOutputTokens?: number;
  readonly maxOutputTokensUpperLimit?: number;
  readonly maxOutputTokensExplicit?: boolean;
}

interface FetchJsonOptions {
  readonly headers?: Readonly<Record<string, string>>;
}

export class ModelMetadataResolver {
  private readonly fetchImpl?: typeof fetch;
  private readonly env: Readonly<Record<string, string | undefined>>;
  private readonly timeoutMs: number;
  private readonly onWarn?: (msg: string) => void;
  private readonly jsonCache = new Map<string, Promise<unknown | undefined>>();
  private readonly warnedInvalidEnv = new Set<string>();

  constructor(options: ModelMetadataResolverOptions = {}) {
    this.fetchImpl = options.fetchImpl;
    this.env = options.env ?? process.env;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_METADATA_TIMEOUT_MS;
    this.onWarn = options.onWarn;
  }

  resolveSync(params: LookupParams): ResolvedModelMetadata {
    const explicit = readExplicitConfigMetadata(params);
    if (hasAnyMetadata(explicit)) {
      return this.finalize(params, explicit, "explicit_config", false);
    }

    const builtIn = inferBuiltInMetadata(params.provider, params.model);
    if (hasAnyMetadata(builtIn)) {
      return this.finalize(params, builtIn, "built_in_heuristic", false);
    }

    return this.finalize(
      params,
      conservativeFallbackValues(),
      "conservative_fallback",
      true,
    );
  }

  async resolve(params: LookupParams): Promise<ResolvedModelMetadata> {
    const explicit = readExplicitConfigMetadata(params);
    if (shouldPreferLiveEndpointOverExplicit(params, this.env)) {
      const live = await this.resolveLiveEndpointMetadata(params);
      if (hasAnyMetadata(live)) {
        return this.finalize(
          params,
          mergeLiveEndpointMetadata(live, explicit),
          "live_endpoint",
          false,
        );
      }
    }

    if (hasAnyMetadata(explicit)) {
      return this.finalize(params, explicit, "explicit_config", false);
    }

    const builtIn = inferBuiltInMetadata(params.provider, params.model);
    if (
      hasAnyMetadata(builtIn) &&
      !shouldPreferDynamicMetadata(params, this.env)
    ) {
      return this.finalize(params, builtIn, "built_in_heuristic", false);
    }

    const live = await this.resolveLiveEndpointMetadata(params);
    if (hasAnyMetadata(live)) {
      return this.finalize(params, live, "live_endpoint", false);
    }

    const openrouter = await this.resolveOpenRouterMetadata(params);
    if (hasAnyMetadata(openrouter)) {
      return this.finalize(params, openrouter, "openrouter_registry", false);
    }

    const modelsDev = await this.resolveModelsDevMetadata(params);
    if (hasAnyMetadata(modelsDev)) {
      return this.finalize(params, modelsDev, "models_dev", false);
    }

    const litellm = await this.resolveLiteLlmMetadata(params);
    if (hasAnyMetadata(litellm)) {
      return this.finalize(params, litellm, "litellm", false);
    }

    if (hasAnyMetadata(builtIn)) {
      return this.finalize(params, builtIn, "built_in_heuristic", false);
    }

    return this.finalize(
      params,
      conservativeFallbackValues(),
      "conservative_fallback",
      true,
    );
  }

  private finalize(
    params: LookupParams,
    metadata: ModelMetadataValues,
    source: ModelMetadataSource,
    usedFallbackModelMetadata: boolean,
  ): ResolvedModelMetadata {
    const output = resolveEffectiveOutputTokens({
      config: params.config,
      env: this.env,
      metadata,
      onWarn: this.warnOnce.bind(this),
    });
    return {
      ...(metadata.contextWindow !== undefined
        ? { contextWindow: metadata.contextWindow }
        : {}),
      maxOutputTokens: output.maxOutputTokens,
      maxOutputTokensUpperLimit: output.maxOutputTokensUpperLimit,
      maxOutputTokensExplicit: output.maxOutputTokensExplicit,
      maxOutputTokensCappedDefault: output.maxOutputTokensCappedDefault,
      source,
      usedFallbackModelMetadata,
    };
  }

  private warnOnce(msg: string): void {
    if (this.warnedInvalidEnv.has(msg)) return;
    this.warnedInvalidEnv.add(msg);
    this.onWarn?.(msg);
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

function conservativeFallbackValues(): ModelMetadataValues {
  return {
    contextWindow: CONSERVATIVE_CONTEXT_WINDOW_TOKENS,
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
    maxOutputTokensUpperLimit: DEFAULT_MAX_OUTPUT_TOKENS_UPPER_LIMIT,
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
    provider === "openai-compatible" ||
    Boolean(providerConfig?.base_url?.trim()) ||
    Boolean(envBaseUrl(provider, env))
  );
}

function shouldPreferLiveEndpointOverExplicit(
  params: LookupParams,
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return (
    normalizeProvider(params.provider) === "openai-compatible" &&
    shouldQueryLiveEndpoint(params, env)
  );
}

function mergeLiveEndpointMetadata(
  live: ModelMetadataValues,
  explicit: ModelMetadataValues | undefined,
): ModelMetadataValues {
  return {
    ...(live.contextWindow !== undefined
      ? { contextWindow: live.contextWindow }
      : explicit?.contextWindow !== undefined
        ? { contextWindow: explicit.contextWindow }
        : {}),
    ...(live.maxContextWindow !== undefined
      ? { maxContextWindow: live.maxContextWindow }
      : explicit?.maxContextWindow !== undefined
        ? { maxContextWindow: explicit.maxContextWindow }
        : {}),
    ...(explicit?.maxOutputTokens !== undefined
      ? {
        maxOutputTokens: explicit.maxOutputTokens,
        maxOutputTokensUpperLimit:
          explicit.maxOutputTokensUpperLimit ?? explicit.maxOutputTokens,
        ...(explicit.maxOutputTokensExplicit !== undefined
          ? { maxOutputTokensExplicit: explicit.maxOutputTokensExplicit }
          : {}),
      }
      : live.maxOutputTokens !== undefined
        ? {
          maxOutputTokens: live.maxOutputTokens,
          maxOutputTokensUpperLimit:
            live.maxOutputTokensUpperLimit ?? live.maxOutputTokens,
          ...(live.maxOutputTokensExplicit !== undefined
            ? { maxOutputTokensExplicit: live.maxOutputTokensExplicit }
            : {}),
        }
        : {}),
  };
}

function readExplicitConfigMetadata(
  params: LookupParams,
): ModelMetadataValues {
  const providerConfig = readProviderConfig(params.config, params.provider) as
    | Record<string, unknown>
    | undefined;
  const explicitContextWindow = readPositiveInteger(
    providerConfig,
    "context_window_tokens",
    "contextWindowTokens",
  );
  const catalogMaxContextWindow = resolveModelCatalogMetadata({
    provider: params.provider,
    model: params.model,
  })?.maxContextWindow;
  const contextWindow =
    explicitContextWindow !== undefined && catalogMaxContextWindow !== undefined
      ? Math.min(explicitContextWindow, catalogMaxContextWindow)
      : explicitContextWindow;
  return {
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(catalogMaxContextWindow !== undefined
      ? { maxContextWindow: catalogMaxContextWindow }
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
        maxOutputTokensUpperLimit: readPositiveInteger(
          providerConfig,
          "max_output_tokens",
          "maxOutputTokens",
          "maxTokens",
        ),
        maxOutputTokensExplicit: true,
      }
      : {}),
  };
}

const OPENAI_COMPATIBLE_METADATA_PROVIDERS = new Set([
  "openai",
  "lmstudio",
  "openrouter",
  "groq",
  "deepseek",
  "gemini",
  "ollama",
]);

function inferBuiltInMetadata(
  provider: string,
  model: string,
): ModelMetadataValues | undefined {
  const normalizedProvider = normalizeProvider(provider);
  const normalizedModel = model.trim().toLowerCase();
  const catalog = resolveModelCatalogMetadata({
    provider: normalizedProvider,
    model,
  });
  if (hasAnyMetadata(catalog)) {
    return catalog;
  }
  if (OPENAI_COMPATIBLE_METADATA_PROVIDERS.has(normalizedProvider)) {
    const contextWindow = getOpenAICompatibleContextWindow(model);
    const maxOutputTokens = getOpenAICompatibleMaxOutputTokens(model);
    if (contextWindow !== undefined || maxOutputTokens !== undefined) {
      return {
        ...(contextWindow !== undefined ? { contextWindow } : {}),
        ...(maxOutputTokens !== undefined
          ? {
            maxOutputTokens,
            maxOutputTokensUpperLimit: maxOutputTokens,
          }
          : {}),
      };
    }
  }
  switch (normalizedProvider) {
    case "grok":
      if (!normalizedModel.startsWith("grok-")) return undefined;
      return {
        contextWindow: normalizedModel.startsWith("grok-code-fast-1")
          ? 256_000
          : 2_000_000,
        maxOutputTokens: 32_768,
      };
    case "anthropic":
      if (!normalizedModel.includes("claude")) return undefined;
      return { contextWindow: 200_000 };
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
  models: Record<string, unknown> | null | undefined,
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
      ...(readPositiveInteger(limit, "output") !== undefined
        ? { maxOutputTokensUpperLimit: readPositiveInteger(limit, "output") }
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
      ...(readPositiveInteger(record, "max_output_tokens") !== undefined
        ? {
          maxOutputTokensUpperLimit: readPositiveInteger(
            record,
            "max_output_tokens",
          ),
        }
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
    ...(readPositiveInteger(
      record,
      "max_output_tokens",
      "max_completion_tokens",
    ) !== undefined
      ? {
        maxOutputTokensUpperLimit: readPositiveInteger(
          record,
          "max_output_tokens",
          "max_completion_tokens",
        ),
      }
      : readPositiveInteger(topProvider, "max_completion_tokens") !== undefined
        ? {
          maxOutputTokensUpperLimit: readPositiveInteger(
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
    case "openai-compatible":
      return ["openai-compatible", "openai", "self-hosted"];
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
  return envBaseURL || configured || defaultProviderBaseUrl(provider);
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
    case "openai-compatible":
      return (
        nonEmpty(env.OPENAI_COMPATIBLE_BASE_URL) ??
        nonEmpty(env.OPENAI_BASE_URL)
      );
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
  const primaryEnv = defaultProviderApiKeyEnv(provider);
  const primary = primaryEnv ? nonEmpty(env[primaryEnv]) : undefined;
  if (primary) return primary;
  return provider === "lmstudio" || provider === "openai-compatible"
    ? nonEmpty(env.OPENAI_API_KEY)
    : undefined;
}

function defaultProviderBaseUrl(provider: string): string | undefined {
  const slug = normalizeProviderSlug(provider);
  return slug === undefined ? undefined : BUILT_IN_PROVIDER_BASE_URLS[slug];
}

function defaultProviderApiKeyEnv(provider: string): string | undefined {
  const slug = normalizeProviderSlug(provider);
  return slug === undefined ? undefined : BUILT_IN_PROVIDER_API_KEY_ENVS[slug];
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function readPositiveInteger(
  source: Record<string, unknown> | null | undefined,
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

interface EffectiveOutputTokens {
  readonly maxOutputTokens: number;
  readonly maxOutputTokensUpperLimit: number;
  readonly maxOutputTokensExplicit: boolean;
  readonly maxOutputTokensCappedDefault: boolean;
}

function resolveEffectiveOutputTokens(params: {
  readonly config: AgenCConfig;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly metadata: ModelMetadataValues;
  readonly onWarn?: (msg: string) => void;
}): EffectiveOutputTokens {
  const metadata = params.metadata;
  const metadataDefault = metadata.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const metadataUpper =
    metadata.maxOutputTokensUpperLimit ??
    metadata.maxOutputTokens ??
    DEFAULT_MAX_OUTPUT_TOKENS_UPPER_LIMIT;

  if (
    metadata.maxOutputTokens !== undefined &&
    metadata.maxOutputTokensExplicit === true
  ) {
    return {
      maxOutputTokens: metadata.maxOutputTokens,
      maxOutputTokensUpperLimit: metadata.maxOutputTokens,
      maxOutputTokensExplicit: true,
      maxOutputTokensCappedDefault: false,
    };
  }

  const configOverride = normalizePositiveInteger(params.config.max_output_tokens);
  const envOverride = readEnvMaxOutputTokens(params.env, params.onWarn);
  const explicitOverride = envOverride ?? configOverride;
  if (explicitOverride !== undefined) {
    return {
      maxOutputTokens: boundedOutputTokens(explicitOverride, metadataUpper),
      maxOutputTokensUpperLimit: metadataUpper,
      maxOutputTokensExplicit: true,
      maxOutputTokensCappedDefault: false,
    };
  }

  if (params.config.capped_default_max_output_tokens === true) {
    return {
      maxOutputTokens: boundedOutputTokens(
        CAPPED_DEFAULT_MAX_OUTPUT_TOKENS,
        metadataUpper,
      ),
      maxOutputTokensUpperLimit: metadataUpper,
      maxOutputTokensExplicit: false,
      maxOutputTokensCappedDefault: true,
    };
  }

  return {
    maxOutputTokens: boundedOutputTokens(metadataDefault, metadataUpper),
    maxOutputTokensUpperLimit: metadataUpper,
    maxOutputTokensExplicit: false,
    maxOutputTokensCappedDefault: false,
  };
}

function readEnvMaxOutputTokens(
  env: Readonly<Record<string, string | undefined>>,
  onWarn: ((msg: string) => void) | undefined,
): number | undefined {
  const raw = env.AGENC_MAX_OUTPUT_TOKENS;
  if (raw === undefined || raw.trim().length === 0) return undefined;
  const parsed = normalizePositiveInteger(raw);
  if (parsed !== undefined) return parsed;
  onWarn?.(
    `[agenc:config] invalid AGENC_MAX_OUTPUT_TOKENS="${raw}"; expected a positive integer`,
  );
  return undefined;
}

export function escalatedMaxOutputTokensForModel(
  metadata: Pick<ResolvedModelMetadata, "maxOutputTokensUpperLimit">,
): number {
  return boundedOutputTokens(
    ESCALATED_MAX_OUTPUT_TOKENS,
    metadata.maxOutputTokensUpperLimit ?? DEFAULT_MAX_OUTPUT_TOKENS_UPPER_LIMIT,
  );
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
