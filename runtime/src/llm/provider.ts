/**
 * Provider factory — single entrypoint for provider construction.
 *
 * @module
 */

import { resolveApiKey } from "./_deps/env.js";
import type { AuthBackend, AuthSubscriptionTier } from "../auth/backend.js";
import { AgenCProvider } from "./providers/agenc/index.js";
import { GrokProvider } from "./providers/grok/index.js";
import type { GrokProviderConfig } from "./providers/grok/index.js";
import { OllamaProvider } from "./providers/ollama/index.js";
import type { OllamaProviderConfig } from "./providers/ollama/index.js";
import type { LLMProvider, LLMProviderConfig, LLMTool } from "./types.js";
import { OpenAIProvider } from "./providers/openai/index.js";
import type { OpenAIProviderConfig } from "./providers/openai/index.js";
import { AnthropicProvider } from "./providers/anthropic/index.js";
import type { AnthropicProviderConfig } from "./providers/anthropic/index.js";
import { GeminiProvider } from "./providers/gemini/index.js";
import { LMStudioProvider } from "./providers/lmstudio/index.js";
import { OpenRouterProvider } from "./providers/openrouter/index.js";
import { GroqProvider } from "./providers/groq/index.js";
import { DeepSeekProvider } from "./providers/deepseek/index.js";
import type { ProviderFallbackLadderOptions } from "./api/fallback-ladder.js";

export type ProviderName =
  | "grok"
  | "openai"
  | "anthropic"
  | "ollama"
  | "lmstudio"
  | "openrouter"
  | "groq"
  | "deepseek"
  | "gemini"
  | "agenc";

export interface ProviderFactoryOptions {
  readonly apiKey?: string;
  readonly baseURL?: string;
  readonly model?: string;
  readonly tools?: ReadonlyArray<LLMTool>;
  readonly timeoutMs?: number;
  readonly extra?: Record<string, unknown>;
}

export const FACTORY_PROVIDER_MARKER = Symbol.for("agenc.factoryProvider");
export const FACTORY_PROVIDER_STATE = Symbol.for("agenc.factoryProviderState");

type FactoryMarkedProvider = LLMProvider & {
  [FACTORY_PROVIDER_MARKER]?: true;
  [FACTORY_PROVIDER_STATE]?: ProviderRuntimeState;
};

export const KNOWN_PROVIDER_NAMES = [
  "grok",
  "openai",
  "anthropic",
  "ollama",
  "lmstudio",
  "openrouter",
  "groq",
  "deepseek",
  "gemini",
  "agenc",
] as const satisfies readonly ProviderName[];

export interface PreparedProviderSwitch {
  readonly provider: ProviderName;
  readonly model: string;
  readonly instance: LLMProvider;
}

export interface ProviderRuntimeState {
  readonly provider: ProviderName;
  readonly options: ProviderFactoryOptions;
}

const DOCUMENTED_PROVIDER_DEFAULT_MODELS = {
  grok: "grok-4-fast",
  openai: "gpt-5",
  anthropic: "claude-opus-4-7",
  ollama: "llama3.3",
  deepseek: "deepseek-reasoner",
  gemini: "gemini-2.5-pro",
  agenc: "agenc",
} as const;

type ProviderRuntimeExtra = Partial<
  Omit<LLMProviderConfig, "model" | "tools" | "timeoutMs">
> & {
  readonly organization?: string;
  readonly project?: string;
  readonly useResponsesApi?: boolean;
  readonly store?: boolean;
  readonly authMode?: "api_key" | "oauth";
  readonly oauth?: Record<string, unknown>;
  readonly defaultHeaders?: Readonly<Record<string, string>>;
  readonly fetchImpl?: typeof fetch;
  readonly anthropicVersion?: string;
  readonly betaHeaders?: readonly string[];
  readonly contextManagement?: Record<string, unknown>;
  readonly contextWindowTokens?: number;
  readonly parallelToolCalls?: boolean;
  readonly visionModel?: string;
  readonly webSearch?: boolean;
  readonly searchMode?: "auto" | "on" | "off";
  readonly webSearchOptions?: Record<string, unknown>;
  readonly xSearch?: boolean;
  readonly xSearchOptions?: Record<string, unknown>;
  readonly codeExecution?: boolean;
  readonly collectionsSearch?: Record<string, unknown>;
  readonly remoteMcp?: Record<string, unknown>;
  readonly keepAlive?: string;
  readonly numCtx?: number;
  readonly numGpu?: number;
  readonly providerFallback?: ProviderFallbackLadderOptions;
  readonly emitWarning?: LLMProviderConfig["emitWarning"];
  readonly emitDiagnostic?: LLMProviderConfig["emitDiagnostic"];
  readonly onCapabilityDrift?: LLMProviderConfig["onCapabilityDrift"];
};

