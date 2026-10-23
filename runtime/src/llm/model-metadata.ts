import { parseVeniceModels, veniceCatalogEntry, veniceModelCosts, type VeniceModel } from "./registry/venice-models.js";
import {
  abliterationCatalogEntry,
  abliterationModelCosts,
  parseAbliterationModels,
  type AbliterationModel,
} from "./registry/abliteration-models.js";
import { recordPublishedModelCosts } from "./registry/published-model-costs.js";
import { recordPublishedModelCatalog, recordPublishedModelDetail } from "./registry/published-model-catalog.js";
import { OpenRouterCatalog, openRouterCatalogFor, type OpenRouterCatalogSnapshot } from "./registry/openrouter-live-catalog.js";
import {
  OPENROUTER_ZDR_ENDPOINTS_URL,
  recordOpenRouterZdrEndpoints,
} from "./registry/openrouter-zdr-endpoints.js";
import {
  OLLAMA_CLOUD_ORIGIN,
  ollamaCloudCatalogEntry,
  parseOllamaCloudShow,
  parseOllamaCloudTags,
  type OllamaCloudModelRow,
} from "./registry/ollama-cloud-models.js";
import { EndpointMetadataCache, endpointMetadataForTransport, type EndpointMetadataScope } from "./endpoint-metadata-cache.js";
import {
  readProviderConfig,
} from "../config/resolve-provider.js";
import type { AgenCConfig } from "../config/schema.js";
import { resolveModelCatalogMetadata } from "./registry/model-catalog.js";
import { rememberSuccessfulLookup } from "./remember-successful-lookup.js";
import { normalizeProviderMetadataIdentity } from "../provider-identity.js";
import { gatewayModelFamily } from "./model-family.js";
import { DEEPSEEK_MODELS } from "./registry/deepseek-models.js";
import {
  allowsOpenAICompatibleKeyFallback,
  resolveProviderApiKeyEnvironment,
  resolveProviderBaseURLEnvironment,
} from "./registry/provider-ingress.js";
import { resolveBuiltInProviderInfo } from "./registry/provider-info.js";
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
import { OLLAMA_CLOUD_BASE_URL } from "./registry/ollama-cloud-models.js";
import { ollamaRuntimeContextWindow } from "./providers/ollama/context-window.js";
import { asRecord } from "../utils/record.js";
import { fetchProviderRequest } from "./credential-redirect-fetch.js";

export const CONSERVATIVE_CONTEXT_WINDOW_TOKENS =
  OPENAI_COMPATIBLE_FALLBACK_CONTEXT_WINDOW;

const DEFAULT_METADATA_TIMEOUT_MS = 1_000;
/**
 * A provider's whole model list (Ollama Cloud's tags and model card,
 * OpenRouter's public list) can take longer than one model lookup, and
 * capability flags and effort levels depend on it, so it gets more time.
 * A resolver reads it once. Venice has its own, longer limit below.
 */
const LIVE_MODEL_LIST_TIMEOUT_MS = 5_000;
const MODELS_DEV_API_URL = "https://models.dev/api.json";
const LITELLM_MODEL_MAP_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