const PROVIDER_RUNTIME_EXTRA_KEYS = [
  "systemPrompt",
  "temperature",
  "maxTokens",
  "maxToolRounds",
  "maxRetries",
  "retryDelayMs",
  "providerFallback",
  "toolHandler",
  "organization",
  "project",
  "useResponsesApi",
  "store",
  "authMode",
  "oauth",
  "defaultHeaders",
  "fetchImpl",
  "anthropicVersion",
  "betaHeaders",
  "contextManagement",
  "contextWindowTokens",
  "parallelToolCalls",
  "visionModel",
  "webSearch",
  "searchMode",
  "webSearchOptions",
  "xSearch",
  "xSearchOptions",
  "codeExecution",
  "collectionsSearch",
  "remoteMcp",
  "keepAlive",
  "numCtx",
  "numGpu",
  "emitWarning",
  "emitDiagnostic",
  "onCapabilityDrift",
] as const satisfies readonly (keyof ProviderRuntimeExtra)[];

export function isFactoryProvider(provider: LLMProvider): boolean {
  return (provider as FactoryMarkedProvider)[FACTORY_PROVIDER_MARKER] === true;
}

export function readProviderIdentity(
  provider: LLMProvider | undefined,
  fallbackProvider?: string,
): ProviderName | null {
  if (!provider) {
    return normalizeProviderName(fallbackProvider);
  }
  const storedState = (provider as FactoryMarkedProvider)[FACTORY_PROVIDER_STATE];
  if (storedState) {
    return storedState.provider;
  }
  return normalizeProviderName(fallbackProvider ?? provider.name);
}

export function readProviderFactoryOptions(
  provider: LLMProvider,
): ProviderFactoryOptions {
  const storedState = (provider as FactoryMarkedProvider)[FACTORY_PROVIDER_STATE];
  if (storedState) {
    return cloneProviderFactoryOptions(storedState.options);
  }
  const config = (
    provider as unknown as {
      config?: Record<string, unknown>;
    }
  ).config;
  const extra = readProviderRuntimeExtra(config);
  return {
    ...(firstNonEmpty(readString(config, "apiKey"))
      ? { apiKey: firstNonEmpty(readString(config, "apiKey")) }
      : {}),
    ...(firstNonEmpty(readString(config, "baseURL"), readString(config, "host"))
      ? {
        baseURL: firstNonEmpty(
          readString(config, "baseURL"),
          readString(config, "host"),
        ),
      }
      : {}),
    ...(firstNonEmpty(readString(config, "model"))
      ? { model: firstNonEmpty(readString(config, "model")) }
      : {}),
    ...(readNumber(config, "timeoutMs") !== undefined
      ? { timeoutMs: readNumber(config, "timeoutMs") }
      : {}),
    ...(extra ? { extra } : {}),
  };
}