const LIVE_METADATA_PROVIDERS = new Set([
  "grok",
  "openai",
  "lmstudio",
  "openai-compatible",
  "ollama",
  "ollama-cloud",
  "groq",
  "deepseek",
  "meta",
  "qwen",
  "qwen-token-plan",
  "cerebras",
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
  readonly catalogHome?: string;
  readonly readSavedApiKey?: (provider: string) => string | undefined;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
  readonly onWarn?: (msg: string) => void;
  /**
   * Share downloads of the public catalogs (models.dev, the LiteLLM model
   * map) with other resolvers. Without it, this resolver downloads its own.
   */
  readonly publicCatalogs?: PublicModelCatalogCache;
  /** Explicitly opt this resolver into one private transport partition. */
  readonly endpointCatalogs?: EndpointMetadataCache;
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
  readonly maxOutputTokensCappedDefault?: boolean;
}

interface FetchJsonOptions {
  readonly headers?: Readonly<Record<string, string>>;
  /** Ollama's native metadata endpoint is a POST with a JSON body. */
  readonly jsonBody?: Readonly<Record<string, unknown>>;
  /** Overrides the resolver's timeout for one large listing. */
  readonly timeoutMs?: number;
  /**
   * Told when the endpoint answered the JSON returned: now for a new
   * download, earlier for one shared between resolvers. Not called when this
   * resolver's own cache answers or the request fails.
   */
  readonly onAnswer?: (answeredAt: number) => void;
}

/**
 * Venice's model list is the only source of its models' limits, and it is
 * large (about 170 KB) and often takes 1 to 5 seconds. With the general 1 s
 * metadata timeout most sessions gave up on it and ran on the conservative
 * fallback (a 128k window and 32k output cap instead of the model's own).
 * The first chat call waits for the list anyway.
 */
const VENICE_MODEL_LIST_TIMEOUT_MS = 10_000;

type MetadataJson = object | string | number | boolean | null;

/** How long later sessions reuse one download of a public model catalog. */
const PUBLIC_CATALOG_REUSE_MS = 10 * 60_000;

/**
 * One download of each public model catalog (models.dev and the LiteLLM model
 * map), shared by the resolvers given this cache. Every session builds its
 * own resolver, so a daemon restoring 32 sessions at startup downloaded and
 * parsed each catalog 32 times. Now concurrent lookups share one request, a
 * successful download is reused for PUBLIC_CATALOG_REUSE_MS, and a failed one
 * is not kept, so the next lookup tries again, as each session did before.
 */
export class PublicModelCatalogCache {
  readonly #now: () => number;
  readonly #reuseMs: number;
  readonly #inFlight = new Map<string, Promise<MetadataJson | undefined>>();
  readonly #downloaded = new Map<
    string,
    { readonly value: MetadataJson; readonly at: number }
  >();

  constructor(
    options: { readonly now?: () => number; readonly reuseMs?: number } = {},
  ) {
    this.#now = options.now ?? Date.now;
    this.#reuseMs = options.reuseMs ?? PUBLIC_CATALOG_REUSE_MS;
  }

  async get(
    url: string,
    download: () => Promise<MetadataJson | undefined>,
  ): Promise<MetadataJson | undefined> {
    const downloaded = this.#downloaded.get(url);
    if (
      downloaded !== undefined &&
      this.#now() - downloaded.at < this.#reuseMs
    ) {
      return downloaded.value;
    }
    const pending = this.#inFlight.get(url);
    if (pending !== undefined) return await pending;
    const request = download();
    this.#inFlight.set(url, request);
    try {
      const value = await request;
      if (value !== undefined) {
        this.#downloaded.set(url, { value, at: this.#now() });
      }
      return value;
    } finally {
      this.#inFlight.delete(url);
    }
  }
}

/** The process-wide cache sessions use when they fetch over the network. */
export const SHARED_PUBLIC_MODEL_CATALOGS = new PublicModelCatalogCache();

export class ModelMetadataResolver {
  private veniceResponse?: MetadataJson;
  private veniceModels?: readonly VeniceModel[];
  private abliterationResponse?: MetadataJson;
  private abliterationModels?: readonly AbliterationModel[];
  private openRouterCatalog?: OpenRouterCatalog;
  private readonly catalogHome?: string;
  private ollamaCloudTags?: MetadataJson;
  private ollamaCloudListed?: readonly OllamaCloudModelRow[];
  private readonly ollamaCloudShown = new Map<string, OllamaCloudModelRow>();
  /** When Ollama answered each `ollamaCloudShown` row. */
  private readonly ollamaCloudShownAt = new Map<string, number>();
  private readonly readSavedApiKey?: (provider: string) => string | undefined;
  private readonly fetchImpl?: typeof fetch;
  private readonly env: Readonly<Record<string, string | undefined>>;
  private readonly timeoutMs: number;
  private readonly onWarn?: (msg: string) => void;
  private readonly publicCatalogs?: PublicModelCatalogCache;
  private readonly endpointCatalogs?: EndpointMetadataCache;
  /** Model lists read with the session's key (Venice, abliteration.ai). */
  private readonly keyedListCatalogs?: EndpointMetadataCache;
  private endpointRevision = -1;
  private inFlightJson = new Map<
    string,
    Promise<MetadataJson | undefined>
  >();
  private jsonCache = new Map<string, MetadataJson | undefined>();
  private readonly warnedInvalidEnv = new Set<string>();
  /** An explicitly configured timeout applies here too. */
  private readonly veniceListTimeoutMs: number;

  constructor(options: ModelMetadataResolverOptions = {}) {
    this.fetchImpl = options.fetchImpl;
    this.catalogHome = options.catalogHome;
    this.readSavedApiKey = options.readSavedApiKey;
    this.env = options.env ?? process.env;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_METADATA_TIMEOUT_MS;
    this.veniceListTimeoutMs = options.timeoutMs ?? VENICE_MODEL_LIST_TIMEOUT_MS;
    this.onWarn = options.onWarn;
    this.publicCatalogs = options.publicCatalogs;
    this.endpointCatalogs = options.endpointCatalogs;
    this.keyedListCatalogs = options.endpointCatalogs ?? (options.fetchImpl ? endpointMetadataForTransport(options.fetchImpl) : undefined);
  }

  /** Observe authority changes even when an upper-level model cache has a hit. */
  cacheRevision(params: LookupParams): number {
    this.endpointScope(params);
    const revision = this.endpointCatalogs?.revision ?? 0;
    if (revision !== this.endpointRevision) {
      // Replace maps, do not clear them: an old pending download owns the old
      // maps and must not republish data into this generation.
      this.veniceResponse = undefined;
      this.veniceModels = undefined;
      this.abliterationResponse = undefined;
      this.abliterationModels = undefined;
      this.openRouterCatalog = undefined;
      this.ollamaCloudTags = undefined;
      this.ollamaCloudListed = undefined;
      this.ollamaCloudShown.clear();
      this.ollamaCloudShownAt.clear();
      this.inFlightJson = new Map();
      this.jsonCache = new Map();
      this.endpointRevision = revision;
    }
    return revision;
  }

  private endpointScope(params: LookupParams): EndpointMetadataScope | undefined {
    const provider = normalizeMetadataProviderIdentity(params.provider);
    // These lists use their own scope (readKeyedModelList); observing the
    // provider here too would rotate it on every lookup.
    if (provider === "venice" || provider === "abliteration") return undefined;
    return this.endpointCatalogs?.observe(provider, this.endpointConfiguration(params));
  }

  private credentialEnvironment(provider: string): Readonly<Record<string, string | undefined>> {
    if (provider === "openrouter" && !this.env.OPENROUTER_API_KEY?.trim()) {
      return { ...this.env, OPENROUTER_API_KEY: this.readSavedApiKey?.("openrouter") };
    }
    if (provider === "venice" && !this.env.VENICE_API_KEY?.trim()) {
      return { ...this.env, VENICE_API_KEY: this.readSavedApiKey?.("venice") };
    }
    if (provider === "abliteration" && resolveProviderApiKeyEnvironment(provider, this.env) === undefined) {
      return { ...this.env, ABLIT_KEY: this.readSavedApiKey?.("abliteration") };
    }
    return this.env;
  }

  private endpointConfiguration(params: LookupParams): unknown {
    const provider = normalizeMetadataProviderIdentity(params.provider);
    return {
      config: readProviderConfig(params.config, provider),
      baseUrl: providerBaseUrl(params.config, provider, this.env),
      headers: authHeaders(provider, params.config, this.credentialEnvironment(provider)),
      timeoutMs: this.timeoutMs,
    };
  }

  resolveSync(params: LookupParams): ResolvedModelMetadata {
    if (normalizeMetadataProviderIdentity(params.provider) === "openrouter") this.openRouterCatalogForSession().read();
    const explicit = readExplicitConfigMetadata(params);
    const veniceModel = normalizeMetadataProviderIdentity(params.provider) === "venice"
      ? this.veniceModels?.find(entry => entry.model === params.model) : undefined;
    if (veniceModel) {
      return this.finalize(params, mergeLiveEndpointMetadata({
        contextWindow: veniceModel.contextWindow,
        maxOutputTokens: veniceModel.maxOutputTokens,
        maxOutputTokensUpperLimit: veniceModel.maxOutputTokens,
      }, explicit), "live_endpoint", false);
    }
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
    const scope = this.endpointScope(params);
    this.cacheRevision(params);
    const metadata = await this.resolveMetadata(params);
    // Other sessions may rotate the shared scope while this request is in
    // flight. Their rotation only revokes shared publication. If this caller's
    // own authority changed, fail explicitly rather than using old limits or
    // extending the discovery timeout with an automatic retry.
    if (scope !== undefined && !this.endpointCatalogs!.matchesConfiguration(
      scope, this.endpointConfiguration(params),
    )) {
      this.endpointCatalogs!.invalidate(scope);
      throw new Error("Provider metadata configuration changed during discovery; retry with the current configuration");
    }
    return metadata;
  }

  private async resolveMetadata(params: LookupParams): Promise<ResolvedModelMetadata> {
    const metadataProvider = normalizeMetadataProviderIdentity(params.provider);
    if (metadataProvider === "ollama-cloud" || metadataProvider === "abliteration") {
      // Record the live row first: the catalog lookups below then read it.
      try {
        if (metadataProvider === "ollama-cloud") {
          await this.discoverOllamaCloudModels(params.config, params.model);
        } else {
          await this.discoverAbliterationModels(params.config);
        }
      } catch {
        // Best effort, as every other live lookup here.
      }
    }
    const explicit = readExplicitConfigMetadata(params);
    if (normalizeMetadataProviderIdentity(params.provider) === "venice") {
      const model = (await this.discoverVeniceModels(params.config))?.find(entry => entry.model === params.model);
      if (model) {
        return this.finalize(params, mergeLiveEndpointMetadata({
          contextWindow: model.contextWindow,
          maxOutputTokens: model.maxOutputTokens,
          maxOutputTokensUpperLimit: model.maxOutputTokens,
        }, explicit), "live_endpoint", false);
      }
      return this.resolveSync(params);
    }
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

    // A failed proxy refresh does not require public catalog lookups for a
    // DeepSeek model whose limits are already registered locally.
    if (normalizeMetadataProviderIdentity(params.provider) === "deepseek" && hasAnyMetadata(builtIn)) {
      return this.finalize(params, builtIn, "built_in_heuristic", false);
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
    const builtIn = inferBuiltInMetadata(params.provider, params.model);
    // An explicit output cap overrides that field, not the model's remaining
    // metadata. Dropping its known context window makes session admission fail.
    const sourced = source === "explicit_config"
      ? { ...builtIn, ...metadata }
      : metadata;
    // Any source can know a model's output limit and not its window: an
    // explicit cap, or a models list that names the window in a field not read
    // here. A session without a window fails every turn before sending it, so
    // the built-in window stays, and a model nothing here knows plans against
    // the conservative window, as it does when no source answers at all.
    const knownContextWindow = sourced.contextWindow ?? builtIn?.contextWindow;
    const mergedMetadata = {
      ...sourced,
      contextWindow: knownContextWindow ?? CONSERVATIVE_CONTEXT_WINDOW_TOKENS,
    };
    const effectiveMetadata = applyRegisteredModelOutputContract(
      params,
      mergedMetadata,
    );
    const output = resolveEffectiveOutputTokens({
      config: params.config,
      env: this.env,
      metadata: effectiveMetadata,
      onWarn: this.warnOnce.bind(this),
    });
    return {
      contextWindow: mergedMetadata.contextWindow,
      maxOutputTokens: output.maxOutputTokens,
      maxOutputTokensUpperLimit: output.maxOutputTokensUpperLimit,
      maxOutputTokensExplicit: output.maxOutputTokensExplicit,
      maxOutputTokensCappedDefault: output.maxOutputTokensCappedDefault,
      source,
      usedFallbackModelMetadata:
        usedFallbackModelMetadata || knownContextWindow === undefined,
    };
  }

  private warnOnce(msg: string): void {
    if (this.warnedInvalidEnv.has(msg)) return;
    this.warnedInvalidEnv.add(msg);
    this.onWarn?.(msg);
  }

  private liveModelListTimeoutMs(): number {
    return Math.max(this.timeoutMs, LIVE_MODEL_LIST_TIMEOUT_MS);
  }

  /**
   * A provider's `GET /models` read with the session's key. Resolvers on one
   * transport share a successful list for ten minutes; an expired one is
   * served while it refreshes, and a failed or unusable refresh keeps it.
   * Undefined without a key or transport, without a network request.
   */
  private async readKeyedModelList(
    provider: "venice" | "abliteration",
    config: AgenCConfig,
    timeoutMs: number,
    usable: (json: MetadataJson | undefined) => boolean,
  ): Promise<MetadataJson | undefined> {
    this.cacheRevision({ provider, model: "", config });
    const baseUrl = providerBaseUrl(config, provider, this.env);
    const headers = authHeaders(provider, config, this.credentialEnvironment(provider));
    if (!baseUrl || !headers?.Authorization || !this.keyedListCatalogs) return undefined;
    const cache = this.keyedListCatalogs;
    const scope = cache.observe(provider, { baseUrl, headers });
    const url = modelsUrlFromBaseUrl(baseUrl);
    const response = await cache.get(scope, {
      baseUrl, url, method: "GET", headers, timeoutMs,
    }, async () => {
      const result = await this.fetchJsonUncached(url, { headers, timeoutMs });
      // A broken/empty list must not discard the last successful limits.
      return usable(result) ? result : undefined;
    }, { staleWhileRevalidate: true });
    if (!cache.matchesConfiguration(scope, {
      baseUrl: providerBaseUrl(config, provider, this.env),
      headers: authHeaders(provider, config, this.credentialEnvironment(provider)),
    })) {
      throw new Error("Provider metadata configuration changed during discovery; retry with the current configuration");
    }
    return response;
  }

  async discoverVeniceModels(config: AgenCConfig): Promise<readonly VeniceModel[] | undefined> {
    const response = await this.readKeyedModelList(
      "venice", config, this.veniceListTimeoutMs, result => parseVeniceModels(result).length > 0,
    );
    if (response === undefined) return undefined;
    if (response !== this.veniceResponse) {
      this.veniceResponse = response;
      this.veniceModels = parseVeniceModels(response);
      // Venice's prices are the price of record for its models (see
      // published-model-costs): admission and the cost sidecar read them.
      recordPublishedModelCosts("venice", veniceModelCosts(this.veniceModels));
      // So are its capability flags and effort levels (published-model-catalog).
      recordPublishedModelCatalog(
        "venice",
        this.veniceModels.map((model, priority) => veniceCatalogEntry(model, priority)),
        { replace: true },
      );
    }
    return this.veniceModels;
  }

  /**
   * abliteration.ai's `GET /v1/models` with the session's key: the models the
   * key's project can use, with their limits, modalities and prices. Its rows
   * and prices become the published ones (published-model-catalog,
   * published-model-costs), so a locked model leaves the catalog.
   */
  async discoverAbliterationModels(config: AgenCConfig): Promise<readonly AbliterationModel[] | undefined> {
    const response = await this.readKeyedModelList(
      "abliteration", config, this.liveModelListTimeoutMs(), result => parseAbliterationModels(result).length > 0,
    );
    if (response === undefined) return undefined;
    if (response !== this.abliterationResponse) {
      this.abliterationResponse = response;
      this.abliterationModels = parseAbliterationModels(response);
      recordPublishedModelCosts("abliteration", abliterationModelCosts(this.abliterationModels));
      recordPublishedModelCatalog(
        "abliteration",
        this.abliterationModels.map((model, priority) => abliterationCatalogEntry(model, priority)),
        { replace: true },
      );
    }
    return this.abliterationModels;
  }

  private async resolveLiveEndpointMetadata(
    params: LookupParams,
  ): Promise<ModelMetadataValues | undefined> {
    const provider = normalizeMetadataProviderIdentity(params.provider);
    if (!LIVE_METADATA_PROVIDERS.has(provider)) return undefined;
    if (!shouldQueryLiveEndpoint(params, this.env)) return undefined;
    const baseUrl = providerBaseUrl(params.config, provider, this.env);
    if (!baseUrl) return undefined;
    if (provider === "ollama-cloud" && baseUrl.replace(/\/+$/, "") !== OLLAMA_CLOUD_BASE_URL) return undefined;
    const headers = authHeaders(provider, params.config, this.credentialEnvironment(provider));
    // Ollama serves no context length over its OpenAI-compatible surface, so
    // the native endpoint is the only place the real number exists.
    if (provider !== "ollama" && provider !== "ollama-cloud") {
      const response = await this.fetchEndpointJson(params, baseUrl, modelsUrlFromBaseUrl(baseUrl), {
        headers,
      });
      const openAi = metadataFromOpenAiModelsResponse(response, params.model);
      if (hasAnyMetadata(openAi)) return openAi;
    }
    if (
      provider !== "ollama" &&
      provider !== "ollama-cloud" &&
      !isLocalOllamaCompatibleEndpoint(provider, baseUrl)
    ) return undefined;
    return await this.resolveOllamaNativeMetadata(
      baseUrl,
      params,
      provider === "ollama-cloud" ? headers : undefined,
    );
  }

  /**
   * Ollama's `/v1/models` returns only `{id, object, created, owned_by}` -- no
   * context length -- so a local model silently inherited the conservative
   * 128k fallback while really being 32k (qwen2.5-coder) or 2k (moondream).
   * `/api/show` reports the true window under an architecture-prefixed key
   * (`qwen2.context_length`). Compatible local providers pointed at Ollama's
   * default port also use this endpoint, without forwarding their API keys.
   */
  private async resolveOllamaNativeMetadata(
    baseUrl: string,
    params: LookupParams,
    headers: Readonly<Record<string, string>> | undefined,
  ): Promise<ModelMetadataValues | undefined> {
    const response = await this.fetchEndpointJson(params, baseUrl, ollamaShowUrlFromBaseUrl(baseUrl), {
      ...(headers !== undefined ? { headers } : {}),
      jsonBody: { model: params.model },
    });
    const shown = metadataFromOllamaShowResponse(response);
    // A local model runs at the window Core sends it (num_ctx), not at its
    // trained length: admit against the same number the adapter sends.
    if (normalizeMetadataProviderIdentity(params.provider) === "ollama" && shown?.contextWindow !== undefined) {
      return { ...shown, contextWindow: ollamaRuntimeContextWindow(shown.contextWindow) ?? shown.contextWindow };
    }
    return shown;
  }

  private async fetchEndpointJson(
    params: LookupParams,
    baseUrl: string,
    url: string,
    options: FetchJsonOptions,
  ): Promise<MetadataJson | undefined> {
    const shared = this.endpointCatalogs;
    const scope = this.endpointScope(params);
    if (shared === undefined || scope === undefined) return this.fetchJson(url, options);
    // The shared download reports when the endpoint answered, also on reuse.
    const { onAnswer, ...downloadOptions } = options;
    return this.fetchJson(url, options, () => shared.get(scope, {
      baseUrl,
      url,
      method: options.jsonBody === undefined ? "GET" : "POST",
      headers: {
        ...options.headers,
        ...(options.jsonBody !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(options.jsonBody !== undefined ? { body: JSON.stringify(options.jsonBody) } : {}),
      timeoutMs: options.timeoutMs ?? this.timeoutMs,
    }, () => this.fetchJsonUncached(url, downloadOptions), onAnswer === undefined ? {} : { onAnswer }));
  }

  private async resolveOpenRouterMetadata(
    params: LookupParams,
  ): Promise<ModelMetadataValues | undefined> {
    if (normalizeMetadataProviderIdentity(params.provider) !== "openrouter") return undefined;
    await this.discoverOpenRouterModels();
    return inferBuiltInMetadata(params.provider, params.model);
  }

  private openRouterCatalogForSession(): OpenRouterCatalog {
    const apiKey = resolveProviderApiKeyEnvironment("openrouter", this.credentialEnvironment("openrouter"))?.value;
    if (this.openRouterCatalog === undefined) {
      const options = { home: this.catalogHome, apiKey, fetchImpl: this.fetchImpl, timeoutMs: this.liveModelListTimeoutMs() };
      this.openRouterCatalog = this.fetchImpl === undefined ? openRouterCatalogFor(options) : new OpenRouterCatalog(options);
    }
    return this.openRouterCatalog;
  }

  /** Read cached rows without waiting for the network. */
  readOpenRouterCatalog(): OpenRouterCatalogSnapshot {
    return this.openRouterCatalogForSession().read();
  }

  /** The shared catalog handles TTL, disk persistence and published capability/price rows. */
  async discoverOpenRouterModels(): Promise<boolean> {
    const catalog = this.openRouterCatalogForSession();
    // Like fetchJson(), a resolver without an injected transport stays local.
    const snapshot = this.fetchImpl === undefined ? catalog.read() : await catalog.refresh();
    return snapshot.source !== "bundled";
  }

  /**
   * OpenRouter's public list of zero-data-retention endpoints (no key). The
   * picker and the status line read it to tell which models still work while
   * requests carry `provider.zdr`.
   */
  async discoverOpenRouterZdrEndpoints(): Promise<boolean> {
    const response = await this.fetchJson(OPENROUTER_ZDR_ENDPOINTS_URL, { timeoutMs: this.liveModelListTimeoutMs() });
    return recordOpenRouterZdrEndpoints(response);
  }

  /**
   * Ollama Cloud's own list (`GET /api/tags`) and one model's details
   * (`POST /api/show`), both answered without a key. Recorded as the
   * provider's published rows: capability tags from the list, context and
   * thinking levels from the details. Best effort; the bundled rows answer
   * while the network does not.
   */
  async discoverOllamaCloudModels(
    config: AgenCConfig,
    model?: string,
  ): Promise<readonly OllamaCloudModelRow[] | undefined> {
    const params = { provider: "ollama-cloud", model: model ?? "", config };
    this.cacheRevision(params);
    const headers = authHeaders("ollama-cloud", config, this.credentialEnvironment("ollama-cloud"));
    const timeoutMs = this.liveModelListTimeoutMs();
    let showAnsweredAt: number | undefined;
    const [tags, show] = await Promise.all([
      this.fetchEndpointJson(params, OLLAMA_CLOUD_BASE_URL, `${OLLAMA_CLOUD_ORIGIN}/api/tags`, {
        ...(headers !== undefined ? { headers } : {}),
        timeoutMs,
      }),
      model === undefined || model.trim().length === 0
        ? Promise.resolve(undefined)
        : this.fetchEndpointJson(params, OLLAMA_CLOUD_BASE_URL, `${OLLAMA_CLOUD_ORIGIN}/api/show`, {
          ...(headers !== undefined ? { headers } : {}),
          jsonBody: { model: model.trim() },
          timeoutMs,
          onAnswer: (answeredAt) => {
            showAnsweredAt = answeredAt;
          },
        }),
    ]);
    if (tags !== undefined && tags !== this.ollamaCloudTags) {
      this.ollamaCloudTags = tags;
      this.ollamaCloudListed = parseOllamaCloudTags(tags);
    }
    const shown = model !== undefined && show !== undefined
      ? parseOllamaCloudShow(model.trim(), show)
      : undefined;
    if (shown !== undefined) {
      this.ollamaCloudShown.set(shown.model, shown);
      if (showAnsweredAt !== undefined) this.ollamaCloudShownAt.set(shown.model, showAnsweredAt);
    }
    if (this.ollamaCloudListed === undefined && this.ollamaCloudShown.size === 0) return undefined;
    const listed = this.ollamaCloudListed ?? [];
    const rows = [
      ...listed.map((row) => this.ollamaCloudShown.get(row.model) ?? row),
      ...[...this.ollamaCloudShown.values()].filter((row) => !listed.some((entry) => entry.model === row.model)),
    ];
    recordPublishedModelCatalog(
      "ollama-cloud",
      rows.map((row, priority) => ollamaCloudCatalogEntry(row, priority, "list")),
      { replace: this.ollamaCloudListed !== undefined },
    );
    // Mark each detailed row with the time Ollama answered for it: an answer
    // read again from a cache must not make a row look newer than it is.
    for (const row of this.ollamaCloudShown.values()) {
      const answeredAt = this.ollamaCloudShownAt.get(row.model);
      if (answeredAt !== undefined) recordPublishedModelDetail("ollama-cloud", row.model, answeredAt);
    }
    return Object.freeze(rows);
  }

  private async resolveModelsDevMetadata(
    params: LookupParams,
  ): Promise<ModelMetadataValues | undefined> {
    const response = await this.fetchPublicCatalog(MODELS_DEV_API_URL);
    return metadataFromModelsDev(response, params.provider, params.model);
  }

  private async resolveLiteLlmMetadata(
    params: LookupParams,
  ): Promise<ModelMetadataValues | undefined> {
    const response = await this.fetchPublicCatalog(LITELLM_MODEL_MAP_URL);
    return metadataFromLiteLlm(response, params.provider, params.model);
  }

  /**
   * A public catalog is requested without headers or a body, so every
   * resolver's download of it is the same. With a shared cache this resolver
   * takes the shared download, and still keeps what it read for its own
   * lifetime, as it does for every other lookup.
   */
  private async fetchPublicCatalog(
    url: string,
  ): Promise<MetadataJson | undefined> {
    const shared = this.publicCatalogs;
    if (shared === undefined) return await this.fetchJson(url);
    return await this.fetchJson(url, {}, () =>
      shared.get(url, () => this.fetchJsonUncached(url, {})),
    );
  }

  private async fetchJson(
    url: string,
    options: FetchJsonOptions = {},
    download: () => Promise<MetadataJson | undefined> = () =>
      this.fetchJsonUncached(url, options),
  ): Promise<MetadataJson | undefined> {
    if (!this.fetchImpl) return undefined;
    const cacheKey = `${url}\n${JSON.stringify(options.headers ?? {})}\n${
      JSON.stringify(options.jsonBody ?? null)
    }`;
    return await rememberSuccessfulLookup(
      { inFlight: this.inFlightJson, success: this.jsonCache },
      cacheKey,
      download,
      (value) => value !== undefined,
    );
  }

  private async fetchJsonUncached(
    url: string,
    options: FetchJsonOptions,
  ): Promise<MetadataJson | undefined> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? this.timeoutMs);
    try {
      const response = await fetchProviderRequest(url, {
        ...(options.jsonBody !== undefined
          ? {
            method: "POST",
            body: JSON.stringify(options.jsonBody),
            headers: {
              ...(options.headers ?? {}),
              "content-type": "application/json",
            },
          }
          : { headers: options.headers }),
        signal: controller.signal,
      }, this.fetchImpl!);
      if (!response.ok) return undefined;
      const json = await response.json() as MetadataJson | undefined;
      if (json !== undefined) options.onAnswer?.(Date.now());
      return json;
    } catch {
      return undefined;
    } finally {
      clearTimeout(timeout);
    }
  }
}

/** DeepSeek's own per-call output default and ceiling (registry/deepseek-models.ts). */
const DEEPSEEK_OUTPUT_DEFAULT = DEEPSEEK_MODELS[0]!.maxOutputTokens;
const DEEPSEEK_OUTPUT_CEILING = DEEPSEEK_MODELS[0]!.maxOutputTokensUpperLimit;

/**
 * A DeepSeek model through a gateway gets the per-call output default it has on
 * DeepSeek's own API (64k; reasoning and the answer share it), bounded by the
 * route's limit, which stays available to explicit settings and max-output
 * recovery. Without it a session reserved 393,216 tokens a call on OpenRouter,
 * 131,072 on Venice and 16,384 on Ollama Cloud. Ollama Cloud serves these models
 * with DeepSeek's own ceiling (it refuses max_tokens above 393,216), not the
 * 32,768 policy cap of its other models.
 */
function applyModelFamilyOutputContract(
  params: Pick<LookupParams, "provider" | "model">,
  metadata: ModelMetadataValues,
): ModelMetadataValues {
  const provider = normalizeMetadataProviderIdentity(params.provider);
  if (provider === "openrouter" &&
      gatewayModelFamily(provider, params.model) !== "deepseek" &&
      metadata.maxOutputTokensExplicit !== true) {
    // The listing's maximum belongs to its top endpoint. ZDR or other routing
    // preferences can select a smaller endpoint. Do not reserve that maximum
    // for every ordinary turn; retain it for explicit settings and recovery.
    const routeUpper = metadata.maxOutputTokensUpperLimit ??
      metadata.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS_UPPER_LIMIT;
    return {
      ...metadata,
      maxOutputTokens: Math.min(DEFAULT_MAX_OUTPUT_TOKENS, metadata.maxOutputTokens ?? routeUpper, routeUpper),
      maxOutputTokensUpperLimit: routeUpper,
      maxOutputTokensCappedDefault: true,
    };
  }
  if (gatewayModelFamily(provider, params.model) !== "deepseek" ||
      metadata.maxOutputTokensExplicit === true) {
    return metadata;
  }
  const routeUpper = provider === "ollama-cloud"
    ? DEEPSEEK_OUTPUT_CEILING
    : metadata.maxOutputTokensUpperLimit ?? metadata.maxOutputTokens ?? DEEPSEEK_OUTPUT_CEILING;
  return {
    ...metadata,
    maxOutputTokens: Math.min(DEEPSEEK_OUTPUT_DEFAULT, routeUpper),
    maxOutputTokensUpperLimit: routeUpper,
    maxOutputTokensCappedDefault: true,
  };
}

function applyRegisteredModelOutputContract(
  params: Pick<LookupParams, "provider" | "model">,
  metadata: ModelMetadataValues,
): ModelMetadataValues {
  return applyModelFamilyOutputContract(params, applyCatalogOutputContract(params, metadata));
}

function applyCatalogOutputContract(
  params: Pick<LookupParams, "provider" | "model">,
  metadata: ModelMetadataValues,
): ModelMetadataValues {
  const catalog = resolveModelCatalogMetadata({
    provider: normalizeMetadataProviderIdentity(params.provider),
    model: params.model,
  });
  if (catalog?.maxOutputTokens === undefined) return metadata;

  const catalogUpper =
    catalog.maxOutputTokensUpperLimit ?? catalog.maxOutputTokens;
  if (metadata.maxOutputTokens === undefined) {
    return {
      ...metadata,
      maxOutputTokens: catalog.maxOutputTokens,
      maxOutputTokensUpperLimit: catalogUpper,
      ...(catalog.maxOutputTokensCappedDefault !== undefined
        ? {
          maxOutputTokensCappedDefault:
            catalog.maxOutputTokensCappedDefault,
        }
        : {}),
    };
  }

  const effectiveUpper = Math.min(
    metadata.maxOutputTokensUpperLimit ?? metadata.maxOutputTokens,
    catalogUpper,
  );
  if (
    catalog.maxOutputTokensCappedDefault === true &&
    metadata.maxOutputTokensExplicit !== true
  ) {
    return {
      ...metadata,
      maxOutputTokens: boundedOutputTokens(
        catalog.maxOutputTokens,
        effectiveUpper,
      ),
      maxOutputTokensUpperLimit: effectiveUpper,
      maxOutputTokensCappedDefault: true,
    };
  }
  return {
    ...metadata,
    maxOutputTokens: boundedOutputTokens(
      metadata.maxOutputTokens,
      effectiveUpper,
    ),
    maxOutputTokensUpperLimit: effectiveUpper,
  };
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

/** Whether endpoint discovery, rather than Core's fixed catalog, owns model IDs. */
export function hasDynamicProviderModelCatalog(
  config: AgenCConfig,
  provider: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  // Venice's and abliteration.ai's IDs come from their /models lists and
  // Ollama Cloud's from its /api/tags list; the bundled snapshots are only the
  // offline fallback, so an ID missing from them is not a typo.
  const identity = normalizeMetadataProviderIdentity(provider);
  if (identity === "venice" || identity === "ollama-cloud" || identity === "abliteration") return true;
  return shouldPreferDynamicMetadata({ config, provider, model: "" }, env);
}

function shouldPreferDynamicMetadata(
  params: LookupParams,
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  const provider = normalizeMetadataProviderIdentity(params.provider);
  // Z.AI's curated catalog is authoritative even when an operator overrides
  // the API base URL. `/models` remains a credential health probe, but its
  // list does not replace exact context/output limits here. abliteration.ai's
  // own list reaches its catalog rows through discovery.
  if (provider === "zai" || provider === "zai-coding-plan" || provider === "ollama-cloud" || provider === "abliteration") return false;
  return provider === "openrouter" || shouldQueryLiveEndpoint(params, env);
}

function shouldQueryLiveEndpoint(
  params: LookupParams,
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  const provider = normalizeMetadataProviderIdentity(params.provider);
  return (
    provider === "lmstudio" ||
    provider === "openai-compatible" ||
    provider === "ollama" ||
    provider === "ollama-cloud" ||
    hasCustomProviderBaseUrl(
      provider,
      providerBaseUrl(params.config, provider, env),
    )
  );
}

function hasCustomProviderBaseUrl(
  provider: string,
  baseUrl: string | undefined,
): boolean {
  if (!baseUrl?.trim()) return false;
  const defaultBaseUrl = defaultProviderBaseUrl(provider);
  if (!defaultBaseUrl) return true;
  try {
    const configured = new URL(baseUrl.trim());
    const official = new URL(defaultBaseUrl);
    const path = (url: URL) => url.pathname.replace(/\/+$/, "") || "/";
    return configured.protocol !== official.protocol ||
      configured.hostname !== official.hostname ||
      configured.port !== official.port ||
      path(configured) !== path(official) ||
      configured.username !== official.username ||
      configured.password !== official.password ||
      configured.search !== official.search ||
      configured.hash !== official.hash;
  } catch {
    return true;
  }
}

function shouldPreferLiveEndpointOverExplicit(
  params: LookupParams,
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return (
    normalizeMetadataProviderIdentity(params.provider) === "openai-compatible" &&
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
        ...(explicit.maxOutputTokensCappedDefault !== undefined
          ? {
            maxOutputTokensCappedDefault:
              explicit.maxOutputTokensCappedDefault,
          }
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
          ...(live.maxOutputTokensCappedDefault !== undefined
            ? {
              maxOutputTokensCappedDefault:
                live.maxOutputTokensCappedDefault,
            }
            : {}),
        }
        : {}),
  };
}

function readExplicitConfigMetadata(
  params: LookupParams,
): ModelMetadataValues {
  const provider = normalizeMetadataProviderIdentity(params.provider);
  const providerConfig = readProviderConfig(params.config, provider) as
    | Record<string, unknown>
    | undefined;
  const explicitContextWindow = readPositiveInteger(
    providerConfig,
    "context_window_tokens",
    "contextWindowTokens",
  );
  const catalogMaxContextWindow = resolveModelCatalogMetadata({
    provider,
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
  "meta",
  "qwen",
  "qwen-token-plan",
  "cerebras",
  "ollama-cloud",
  "zai",
  "zai-coding-plan",
  "kimi",
  "gemini",
  "ollama",
]);

function inferBuiltInMetadata(
  provider: string,
  model: string,
): ModelMetadataValues | undefined {
  const normalizedProvider = normalizeMetadataProviderIdentity(provider);
  const normalizedModel = model.trim().toLowerCase();
  const catalog = resolveModelCatalogMetadata({
    provider: normalizedProvider,
    model,
  });
  if (hasAnyMetadata(catalog)) {
    if (
      normalizedProvider === "kimi" &&
      /^kimi-k2\.(?:7-code(?:-highspeed)?|6)$/u.test(normalizedModel)
    ) {
      // Moonshot recommends 32,768 output tokens for long thinking tasks but
      // does not publish a K2.x model maximum. Keep that as the runtime
      // reservation while retaining the existing 64k harness safety ceiling;
      // the curated catalog deliberately does not claim an upstream maximum.
      return {
        ...catalog,
        maxOutputTokens: 32_768,
        maxOutputTokensUpperLimit: DEFAULT_MAX_OUTPUT_TOKENS_UPPER_LIMIT,
      };
    }
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

/**
 * llama.cpp nests the window inside `meta` where the flat lookup never sees
 * it, and reports both what the server loaded (`n_ctx`) and what the model was
 * trained for (`n_ctx_train`). The loaded one wins: `llama-server -c 4096` on
 * a 32k model refuses at 4097, so the trained maximum is not a usable budget.
 */
function servedContextWindow(
  record: Record<string, unknown>,
): number | undefined {
  const meta = asRecord(record.meta);
  if (!meta) return undefined;
  return readPositiveInteger(meta, "n_ctx") ??
    readPositiveInteger(meta, "n_ctx_train");
}

function metadataFromGenericRecord(
  record: Record<string, unknown>,
): ModelMetadataValues {
  const topProvider = asRecord(record.top_provider);
  return {
    // The served window is checked before the model's advertised maximum: a
    // local server refuses anything past what it actually loaded. DeepSeek's
    // /models names the advertised window `context_window`.
    ...(servedContextWindow(record) !== undefined
      ? { contextWindow: servedContextWindow(record) }
      : readPositiveInteger(
        record,
        "max_model_len",
        "context_length",
        "context_window",
        "max_context_length",
        "max_input_tokens",
        "max_tokens",
      ) !== undefined
        ? {
          contextWindow: readPositiveInteger(
            record,
            "max_model_len",
            "context_length",
            "context_window",
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
  const normalized = normalizeMetadataProviderIdentity(provider);
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

function normalizeMetadataProviderIdentity(provider: string): string {
  return normalizeProviderMetadataIdentity(provider) ?? "";
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

function isLocalOllamaCompatibleEndpoint(
  provider: string,
  baseUrl: string,
): boolean {
  if (provider !== "openai-compatible" && provider !== "lmstudio") {
    return false;
  }
  try {
    const url = new URL(baseUrl);
    return url.port === "11434" &&
      (url.hostname === "localhost" ||
        url.hostname === "[::1]" ||
        /^127\./.test(url.hostname));
  } catch {
    return false;
  }
}

/**
 * Ollama's native API sits at the origin while its OpenAI-compatible surface
 * lives under `/v1`, so a base URL configured for either one has to collapse
 * to the same `/api/show`.
 */
export function ollamaShowUrlFromBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  const origin = trimmed.replace(/\/(?:v\d+(?:beta)?|api\/v\d+)$/i, "");
  return `${origin}/api/show`;
}

function metadataFromOllamaShowResponse(
  response: unknown,
): ModelMetadataValues | undefined {
  const modelInfo = asRecord(asRecord(response)?.model_info);
  if (!modelInfo) return undefined;
  // The key is architecture-prefixed (`qwen2.context_length`, `phi2.…`), and
  // the architecture is not knowable from the model name, so match the suffix.
  for (const [key, value] of Object.entries(modelInfo)) {
    if (!/(?:^|\.)context_length$/.test(key)) continue;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
      continue;
    }
    return { contextWindow: value };
  }
  return undefined;
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
  provider: string,
  config: AgenCConfig,
  env: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> | undefined {
  const credential = resolveProviderApiKeyEnvironment(provider, env);
  if (
    provider === "openai-compatible" &&
    credential?.envVar === "OPENAI_API_KEY" &&
    !allowsOpenAICompatibleKeyFallback(
      envBaseUrl(provider, env) ?? readProviderConfig(config, provider)?.base_url?.trim(),
    )
  ) return undefined;
  return credential ? { Authorization: `Bearer ${credential.value}` } : undefined;
}

function envBaseUrl(
  provider: string,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  return resolveProviderBaseURLEnvironment(provider, env)?.value;
}

function defaultProviderBaseUrl(provider: string): string | undefined {
  return resolveBuiltInProviderInfo(provider)?.baseURL;
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

/**
 * Largest share of a context window an output reservation may claim.
 *
 * The reservation and the prompt come out of the same window, so a default
 * that claims most of it leaves no room to be prompted at all.
 */
export const MAX_OUTPUT_TOKENS_WINDOW_FRACTION = 0.5;

/**
 * Hold an output reservation inside the window it has to share with a prompt.
 *
 * `getModelMaxOutputTokens` picks the reservation from the model name and
 * never sees the context window, so an uncatalogued model takes the 32,000
 * default whatever its window is. On a local runtime that window is routinely
 * 32k, and admission compares prompt + reservation against it: 32,000 reserved
 * against a measured 31,129-token window is refused before a single byte of
 * prompt exists, so every turn is denied `context_window_exceeded` and no
 * local model can answer at all.
 *
 * Half is the split, so the prompt always has as much of the window as the
 * answer. Nothing catalogued moves: this only binds when the reservation is
 * more than half the window, which for the 32,000 default means windows under
 * 64k, and every catalogued hosted model is 128k or larger. It is the models
 * with no catalogue entry, which is every local one, that this rescues.
 */
export function fitOutputTokensToContextWindow(
  maxOutputTokens: number,
  contextWindow: number | undefined,
): number {
  if (
    contextWindow === undefined ||
    !Number.isFinite(contextWindow) ||
    contextWindow <= 0
  ) {
    return maxOutputTokens;
  }
  const cap = Math.floor(contextWindow * MAX_OUTPUT_TOKENS_WINDOW_FRACTION);
  // A window too small to halve is already unusable; never return 0, which
  // reads downstream as "no reservation configured" rather than a small one.
  return Math.max(1, Math.min(maxOutputTokens, cap));
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
  const fit = (tokens: number): number =>
    fitOutputTokensToContextWindow(tokens, metadata.contextWindow);

  if (
    metadata.maxOutputTokens !== undefined &&
    metadata.maxOutputTokensExplicit === true
  ) {
    return {
      maxOutputTokens: fit(
        boundedOutputTokens(metadata.maxOutputTokens, metadataUpper),
      ),
      maxOutputTokensUpperLimit: metadataUpper,
      maxOutputTokensExplicit: true,
      maxOutputTokensCappedDefault: false,
    };
  }

  const configOverride = normalizePositiveInteger(params.config.max_output_tokens);
  const envOverride = readEnvMaxOutputTokens(params.env, params.onWarn);
  const explicitOverride = envOverride ?? configOverride;
  if (explicitOverride !== undefined) {
    return {
      maxOutputTokens: fit(
        boundedOutputTokens(explicitOverride, metadataUpper),
      ),
      maxOutputTokensUpperLimit: metadataUpper,
      maxOutputTokensExplicit: true,
      maxOutputTokensCappedDefault: false,
    };
  }

  if (
    metadata.maxOutputTokensCappedDefault === true ||
    params.config.capped_default_max_output_tokens === true
  ) {
    return {
      maxOutputTokens: fit(
        boundedOutputTokens(
          metadata.maxOutputTokensCappedDefault === true
            ? metadataDefault
            : CAPPED_DEFAULT_MAX_OUTPUT_TOKENS,
          metadataUpper,
        ),
      ),
      maxOutputTokensUpperLimit: metadataUpper,
      maxOutputTokensExplicit: false,
      maxOutputTokensCappedDefault: true,
    };
  }

  return {
    maxOutputTokens: fit(boundedOutputTokens(metadataDefault, metadataUpper)),
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