function markFactoryProvider<T extends LLMProvider>(
  provider: T,
  state: ProviderRuntimeState,
): T {
  Object.defineProperty(provider, FACTORY_PROVIDER_MARKER, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  Object.defineProperty(provider, FACTORY_PROVIDER_STATE, {
    value: {
      provider: state.provider,
      options: cloneProviderFactoryOptions(state.options),
    },
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return provider;
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function requireModel(
  provider: ProviderName,
  explicitModel: string | undefined,
  envModel: string | undefined,
  envVarName: string,
  fallbackModel?: string,
): string {
  const model = firstNonEmpty(explicitModel, envModel, fallbackModel);
  if (!model) {
    throw new Error(
      `${provider} provider requires model — set ${envVarName} or pass model in factory options`,
    );
  }
  return model;
}

function requireApiKey(
  provider: ProviderName,
  explicitApiKey: string | undefined,
  envVarName: string,
  ...envCandidates: Array<string | undefined>
): string {
  const apiKey = firstNonEmpty(explicitApiKey, ...envCandidates);
  if (!apiKey) {
    throw new Error(
      `${provider} provider requires apiKey — set ${envVarName} or pass apiKey in factory options`,
    );
  }
  return apiKey;
}

function normalizeBaseURL(baseURL: string | undefined): string | undefined {
  return firstNonEmpty(baseURL);
}

function normalizeOllamaHost(baseURL: string | undefined): string | undefined {
  const normalized = normalizeBaseURL(baseURL);
  if (!normalized) return undefined;
  return normalized.replace(/\/v1\/?$/i, "");
}

function cloneExtraValue(value: unknown): unknown {
  if (Array.isArray(value)) return [...value];
  if (value && typeof value === "object") return { ...value };
  return value;
}

function cloneProviderFactoryOptions(
  options: ProviderFactoryOptions,
): ProviderFactoryOptions {
  return {
    ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
    ...(options.baseURL !== undefined ? { baseURL: options.baseURL } : {}),
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(options.tools ? { tools: [...options.tools] } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.extra
      ? {
        extra: Object.fromEntries(
          Object.entries(options.extra).map(([key, value]) => [
            key,
            cloneExtraValue(value),
          ]),
        ),
      }
      : {}),
  };
}

function readString(
  source: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = source?.[key];
  return typeof value === "string" ? value : undefined;
}

function readNumber(
  source: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = source?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readBoolean(
  source: Record<string, unknown> | undefined,
  key: string,
): boolean | undefined {
  const value = source?.[key];
  return typeof value === "boolean" ? value : undefined;
}

function readStringRecord(
  source: Record<string, unknown> | undefined,
  key: string,
): Readonly<Record<string, string>> | undefined {
  const value = source?.[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value);
  if (entries.some(([, entry]) => typeof entry !== "string")) return undefined;
  return Object.fromEntries(entries) as Readonly<Record<string, string>>;
}

function readStringArray(
  source: Record<string, unknown> | undefined,
  key: string,
): readonly string[] | undefined {
  const value = source?.[key];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    return undefined;
  }
  return [...value];
}

function readRecord(
  source: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  const value = source?.[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return { ...value };
}

function readProviderFallback(
  source: Record<string, unknown> | undefined,
): ProviderFallbackLadderOptions | undefined {
  const value = readRecord(source, "providerFallback");
  if (!value || typeof value.model !== "string") return undefined;
  return value as unknown as ProviderFallbackLadderOptions;
}

function readProviderRuntimeExtra(
  source: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!source) return undefined;
  const extra: Record<string, unknown> = {};
  for (const key of PROVIDER_RUNTIME_EXTRA_KEYS) {
    if (!(key in source)) continue;
    const value = source[key];
    if (value === undefined) continue;
    extra[key] = cloneExtraValue(value);
  }
  return Object.keys(extra).length > 0 ? extra : undefined;
}

function readRuntimeExtra(
  extra: Record<string, unknown> | undefined,
): ProviderRuntimeExtra {
  const providerFallback = readProviderFallback(extra);
  return {
    ...(readString(extra, "systemPrompt") !== undefined
      ? { systemPrompt: readString(extra, "systemPrompt") }
      : {}),
    ...(readNumber(extra, "temperature") !== undefined
      ? { temperature: readNumber(extra, "temperature") }
      : {}),
    ...(readNumber(extra, "maxTokens") !== undefined
      ? { maxTokens: readNumber(extra, "maxTokens") }
      : {}),
    ...(readNumber(extra, "maxToolRounds") !== undefined
      ? { maxToolRounds: readNumber(extra, "maxToolRounds") }
      : {}),
    ...(readNumber(extra, "maxRetries") !== undefined
      ? { maxRetries: readNumber(extra, "maxRetries") }
      : {}),
    ...(readNumber(extra, "retryDelayMs") !== undefined
      ? { retryDelayMs: readNumber(extra, "retryDelayMs") }
      : {}),
    ...(providerFallback !== undefined
      ? { providerFallback }
      : {}),
    ...(extra?.toolHandler ? { toolHandler: extra.toolHandler as LLMProviderConfig["toolHandler"] } : {}),
    ...(readString(extra, "organization") !== undefined
      ? { organization: readString(extra, "organization") }
      : {}),
    ...(readString(extra, "project") !== undefined
      ? { project: readString(extra, "project") }
      : {}),
    ...(readBoolean(extra, "useResponsesApi") !== undefined
      ? { useResponsesApi: readBoolean(extra, "useResponsesApi") }
      : {}),
    ...(readBoolean(extra, "store") !== undefined
      ? { store: readBoolean(extra, "store") }
      : {}),
    ...(readString(extra, "authMode") === "api_key" ||
    readString(extra, "authMode") === "oauth"
      ? {
        authMode: readString(extra, "authMode") as
          | "api_key"
          | "oauth",
      }
      : {}),
    ...(readRecord(extra, "oauth") ? { oauth: readRecord(extra, "oauth") } : {}),
    ...(readStringRecord(extra, "defaultHeaders")
      ? { defaultHeaders: readStringRecord(extra, "defaultHeaders") }
      : {}),
    ...(extra?.fetchImpl ? { fetchImpl: extra.fetchImpl as typeof fetch } : {}),
    ...(readString(extra, "anthropicVersion") !== undefined
      ? { anthropicVersion: readString(extra, "anthropicVersion") }
      : {}),
    ...(readStringArray(extra, "betaHeaders")
      ? { betaHeaders: readStringArray(extra, "betaHeaders") }
      : {}),
    ...(readRecord(extra, "contextManagement")
      ? { contextManagement: readRecord(extra, "contextManagement") }
      : {}),
    ...(readNumber(extra, "contextWindowTokens") !== undefined
      ? { contextWindowTokens: readNumber(extra, "contextWindowTokens") }
      : {}),
    ...(readBoolean(extra, "parallelToolCalls") !== undefined
      ? { parallelToolCalls: readBoolean(extra, "parallelToolCalls") }
      : {}),
    ...(readString(extra, "visionModel") !== undefined
      ? { visionModel: readString(extra, "visionModel") }
      : {}),
    ...(readBoolean(extra, "webSearch") !== undefined
      ? { webSearch: readBoolean(extra, "webSearch") }
      : {}),
    ...(readString(extra, "searchMode") === "auto" ||
    readString(extra, "searchMode") === "on" ||
    readString(extra, "searchMode") === "off"
      ? {
        searchMode: readString(extra, "searchMode") as "auto" | "on" | "off",
      }
      : {}),
    ...(readRecord(extra, "webSearchOptions")
      ? { webSearchOptions: readRecord(extra, "webSearchOptions") }
      : {}),
    ...(readBoolean(extra, "xSearch") !== undefined
      ? { xSearch: readBoolean(extra, "xSearch") }
      : {}),
    ...(readRecord(extra, "xSearchOptions")
      ? { xSearchOptions: readRecord(extra, "xSearchOptions") }
      : {}),
    ...(readBoolean(extra, "codeExecution") !== undefined
      ? { codeExecution: readBoolean(extra, "codeExecution") }
      : {}),
    ...(readRecord(extra, "collectionsSearch")
      ? { collectionsSearch: readRecord(extra, "collectionsSearch") }
      : {}),
    ...(readRecord(extra, "remoteMcp")
      ? { remoteMcp: readRecord(extra, "remoteMcp") }
      : {}),
    ...(readString(extra, "keepAlive") !== undefined
      ? { keepAlive: readString(extra, "keepAlive") }
      : {}),
    ...(readNumber(extra, "numCtx") !== undefined
      ? { numCtx: readNumber(extra, "numCtx") }
      : {}),
    ...(readNumber(extra, "numGpu") !== undefined
      ? { numGpu: readNumber(extra, "numGpu") }
      : {}),
    ...(typeof extra?.emitWarning === "function"
      ? { emitWarning: extra.emitWarning as LLMProviderConfig["emitWarning"] }
      : {}),
    ...(typeof extra?.emitDiagnostic === "function"
      ? {
        emitDiagnostic:
          extra.emitDiagnostic as LLMProviderConfig["emitDiagnostic"],
      }
      : {}),
    ...(typeof extra?.onCapabilityDrift === "function"
      ? {
        onCapabilityDrift:
          extra.onCapabilityDrift as LLMProviderConfig["onCapabilityDrift"],
      }
      : {}),
  };
}

function readAuthBackendExtra(
  extra: Record<string, unknown> | undefined,
): AuthBackend | undefined {
  const value = extra?.authBackend;
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<Record<keyof AuthBackend, unknown>>;
  return typeof candidate.login === "function" &&
    typeof candidate.logout === "function" &&
    typeof candidate.whoami === "function" &&
    typeof candidate.vendKey === "function" &&
    typeof candidate.inferAgencModel === "function" &&
    typeof candidate.getSubscriptionTier === "function"
    ? (value as AuthBackend)
    : undefined;
}

function readAuthSubscriptionTierExtra(
  extra: Record<string, unknown> | undefined,
): AuthSubscriptionTier | undefined {
  const value = readString(extra, "subscriptionTier");
  switch (value) {
    case "free":
    case "pro":
    case "team":
    case "enterprise":
      return value;
    default:
      return undefined;
  }
}

function stripAgenCProviderRuntimeExtra(
  extra: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!extra) return undefined;
  const stripped = Object.fromEntries(
    Object.entries(extra)
      .filter(
        ([key]) =>
          key !== "authBackend" &&
          key !== "sessionId" &&
          key !== "subscriptionTier",
      )
      .map(([key, value]) => [key, cloneExtraValue(value)]),
  );
  return Object.keys(stripped).length > 0 ? stripped : undefined;
}

function buildCommonConfig(
  extra: ProviderRuntimeExtra,
): Omit<LLMProviderConfig, "model" | "tools" | "timeoutMs"> {
  return {
    ...(extra.systemPrompt !== undefined
      ? { systemPrompt: extra.systemPrompt }
      : {}),
    ...(extra.temperature !== undefined
      ? { temperature: extra.temperature }
      : {}),
    ...(extra.maxTokens !== undefined ? { maxTokens: extra.maxTokens } : {}),
    ...(extra.maxToolRounds !== undefined
      ? { maxToolRounds: extra.maxToolRounds }
      : {}),
    ...(extra.maxRetries !== undefined ? { maxRetries: extra.maxRetries } : {}),
    ...(extra.retryDelayMs !== undefined
      ? { retryDelayMs: extra.retryDelayMs }
      : {}),
    ...(extra.providerFallback !== undefined
      ? { providerFallback: extra.providerFallback }
      : {}),
    ...(extra.toolHandler !== undefined
      ? { toolHandler: extra.toolHandler }
      : {}),
    ...(extra.emitWarning !== undefined
      ? { emitWarning: extra.emitWarning }
      : {}),
    ...(extra.emitDiagnostic !== undefined
      ? { emitDiagnostic: extra.emitDiagnostic }
      : {}),
    ...(extra.onCapabilityDrift !== undefined
      ? { onCapabilityDrift: extra.onCapabilityDrift }
      : {}),
  };
}

function buildOpenAICompatibleProvider(
  provider: Extract<
    ProviderName,
    "lmstudio" | "openrouter" | "groq" | "deepseek"
  >,
  opts: ProviderFactoryOptions,
  input: {
    readonly defaultBaseURL: string;
    readonly envBaseURL?: string;
    readonly envModel?: string;
    readonly envModelLabel: string;
    readonly defaultModel?: string;
    readonly envApiKey?: string;
    readonly alternateApiKeys?: readonly string[];
    readonly apiKeyMode: "required" | "optional";
    readonly apiKeyEnvLabel: string;
    readonly useResponsesApi: boolean;
    readonly providerCtor?: new (config: OpenAIProviderConfig) => LLMProvider;
  },
): LLMProvider {
  const extra = readRuntimeExtra(opts.extra);
  const model = requireModel(
    provider,
    opts.model,
    input.envModel,
    input.envModelLabel,
    input.defaultModel,
  );
  const oauthConfig =
    extra.authMode === "oauth" &&
    extra.oauth &&
    typeof extra.oauth.accessToken === "string" &&
    extra.oauth.accessToken.trim().length > 0
      ? (extra.oauth as unknown as OpenAIProviderConfig["oauth"])
      : undefined;
  const apiKey = oauthConfig
    ? firstNonEmpty(opts.apiKey, input.envApiKey, ...(input.alternateApiKeys ?? []))
    : input.apiKeyMode === "required"
    ? requireApiKey(
      provider,
      opts.apiKey,
      input.apiKeyEnvLabel,
      input.envApiKey,
      ...(input.alternateApiKeys ?? []),
    )
    : firstNonEmpty(
      opts.apiKey,
      input.envApiKey,
      ...(input.alternateApiKeys ?? []),
    );

  const cfg: OpenAIProviderConfig = {
    ...buildCommonConfig(extra),
    ...(apiKey !== undefined ? { apiKey } : {}),
    model,
    providerName: provider,
    apiKeyEnvLabel: input.apiKeyEnvLabel,
    tools: opts.tools ? [...opts.tools] : undefined,
    baseURL:
      normalizeBaseURL(opts.baseURL) ??
      normalizeBaseURL(input.envBaseURL) ??
      input.defaultBaseURL,
    useResponsesApi: extra.useResponsesApi ?? input.useResponsesApi,
    ...(extra.store !== undefined ? { store: extra.store } : {}),
    ...(extra.contextWindowTokens !== undefined
      ? { contextWindowTokens: extra.contextWindowTokens }
      : {}),
    ...(extra.authMode ? { authMode: extra.authMode } : {}),
    ...(oauthConfig ? { oauth: oauthConfig } : {}),
    ...(extra.defaultHeaders ? { defaultHeaders: extra.defaultHeaders } : {}),
    ...(extra.fetchImpl ? { fetchImpl: extra.fetchImpl } : {}),
    ...(extra.organization ? { organization: extra.organization } : {}),
    ...(extra.project ? { project: extra.project } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  };
  const ProviderCtor = input.providerCtor ?? OpenAIProvider;
  return markFactoryProvider(new ProviderCtor(cfg), {
    provider,
    options: {
      ...(apiKey !== undefined ? { apiKey } : {}),
      baseURL: cfg.baseURL,
      model,
      ...(cfg.timeoutMs !== undefined ? { timeoutMs: cfg.timeoutMs } : {}),
      ...(readProviderRuntimeExtra(cfg as unknown as Record<string, unknown>)
        ? { extra: readProviderRuntimeExtra(cfg as unknown as Record<string, unknown>) }
        : {}),
    },
  });
}

export function normalizeProviderName(
  provider: string | undefined,
): ProviderName | null {
  const raw = firstNonEmpty(provider)?.toLowerCase() ?? "";
  if (raw === "xai") {
    return "grok";
  }
  return (KNOWN_PROVIDER_NAMES as readonly string[]).includes(raw)
    ? (raw as ProviderName)
    : null;
}

export function createProvider(
  name: ProviderName,
  opts: ProviderFactoryOptions,
): LLMProvider {
  const extra = readRuntimeExtra(opts.extra);
  switch (name) {
    case "agenc": {
      const authBackend = readAuthBackendExtra(opts.extra);
      if (authBackend === undefined) {
        throw new Error(
          "agenc provider requires authBackend in factory options extra",
        );
      }
      const sessionId = firstNonEmpty(readString(opts.extra, "sessionId"));
      if (sessionId === undefined) {
        throw new Error(
          "agenc provider requires sessionId in factory options extra",
        );
      }
      const model = requireModel(
        "agenc",
        opts.model,
        process.env.AGENC_MODEL,
        "AGENC_MODEL",
        DOCUMENTED_PROVIDER_DEFAULT_MODELS.agenc,
      );
      const providerExtra = stripAgenCProviderRuntimeExtra(opts.extra);
      const provider = markFactoryProvider(
        new AgenCProvider({
          ...buildCommonConfig(extra),
          authBackend,
          sessionId,
          ...(readAuthSubscriptionTierExtra(opts.extra) !== undefined
            ? { subscriptionTier: readAuthSubscriptionTierExtra(opts.extra) }
            : {}),
          model,
          tools: opts.tools ? [...opts.tools] : undefined,
          ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
          providerFactory: (concreteProvider, providerOptions) =>
            createProvider(concreteProvider, providerOptions),
          ...(opts.baseURL !== undefined || providerExtra !== undefined
            ? {
              providerOptions: {
                ...(opts.baseURL !== undefined ? { baseURL: opts.baseURL } : {}),
                ...(providerExtra !== undefined ? { extra: providerExtra } : {}),
              },
            }
            : {}),
        }),
        {
          provider: "agenc",
          options: {
            ...(opts.baseURL !== undefined ? { baseURL: opts.baseURL } : {}),
            model,
            ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
            ...(providerExtra !== undefined ? { extra: providerExtra } : {}),
          },
        },
      );
      return provider;
    }
    case "grok": {
      const apiKey = opts.apiKey ?? resolveApiKey(process.env);
      if (!apiKey) {
        throw new Error(
          "grok provider requires apiKey — set XAI_API_KEY in the environment",
        );
      }
      const model = requireModel(
        "grok",
        opts.model,
        process.env.AGENC_MODEL,
        "AGENC_MODEL",
      );
      const cfg: GrokProviderConfig = {
        ...buildCommonConfig(extra),
        apiKey,
        model,
        tools: opts.tools ? [...opts.tools] : undefined,
        ...(opts.baseURL !== undefined ? { baseURL: opts.baseURL } : {}),
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        ...(extra.contextWindowTokens !== undefined
          ? { contextWindowTokens: extra.contextWindowTokens }
          : {}),
        ...(extra.parallelToolCalls !== undefined
          ? { parallelToolCalls: extra.parallelToolCalls }
          : {}),
        ...(extra.visionModel ? { visionModel: extra.visionModel } : {}),
        ...(extra.webSearch !== undefined ? { webSearch: extra.webSearch } : {}),
        ...(extra.searchMode ? { searchMode: extra.searchMode } : {}),
        ...(extra.webSearchOptions
          ? { webSearchOptions: extra.webSearchOptions }
          : {}),
        ...(extra.xSearch !== undefined ? { xSearch: extra.xSearch } : {}),
        ...(extra.xSearchOptions ? { xSearchOptions: extra.xSearchOptions } : {}),
        ...(extra.codeExecution !== undefined
          ? { codeExecution: extra.codeExecution }
          : {}),
        ...(extra.collectionsSearch
          ? { collectionsSearch: extra.collectionsSearch }
          : {}),
        ...(extra.remoteMcp ? { remoteMcp: extra.remoteMcp } : {}),
      };
      return markFactoryProvider(new GrokProvider(cfg), {
        provider: "grok",
        options: {
          apiKey,
          ...(cfg.baseURL !== undefined ? { baseURL: cfg.baseURL } : {}),
          model,
          ...(cfg.timeoutMs !== undefined ? { timeoutMs: cfg.timeoutMs } : {}),
          ...(readProviderRuntimeExtra(cfg as unknown as Record<string, unknown>)
            ? { extra: readProviderRuntimeExtra(cfg as unknown as Record<string, unknown>) }
            : {}),
        },
      });
    }
    case "openai": {
      const model = requireModel(
        "openai",
        opts.model,
        process.env.OPENAI_MODEL,
        "OPENAI_MODEL",
        DOCUMENTED_PROVIDER_DEFAULT_MODELS.openai,
      );
      const oauthConfig =
        extra.authMode === "oauth" &&
        extra.oauth &&
        typeof extra.oauth.accessToken === "string" &&
        extra.oauth.accessToken.trim().length > 0
          ? (extra.oauth as unknown as OpenAIProviderConfig["oauth"])
          : undefined;
      const apiKey = oauthConfig
        ? firstNonEmpty(opts.apiKey, process.env.OPENAI_API_KEY)
        : requireApiKey(
          "openai",
          opts.apiKey,
          "OPENAI_API_KEY",
          process.env.OPENAI_API_KEY,
        );
      const cfg: OpenAIProviderConfig = {
        ...buildCommonConfig(extra),
        ...(apiKey !== undefined ? { apiKey } : {}),
        model,
        providerName: "openai",
        apiKeyEnvLabel: "OPENAI_API_KEY",
        tools: opts.tools ? [...opts.tools] : undefined,
        baseURL:
          normalizeBaseURL(opts.baseURL) ??
          normalizeBaseURL(process.env.OPENAI_BASE_URL) ??
          "https://api.openai.com/v1",
        useResponsesApi: extra.useResponsesApi ?? true,
        ...(extra.store !== undefined ? { store: extra.store } : {}),
        ...(extra.contextWindowTokens !== undefined
          ? { contextWindowTokens: extra.contextWindowTokens }
          : {}),
        ...(extra.authMode ? { authMode: extra.authMode } : {}),
        ...(oauthConfig ? { oauth: oauthConfig } : {}),
        ...(extra.defaultHeaders ? { defaultHeaders: extra.defaultHeaders } : {}),
        ...(extra.fetchImpl ? { fetchImpl: extra.fetchImpl } : {}),
        ...(extra.organization
          ? { organization: extra.organization }
          : process.env.OPENAI_ORGANIZATION
          ? { organization: process.env.OPENAI_ORGANIZATION }
          : {}),
        ...(extra.project
          ? { project: extra.project }
          : process.env.OPENAI_PROJECT
          ? { project: process.env.OPENAI_PROJECT }
          : {}),
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      };
      return markFactoryProvider(new OpenAIProvider(cfg), {
        provider: "openai",
        options: {
          ...(apiKey !== undefined ? { apiKey } : {}),
          baseURL: cfg.baseURL,
          model,
          ...(cfg.timeoutMs !== undefined ? { timeoutMs: cfg.timeoutMs } : {}),
          ...(readProviderRuntimeExtra(cfg as unknown as Record<string, unknown>)
            ? { extra: readProviderRuntimeExtra(cfg as unknown as Record<string, unknown>) }
            : {}),
        },
      });
    }
    case "anthropic": {
      const apiKey = requireApiKey(
        "anthropic",
        opts.apiKey,
        "ANTHROPIC_API_KEY",
        process.env.ANTHROPIC_API_KEY,
      );
      const model = requireModel(
        "anthropic",
        opts.model,
        process.env.ANTHROPIC_MODEL,
        "ANTHROPIC_MODEL",
        DOCUMENTED_PROVIDER_DEFAULT_MODELS.anthropic,
      );
      const cfg: AnthropicProviderConfig = {
        ...buildCommonConfig(extra),
        apiKey,
        model,
        tools: opts.tools ? [...opts.tools] : undefined,
        ...(normalizeBaseURL(opts.baseURL ?? process.env.ANTHROPIC_BASE_URL)
          ? {
            baseURL:
              normalizeBaseURL(opts.baseURL ?? process.env.ANTHROPIC_BASE_URL),
          }
          : {}),
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        ...(extra.anthropicVersion
          ? { anthropicVersion: extra.anthropicVersion }
          : {}),
        ...(extra.betaHeaders ? { betaHeaders: extra.betaHeaders } : {}),
        ...(extra.contextManagement
          ? { contextManagement: extra.contextManagement }
          : {}),
        ...(extra.defaultHeaders ? { defaultHeaders: extra.defaultHeaders } : {}),
        ...(extra.fetchImpl ? { fetchImpl: extra.fetchImpl } : {}),
      };
      return markFactoryProvider(new AnthropicProvider(cfg), {
        provider: "anthropic",
        options: {
          apiKey,
          ...(cfg.baseURL !== undefined ? { baseURL: cfg.baseURL } : {}),
          model,
          ...(cfg.timeoutMs !== undefined ? { timeoutMs: cfg.timeoutMs } : {}),
          ...(readProviderRuntimeExtra(cfg as unknown as Record<string, unknown>)
            ? { extra: readProviderRuntimeExtra(cfg as unknown as Record<string, unknown>) }
            : {}),
        },
      });
    }
    case "ollama": {
      const cfg: OllamaProviderConfig = {
        ...buildCommonConfig(extra),
        model: requireModel(
          "ollama",
          opts.model,
          process.env.OLLAMA_MODEL,
          "OLLAMA_MODEL",
          DOCUMENTED_PROVIDER_DEFAULT_MODELS.ollama,
        ),
        tools: opts.tools ? [...opts.tools] : undefined,
        ...(normalizeOllamaHost(
          opts.baseURL ?? process.env.OLLAMA_BASE_URL,
        )
          ? {
            host: normalizeOllamaHost(
              opts.baseURL ?? process.env.OLLAMA_BASE_URL,
            ),
          }
          : {}),
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        ...(extra.keepAlive ? { keepAlive: extra.keepAlive } : {}),
        ...(extra.numCtx !== undefined ? { numCtx: extra.numCtx } : {}),
        ...(extra.numGpu !== undefined ? { numGpu: extra.numGpu } : {}),
      };
      return markFactoryProvider(new OllamaProvider(cfg), {
        provider: "ollama",
        options: {
          ...(cfg.host !== undefined ? { baseURL: cfg.host } : {}),
          model: cfg.model,
          ...(cfg.timeoutMs !== undefined ? { timeoutMs: cfg.timeoutMs } : {}),
          ...(readProviderRuntimeExtra(cfg as unknown as Record<string, unknown>)
            ? { extra: readProviderRuntimeExtra(cfg as unknown as Record<string, unknown>) }
            : {}),
        },
      });
    }
    case "lmstudio":
      return buildOpenAICompatibleProvider("lmstudio", opts, {
        defaultBaseURL: "http://localhost:1234/v1",
        envBaseURL:
          process.env.LMSTUDIO_BASE_URL ??
          (!process.env.LMSTUDIO_API_KEY && process.env.OPENAI_API_KEY
            ? process.env.OPENAI_BASE_URL
            : undefined),
        envModel: process.env.LMSTUDIO_MODEL,
        envModelLabel: "LMSTUDIO_MODEL",
        envApiKey: process.env.LMSTUDIO_API_KEY,
        alternateApiKeys: process.env.OPENAI_API_KEY
          ? [process.env.OPENAI_API_KEY]
          : [],
        apiKeyMode: "optional",
        apiKeyEnvLabel: "LMSTUDIO_API_KEY",
        useResponsesApi: false,
        providerCtor: LMStudioProvider,
      });
    case "openrouter":
      return buildOpenAICompatibleProvider("openrouter", opts, {
        defaultBaseURL: "https://openrouter.ai/api/v1",
        envBaseURL: process.env.OPENROUTER_BASE_URL,
        envModel: process.env.OPENROUTER_MODEL,
        envModelLabel: "OPENROUTER_MODEL",
        envApiKey: process.env.OPENROUTER_API_KEY,
        apiKeyMode: "required",
        apiKeyEnvLabel: "OPENROUTER_API_KEY",
        useResponsesApi: false,
        providerCtor: OpenRouterProvider,
      });
    case "groq":
      return buildOpenAICompatibleProvider("groq", opts, {
        defaultBaseURL: "https://api.groq.com/openai/v1",
        envBaseURL: process.env.GROQ_BASE_URL,
        envModel: process.env.GROQ_MODEL,
        envModelLabel: "GROQ_MODEL",
        envApiKey: process.env.GROQ_API_KEY,
        defaultModel: "llama-3.3-70b-versatile",
        apiKeyMode: "required",
        apiKeyEnvLabel: "GROQ_API_KEY",
        useResponsesApi: false,
        providerCtor: GroqProvider,
      });
    case "deepseek":
      return buildOpenAICompatibleProvider("deepseek", opts, {
        defaultBaseURL: "https://api.deepseek.com/v1",
        envBaseURL: process.env.DEEPSEEK_BASE_URL,
        envModel: process.env.DEEPSEEK_MODEL,
        envModelLabel: "DEEPSEEK_MODEL",
        envApiKey: process.env.DEEPSEEK_API_KEY,
        defaultModel: DOCUMENTED_PROVIDER_DEFAULT_MODELS.deepseek,
        apiKeyMode: "required",
        apiKeyEnvLabel: "DEEPSEEK_API_KEY",
        useResponsesApi: false,
        providerCtor: DeepSeekProvider,
      });
    case "gemini": {
      const apiKey = requireApiKey(
        "gemini",
        opts.apiKey,
        "GEMINI_API_KEY",
        process.env.GEMINI_API_KEY,
      );
      const model = requireModel(
        "gemini",
        opts.model,
        process.env.GEMINI_MODEL,
        "GEMINI_MODEL",
        DOCUMENTED_PROVIDER_DEFAULT_MODELS.gemini,
      );
      const cfg: OpenAIProviderConfig = {
        ...buildCommonConfig(extra),
        apiKey,
        model,
        providerName: "gemini",
        apiKeyEnvLabel: "GEMINI_API_KEY",
        tools: opts.tools ? [...opts.tools] : undefined,
        baseURL:
          normalizeBaseURL(opts.baseURL) ??
          normalizeBaseURL(process.env.GEMINI_BASE_URL) ??
          "https://generativelanguage.googleapis.com/v1beta",
        useResponsesApi: false,
        authStrategy: "bearer",
        ...(extra.defaultHeaders ? { defaultHeaders: extra.defaultHeaders } : {}),
        ...(extra.fetchImpl ? { fetchImpl: extra.fetchImpl } : {}),
        ...(extra.project ? { project: extra.project } : {}),
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      };
      return markFactoryProvider(new GeminiProvider(cfg), {
        provider: "gemini",
        options: {
          apiKey,
          baseURL: cfg.baseURL,
          model,
          ...(cfg.timeoutMs !== undefined ? { timeoutMs: cfg.timeoutMs } : {}),
          ...(readProviderRuntimeExtra(cfg as unknown as Record<string, unknown>)
            ? { extra: readProviderRuntimeExtra(cfg as unknown as Record<string, unknown>) }
            : {}),
        },
      });
    }
    default: {
      const _exhaustive: never = name;
      void _exhaustive;
      throw new Error(`unknown provider: ${String(name)}`);
    }
  }
}

function readPreparedModel(
  provider: LLMProvider,
  fallbackModel: string | undefined,
): string {
  const configuredModel = (
    provider as unknown as {
      config?: { model?: string };
    }
  ).config?.model;
  const resolved = firstNonEmpty(configuredModel, fallbackModel);
  if (!resolved) {
    throw new Error("provider switch could not resolve an active model");
  }
  return resolved;
}

export function prepareProviderSwitch(
  provider: string | undefined,
  opts: ProviderFactoryOptions,
): PreparedProviderSwitch {
  const normalizedProvider = normalizeProviderName(provider);
  if (normalizedProvider === null) {
    throw new Error(`unknown provider "${provider?.trim() ?? ""}"`);
  }
  const instance = createProvider(normalizedProvider, opts);
  return {
    provider: normalizedProvider,
    model: readPreparedModel(instance, opts.model),
    instance,
  };
}

export function resolveProviderNameFromEnv(): ProviderName {
  const raw = process.env.AGENC_PROVIDER ?? "grok";
  const normalized = normalizeProviderName(raw);
  if (normalized !== null) return normalized;
  throw new Error(
    `AGENC_PROVIDER="${raw.trim().toLowerCase()}" is not a known provider (accepted: ${KNOWN_PROVIDER_NAMES.join(", ")})`,
  );
}
