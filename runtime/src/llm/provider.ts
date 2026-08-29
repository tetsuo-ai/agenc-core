/**
 * Provider factory — single entrypoint for provider construction.
 *
 * @module
 */

import type {
  AuthBackend,
  AuthSubscriptionTier,
  AuthVendedCredential,
} from "../auth/backend.js";
import { normalizeProviderIdentity } from "../provider-identity.js";
import { AgenCProvider } from "./providers/agenc/index.js";
import { GrokProvider } from "./providers/grok/adapter.js";
import {
  GrokAcpProvider,
  isGrokComposerModel,
} from "./providers/grok/acp-adapter.js";
import type { GrokProviderConfig } from "./providers/grok/types.js";
import { OllamaProvider } from "./providers/ollama/adapter.js";
import type { OllamaProviderConfig } from "./providers/ollama/types.js";
import type {
  LLMChatOptions,
  LLMProvider,
  LLMProviderConfig,
  LLMProviderExecutionProfile,
  LLMTool,
} from "./types.js";
import { OpenAIProvider } from "./providers/openai/adapter.js";
import type { OpenAIProviderConfig } from "./providers/openai/types.js";
import { AnthropicProvider } from "./providers/anthropic/adapter.js";
import type { AnthropicProviderConfig } from "./providers/anthropic/types.js";
import {
  GeminiProvider,
  type GeminiProviderConfig,
} from "./providers/gemini/index.js";
import {
  assertNoRetiredGeminiRuntimeFields,
  parseGeminiRuntimeOptions,
  readGeminiRuntimeOptions,
  type GeminiRuntimeOptions,
} from "./providers/gemini/runtime-options.js";
import {
  BedrockProvider,
  type BedrockProviderConfig,
} from "./providers/bedrock/index.js";
import { LMStudioProvider } from "./providers/lmstudio/index.js";
import { OpenRouterProvider } from "./providers/openrouter/index.js";
import { GroqProvider } from "./providers/groq/index.js";
import { DeepSeekProvider } from "./providers/deepseek/index.js";
import { MistralProvider } from "./providers/mistral/index.js";
import { NvidiaNimProvider } from "./providers/nvidia-nim/index.js";
import { MiniMaxProvider } from "./providers/minimax/index.js";
import { GitHubProvider } from "./providers/github/index.js";
import {
  getGithubEndpointType,
  normalizeGithubModelForEndpoint,
  shouldUseGithubCopilotResponsesApi,
} from "./providers/github/model-routing.js";
import { OpenAICompatibleProvider } from "./providers/openai-compatible/index.js";
import type { ProviderFallbackLadderOptions } from "./api/fallback-ladder.js";
import {
  builtInProviderIds,
  resolveBuiltInProviderRegionalEndpoint,
  resolveBuiltInProviderSlug,
  resolveBuiltInProviderInfo,
  type BuiltInProviderInfo,
  type BuiltInProviderSlug,
} from "./registry/provider-info.js";
export { resolveBuiltInProviderSlug } from "./registry/provider-info.js";
import {
  forceRefreshXaiOauthCredentials,
  isXaiOauthBearer,
  xaiOauthRequiresRelogin,
} from "../utils/xaiOauthCredentials.js";
import { isTrustedXaiOauthInferenceBaseUrl } from "../services/xai/oauth.js";
import type { SandboxExecutionBrokerLike } from "../sandbox/execution-broker.js";
import type { HomeContext } from "../config/home.js";

export type ProviderName = BuiltInProviderSlug;

export interface ProviderFactoryOptions {
  /** Home-bound native credential authority captured at provider ingress. */
  readonly credentialHome?: HomeContext;
  readonly apiKey?: string;
  /** Prepared bearer-token credential. Currently supported by Anthropic. */
  readonly authToken?: string;
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

export const KNOWN_PROVIDER_NAMES: readonly ProviderName[] =
  builtInProviderIds();

export interface PreparedProviderSwitch {
  readonly provider: ProviderName;
  readonly model: string;
  readonly instance: LLMProvider;
}

export interface ProviderRuntimeState {
  readonly provider: ProviderName;
  readonly options: ProviderFactoryOptions;
}

export type ProviderRuntimeExtra = Partial<
  Omit<LLMProviderConfig, "model" | "tools" | "timeoutMs">
> & {
  readonly organization?: string;
  readonly project?: string;
  readonly useResponsesApi?: boolean;
  readonly store?: boolean;
  readonly chatgptBackend?: boolean;
  readonly authMode?: "api_key" | "oauth";
  readonly oauth?: Record<string, unknown>;
  readonly openAiCompatibility?: {
    readonly authHeader?: string;
    readonly authHeaderValue?: string;
    readonly authScheme?: "bearer" | "raw";
    readonly azureApiVersion?: string;
  };
  readonly gemini?: GeminiRuntimeOptions;
  readonly grokAcp?: {
    readonly binaryPath?: string;
    readonly allowPermissions?: boolean;
    readonly path?: string;
    readonly environment?: Readonly<Record<string, string>>;
  };
  readonly defaultHeaders?: Readonly<Record<string, string>>;
  readonly fetchImpl?: typeof fetch;
  readonly accessKeyId?: string;
  readonly secretAccessKey?: string;
  readonly sessionToken?: string;
  readonly region?: string;
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
  readonly managedCredential?: boolean;
  readonly managedGateway?: boolean;
  readonly providerFallback?: ProviderFallbackLadderOptions;
  readonly emitWarning?: LLMProviderConfig["emitWarning"];
  readonly emitDiagnostic?: LLMProviderConfig["emitDiagnostic"];
  readonly onCapabilityDrift?: LLMProviderConfig["onCapabilityDrift"];
  readonly sandboxExecutionBroker?: SandboxExecutionBrokerLike;
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
  "chatgptBackend",
  "authMode",
  "oauth",
  "openAiCompatibility",
  "gemini",
  "grokAcp",
  "defaultHeaders",
  "fetchImpl",
  "accessKeyId",
  "secretAccessKey",
  "sessionToken",
  "region",
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
  "managedCredential",
  "managedGateway",
  "emitWarning",
  "emitDiagnostic",
  "onCapabilityDrift",
  "sandboxExecutionBroker",
] as const satisfies readonly (keyof ProviderRuntimeExtra)[];

export function isFactoryProvider(provider: LLMProvider): boolean {
  return (provider as FactoryMarkedProvider)[FACTORY_PROVIDER_MARKER] === true;
}

export function readProviderIdentity(
  provider: LLMProvider | undefined,
  fallbackProvider?: string,
): ProviderName | null {
  if (!provider) {
    return resolveBuiltInProviderSlug(fallbackProvider) ?? null;
  }
  const storedState = (provider as FactoryMarkedProvider)[
    FACTORY_PROVIDER_STATE
  ];
  if (storedState) {
    return storedState.provider;
  }
  return resolveBuiltInProviderSlug(fallbackProvider ?? provider.name) ?? null;
}

export function readProviderFactoryOptions(
  provider: LLMProvider,
): ProviderFactoryOptions {
  const storedState = (provider as FactoryMarkedProvider)[
    FACTORY_PROVIDER_STATE
  ];
  const config = (
    provider as unknown as {
      config?: Record<string, unknown>;
    }
  ).config;
  const directGeminiRuntime =
    provider.name === "gemini" &&
    config?.credentialPlan !== undefined &&
    config?.endpointPlan !== undefined
      ? parseGeminiRuntimeOptions({
          credentialPlan: config.credentialPlan,
          endpointPlan: config.endpointPlan,
          ...(firstNonEmpty(readString(config, "cachedContent")) !== undefined
            ? {
                cachedContent: firstNonEmpty(
                  readString(config, "cachedContent"),
                ),
              }
            : {}),
        })
      : undefined;
  const runtimeExtra = readProviderRuntimeExtra(config);
  const extra =
    directGeminiRuntime === undefined
      ? runtimeExtra
      : { ...(runtimeExtra ?? {}), gemini: directGeminiRuntime };
  const configuredTools = Array.isArray(config?.tools)
    ? (config.tools as ReadonlyArray<LLMTool>)
    : undefined;
  if (storedState) {
    const storedOptions = cloneProviderFactoryOptions(storedState.options);
    return {
      ...storedOptions,
      ...(storedOptions.tools === undefined && configuredTools !== undefined
        ? { tools: [...configuredTools] }
        : {}),
    };
  }
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
    ...(configuredTools !== undefined ? { tools: [...configuredTools] } : {}),
    ...(extra ? { extra } : {}),
  };
}

export function normalizeManagedGatewayModel(
  provider: ProviderName | string,
  model: string,
): string {
  const trimmed = model.trim();
  const normalizedProvider = resolveBuiltInProviderSlug(provider);
  if (trimmed.length === 0) return trimmed;
  if (normalizedProvider === "openrouter") {
    return trimmed.startsWith("openrouter/")
      ? trimmed
      : `openrouter/${trimmed}`;
  }
  if (trimmed.includes("/")) return trimmed;
  switch (normalizedProvider) {
    case "grok":
      return `xai/${trimmed}`;
    case "openai":
      return `openai/${trimmed}`;
    case "anthropic":
      return `anthropic/${trimmed}`;
    case "gemini":
      return `gemini/${trimmed}`;
    case "groq":
      return `groq/${trimmed}`;
    case "deepseek":
      return `deepseek/${trimmed}`;
    case "mistral":
      return `mistral/${trimmed}`;
    default:
      return trimmed;
  }
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

/** Preserve canonical factory identity when wrapping a provider object. */
export function preserveProviderFactoryState<T extends LLMProvider>(
  target: T,
  source: LLMProvider,
): T {
  const state = (source as FactoryMarkedProvider)[FACTORY_PROVIDER_STATE];
  return state === undefined
    ? target
    : markFactoryProvider(target, {
        provider: state.provider,
        options: state.options,
      });
}

function firstNonEmpty(
  ...values: Array<string | undefined>
): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function requireBuiltInProviderInfo(
  provider: ProviderName,
): BuiltInProviderInfo {
  const info = resolveBuiltInProviderInfo(provider);
  if (info === undefined) {
    throw new Error(`unknown provider: ${String(provider)}`);
  }
  return info;
}

function defaultModelFor(provider: ProviderName): string {
  return requireBuiltInProviderInfo(provider).defaultModel;
}

function defaultBaseURLFor(provider: ProviderName): string {
  return requireBuiltInProviderInfo(provider).baseURL;
}

function requireModel(
  provider: ProviderName,
  explicitModel: string | undefined,
  fallbackModel?: string,
): string {
  const model = firstNonEmpty(explicitModel, fallbackModel);
  if (!model) {
    throw new Error(
      `${provider} provider requires a canonical model in factory options`,
    );
  }
  return model;
}

function resolveFactoryApiKey(
  opts: ProviderFactoryOptions,
  explicitApiKey?: string,
): string | undefined {
  return firstNonEmpty(explicitApiKey, opts.apiKey);
}

function requireFactoryApiKey(
  provider: ProviderName,
  opts: ProviderFactoryOptions,
  explicitApiKey?: string,
): string {
  const apiKey = resolveFactoryApiKey(opts, explicitApiKey);
  if (apiKey === undefined) {
    throw new Error(
      `${provider} provider requires apiKey — pass apiKey or authBackend/sessionId in factory options`,
    );
  }
  return apiKey;
}

const AUTH_VENDED_PROVIDER_NAMES = new Set<ProviderName>([
  "grok",
  "openai",
  "anthropic",
  "openai-compatible",
  "openrouter",
  "groq",
  "deepseek",
  "amazon-bedrock",
]);
const DEFAULT_AUTH_VENDED_DELEGATE_TTL_MS = 5 * 60 * 1000;

interface AuthVendedDelegate {
  readonly instance: LLMProvider;
  readonly expiresAtMs: number;
}

interface AuthVendedProviderCapabilities {
  readonly prewarmStartup?: true;
  readonly storedResponses?: true;
}

class AuthVendedProvider implements LLMProvider {
  readonly name: string;
  readonly config: {
    readonly model: string;
    readonly baseURL?: string;
  };
  readonly prewarmStartup?: LLMProvider["prewarmStartup"];
  readonly retrieveStoredResponse?: LLMProvider["retrieveStoredResponse"];
  readonly deleteStoredResponse?: LLMProvider["deleteStoredResponse"];
  readonly #provider: ProviderName;
  readonly #opts: ProviderFactoryOptions;
  readonly #authBackend: AuthBackend;
  readonly #sessionId: string;
  #delegate: AuthVendedDelegate | undefined;
  #delegatePromise: Promise<AuthVendedDelegate> | undefined;

  constructor(params: {
    readonly provider: ProviderName;
    readonly opts: ProviderFactoryOptions;
    readonly authBackend: AuthBackend;
    readonly sessionId: string;
  }) {
    this.name = params.provider;
    this.#provider = params.provider;
    this.#opts = stripConcreteProviderAuthOptions(params.opts);
    this.#authBackend = params.authBackend;
    this.#sessionId = params.sessionId;
    this.config = {
      model: this.#opts.model ?? defaultModelFor(params.provider),
      ...(this.#opts.baseURL !== undefined
        ? { baseURL: this.#opts.baseURL }
        : {}),
    };
    const capabilities = authVendedProviderCapabilities(params.provider);
    if (capabilities.prewarmStartup) {
      this.prewarmStartup = async (startupParams) =>
        (await this.delegate()).instance.prewarmStartup?.(startupParams);
    }
    if (capabilities.storedResponses) {
      this.retrieveStoredResponse = async (responseId) => {
        const delegate = (await this.delegate()).instance;
        if (!delegate.retrieveStoredResponse) {
          throw new Error(
            `${this.name} provider does not support stored responses`,
          );
        }
        return delegate.retrieveStoredResponse(responseId);
      };
      this.deleteStoredResponse = async (responseId) => {
        const delegate = (await this.delegate()).instance;
        if (!delegate.deleteStoredResponse) {
          throw new Error(
            `${this.name} provider does not support stored responses`,
          );
        }
        return delegate.deleteStoredResponse(responseId);
      };
    }
  }

  async chat(
    messages: Parameters<LLMProvider["chat"]>[0],
    options?: Parameters<LLMProvider["chat"]>[1],
  ): ReturnType<LLMProvider["chat"]> {
    return (await this.delegate()).instance.chat(messages, options);
  }

  async chatStream(
    messages: Parameters<LLMProvider["chatStream"]>[0],
    onChunk: Parameters<LLMProvider["chatStream"]>[1],
    options?: Parameters<LLMProvider["chatStream"]>[2],
  ): ReturnType<LLMProvider["chatStream"]> {
    return (await this.delegate()).instance.chatStream(
      messages,
      onChunk,
      options,
    );
  }

  async healthCheck(): Promise<boolean> {
    return (await this.delegate()).instance.healthCheck();
  }

  async getExecutionProfile(
    options?: LLMChatOptions,
  ): Promise<LLMProviderExecutionProfile> {
    const { instance: delegate } = await this.delegate();
    const profile = await delegate.getExecutionProfile?.(options);
    return (
      profile ?? {
        provider: this.#provider,
        model: this.config.model,
        usageReporting: "unavailable",
        supportsMaxOutputTokens: false,
      }
    );
  }

  private async delegate(): Promise<AuthVendedDelegate> {
    if (
      this.#delegate !== undefined &&
      this.#delegate.expiresAtMs > Date.now()
    ) {
      return this.#delegate;
    }
    this.#delegatePromise ??= this.createDelegate()
      .then((delegate) => {
        this.#delegate = delegate;
        return delegate;
      })
      .catch((error) => {
        this.#delegate = undefined;
        throw error;
      })
      .finally(() => {
        this.#delegatePromise = undefined;
      });
    return this.#delegatePromise;
  }

  private async createDelegate(): Promise<AuthVendedDelegate> {
    const vended = await this.#authBackend.vendKey(
      this.#provider,
      this.#sessionId,
    );
    if (vended.provider !== this.#provider) {
      throw new Error(
        `${this.#provider} provider AuthBackend.vendKey() returned provider "${vended.provider}"`,
      );
    }
    if (vended.sessionId !== this.#sessionId) {
      throw new Error(
        `${this.#provider} provider AuthBackend.vendKey() returned session "${vended.sessionId}"`,
      );
    }
    const options = cloneProviderFactoryOptions(this.#opts);
    const credentialOptions = resolveAuthVendedProviderCredentialOptions(
      this.#provider,
      options.extra,
      vended,
    );
    const baseURL = firstNonEmpty(options.baseURL, vended.baseUrl);
    const model =
      baseURL !== undefined && options.model !== undefined
        ? normalizeManagedGatewayModel(this.#provider, options.model)
        : options.model;
    return {
      instance: createProvider(this.#provider, {
        ...options,
        ...(model !== undefined ? { model } : {}),
        ...credentialOptions,
        ...(baseURL !== undefined ? { baseURL } : {}),
      }),
      expiresAtMs:
        parseAuthVendedExpiresAtMs(vended.expiresAt) ??
        Date.now() + DEFAULT_AUTH_VENDED_DELEGATE_TTL_MS,
    };
  }
}

function authVendedProviderCapabilities(
  provider: ProviderName,
): AuthVendedProviderCapabilities {
  switch (provider) {
    case "grok":
      return { prewarmStartup: true, storedResponses: true };
    case "openai":
    case "lmstudio":
    case "openai-compatible":
    case "openrouter":
    case "groq":
    case "deepseek":
      return { storedResponses: true };
    default:
      return {};
  }
}

function parseAuthVendedExpiresAtMs(
  expiresAt: string | undefined,
): number | undefined {
  if (expiresAt === undefined) return undefined;
  const parsed = Date.parse(expiresAt);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function hasConcreteProviderCredentialInput(
  provider: ProviderName,
  opts: ProviderFactoryOptions,
): boolean {
  return provider === "amazon-bedrock"
    ? ["accessKeyId", "secretAccessKey", "sessionToken"].some(
        (field) => firstNonEmpty(readString(opts.extra, field)) !== undefined,
      )
    : firstNonEmpty(opts.apiKey, opts.authToken) !== undefined;
}

function stripConcreteProviderAuthExtra(
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

function stripConcreteProviderAuthOptions(
  opts: ProviderFactoryOptions,
): ProviderFactoryOptions {
  const extra = stripConcreteProviderAuthExtra(opts.extra);
  return {
    ...(opts.credentialHome !== undefined
      ? { credentialHome: opts.credentialHome }
      : {}),
    ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
    ...(opts.authToken !== undefined ? { authToken: opts.authToken } : {}),
    ...(opts.baseURL !== undefined ? { baseURL: opts.baseURL } : {}),
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    ...(opts.tools ? { tools: [...opts.tools] } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(extra !== undefined ? { extra } : {}),
  };
}

function authVendedProviderFactoryOptions(params: {
  readonly provider: ProviderName;
  readonly opts: ProviderFactoryOptions;
  readonly authBackend: AuthBackend;
  readonly sessionId: string;
}): ProviderFactoryOptions {
  const stripped = stripConcreteProviderAuthOptions(params.opts);
  return {
    ...stripped,
    model: resolveAuthVendedProviderModel(params.provider, stripped.model),
    extra: {
      ...(stripped.extra ?? {}),
      authBackend: params.authBackend,
      sessionId: params.sessionId,
    },
  };
}

function resolveAuthVendedProviderModel(
  provider: ProviderName,
  explicitModel: string | undefined,
): string {
  return firstNonEmpty(explicitModel) ?? defaultModelFor(provider);
}

function resolveAuthVendedProviderCredentialOptions(
  provider: ProviderName,
  extra: Record<string, unknown> | undefined,
  vended: AuthVendedCredential,
): Pick<ProviderFactoryOptions, "apiKey" | "extra"> {
  if (provider !== "amazon-bedrock") {
    if (vended.kind !== "api-key") {
      throw new Error(
        `${provider} provider AuthBackend.vendKey() returned ${vended.kind} credentials; expected api-key`,
      );
    }
    const apiKey = firstNonEmpty(vended.apiKey);
    if (apiKey === undefined) {
      throw new Error(
        `${provider} provider AuthBackend.vendKey() returned an empty API key`,
      );
    }
    return {
      apiKey,
      ...(extra !== undefined ? { extra } : {}),
    };
  }
  if (vended.kind !== "aws-sigv4") {
    throw new Error(
      "amazon-bedrock provider AuthBackend.vendKey() returned api-key credentials; expected aws-sigv4",
    );
  }
  const accessKeyId = firstNonEmpty(vended.accessKeyId);
  const secretAccessKey = firstNonEmpty(vended.secretAccessKey);
  if (accessKeyId === undefined || secretAccessKey === undefined) {
    throw new Error(
      "amazon-bedrock provider AuthBackend.vendKey() returned incomplete AWS SigV4 credentials",
    );
  }
  const nonCredentialExtra = extra
    ? Object.fromEntries(
        Object.entries(extra)
          .filter(
            ([key]) =>
              key !== "accessKeyId" &&
              key !== "secretAccessKey" &&
              key !== "sessionToken" &&
              key !== "region",
          )
          .map(([key, value]) => [key, cloneExtraValue(value)]),
      )
    : {};
  const sessionToken = firstNonEmpty(vended.sessionToken);
  const region = firstNonEmpty(vended.region, readString(extra, "region"));
  return {
    extra: {
      ...nonCredentialExtra,
      accessKeyId,
      secretAccessKey,
      ...(sessionToken !== undefined ? { sessionToken } : {}),
      ...(region !== undefined ? { region } : {}),
    },
  };
}

function createAuthVendedProviderIfNeeded(
  provider: ProviderName,
  opts: ProviderFactoryOptions,
): LLMProvider | undefined {
  if (!AUTH_VENDED_PROVIDER_NAMES.has(provider)) return undefined;
  if (providerTargetsLocalEndpoint(provider, opts)) return undefined;
  if (hasConcreteProviderCredentialInput(provider, opts)) {
    return undefined;
  }
  if (hasFactoryOAuthAccessToken(opts)) return undefined;
  const authBackend = readAuthBackendExtra(opts.extra);
  if (authBackend === undefined) return undefined;
  const sessionId = firstNonEmpty(readString(opts.extra, "sessionId"));
  if (sessionId === undefined) {
    throw new Error(
      `${provider} provider requires sessionId in factory options extra to vend a provider key`,
    );
  }
  const factoryOptions = authVendedProviderFactoryOptions({
    provider,
    opts,
    authBackend,
    sessionId,
  });
  return markFactoryProvider(
    new AuthVendedProvider({
      provider,
      opts: factoryOptions,
      authBackend,
      sessionId,
    }),
    {
      provider,
      options: factoryOptions,
    },
  );
}

function providerTargetsLocalEndpoint(
  provider: ProviderName,
  opts: ProviderFactoryOptions,
): boolean {
  if (provider === "lmstudio" || provider === "ollama") return true;
  if (provider !== "openai-compatible") return false;
  return isLocalBaseURL(
    normalizeBaseURL(opts.baseURL) ?? defaultBaseURLFor("openai-compatible"),
  );
}

function isLocalBaseURL(baseURL: string | undefined): boolean {
  if (baseURL === undefined) return false;
  try {
    const hostname = new URL(baseURL).hostname.toLowerCase();
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname.endsWith(".local")
    );
  } catch {
    return false;
  }
}

function hasFactoryOAuthAccessToken(opts: ProviderFactoryOptions): boolean {
  if (readString(opts.extra, "authMode") !== "oauth") return false;
  const oauth = readRecord(opts.extra, "oauth");
  return firstNonEmpty(readString(oauth, "accessToken")) !== undefined;
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
  if (isSandboxExecutionBrokerLike(value)) return value;
  if (Array.isArray(value)) return [...value];
  if (value && typeof value === "object") return { ...value };
  return value;
}

function isSandboxExecutionBrokerLike(
  value: unknown,
): value is SandboxExecutionBrokerLike {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<
    Record<keyof SandboxExecutionBrokerLike, unknown>
  >;
  return (
    typeof candidate.assertReady === "function" &&
    typeof candidate.prepareSpawn === "function" &&
    typeof candidate.runtimeSandbox === "function" &&
    typeof candidate.forkForCwd === "function"
  );
}

function readSandboxExecutionBrokerExtra(
  extra: Record<string, unknown> | undefined,
): SandboxExecutionBrokerLike | undefined {
  const value = extra?.sandboxExecutionBroker;
  return isSandboxExecutionBrokerLike(value) ? value : undefined;
}

function cloneProviderFactoryOptions(
  options: ProviderFactoryOptions,
): ProviderFactoryOptions {
  return {
    ...(options.credentialHome !== undefined
      ? { credentialHome: options.credentialHome }
      : {}),
    ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
    ...(options.authToken !== undefined
      ? { authToken: options.authToken }
      : {}),
    ...(options.baseURL !== undefined ? { baseURL: options.baseURL } : {}),
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(options.tools ? { tools: [...options.tools] } : {}),
    ...(options.timeoutMs !== undefined
      ? { timeoutMs: options.timeoutMs }
      : {}),
    ...(options.extra
      ? {
          extra: Object.fromEntries(
            Object.entries(options.extra).map(([key, value]) => [
              key,
              key === "authBackend"
                ? value
                : key === "gemini"
                  ? parseGeminiRuntimeOptions(value)
                  : key === "grokAcp"
                    ? readGrokAcpRuntimeExtra(value)
                  : cloneExtraValue(value),
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
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
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
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const entries = Object.entries(value);
  if (entries.some(([, entry]) => typeof entry !== "string")) return undefined;
  return Object.fromEntries(entries) as Readonly<Record<string, string>>;
}

function readStringArray(
  source: Record<string, unknown> | undefined,
  key: string,
): readonly string[] | undefined {
  const value = source?.[key];
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string")
  ) {
    return undefined;
  }
  return [...value];
}

function readRecord(
  source: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  const value = source?.[key];
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
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
    const cloned =
      key === "gemini"
        ? parseGeminiRuntimeOptions(value)
        : key === "grokAcp"
          ? readGrokAcpRuntimeExtra(value)
          : cloneExtraValue(value);
    if (cloned !== undefined) extra[key] = cloned;
  }
  return Object.keys(extra).length > 0 ? extra : undefined;
}

function readGrokAcpRuntimeExtra(
  value: unknown,
): ProviderRuntimeExtra["grokAcp"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = { ...value } as Record<string, unknown>;
  const environment = readStringRecord(record, "environment");
  const runtime = Object.freeze({
    ...(readString(record, "binaryPath") !== undefined
      ? { binaryPath: readString(record, "binaryPath") }
      : {}),
    ...(readBoolean(record, "allowPermissions") !== undefined
      ? { allowPermissions: readBoolean(record, "allowPermissions") }
      : {}),
    ...(readString(record, "path") !== undefined
      ? { path: readString(record, "path") }
      : {}),
    ...(environment !== undefined
      ? { environment: Object.freeze(environment) }
      : {}),
  });
  return Object.keys(runtime).length > 0 ? runtime : undefined;
}

function readRuntimeExtra(
  extra: Record<string, unknown> | undefined,
): ProviderRuntimeExtra {
  const providerFallback = readProviderFallback(extra);
  const gemini = readGeminiRuntimeOptions(extra);
  const grokAcp = readGrokAcpRuntimeExtra(extra?.grokAcp);
  const openAiCompatibility = readRecord(extra, "openAiCompatibility");
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
    ...(providerFallback !== undefined ? { providerFallback } : {}),
    ...(extra?.toolHandler
      ? { toolHandler: extra.toolHandler as LLMProviderConfig["toolHandler"] }
      : {}),
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
    ...(readBoolean(extra, "chatgptBackend") !== undefined
      ? { chatgptBackend: readBoolean(extra, "chatgptBackend") }
      : {}),
    ...(readString(extra, "authMode") === "api_key" ||
    readString(extra, "authMode") === "oauth"
      ? {
          authMode: readString(extra, "authMode") as "api_key" | "oauth",
        }
      : {}),
    ...(readRecord(extra, "oauth")
      ? { oauth: readRecord(extra, "oauth") }
      : {}),
    ...(openAiCompatibility !== undefined ? { openAiCompatibility } : {}),
    ...(gemini !== undefined ? { gemini } : {}),
    ...(grokAcp !== undefined ? { grokAcp } : {}),
    ...(readStringRecord(extra, "defaultHeaders")
      ? { defaultHeaders: readStringRecord(extra, "defaultHeaders") }
      : {}),
    ...(extra?.fetchImpl ? { fetchImpl: extra.fetchImpl as typeof fetch } : {}),
    ...(readString(extra, "accessKeyId") !== undefined
      ? { accessKeyId: readString(extra, "accessKeyId") }
      : {}),
    ...(readString(extra, "secretAccessKey") !== undefined
      ? { secretAccessKey: readString(extra, "secretAccessKey") }
      : {}),
    ...(readString(extra, "sessionToken") !== undefined
      ? { sessionToken: readString(extra, "sessionToken") }
      : {}),
    ...(readString(extra, "region") !== undefined
      ? { region: readString(extra, "region") }
      : {}),
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
    ...(readBoolean(extra, "managedCredential") !== undefined
      ? { managedCredential: readBoolean(extra, "managedCredential") }
      : {}),
    ...(readBoolean(extra, "managedGateway") !== undefined
      ? { managedGateway: readBoolean(extra, "managedGateway") }
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
    case "c4e":
      return "enterprise";
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
    | "lmstudio"
    | "openai-compatible"
    | "openrouter"
    | "groq"
    | "deepseek"
    | "mistral"
    | "nvidia-nim"
    | "minimax"
    | "github"
  >,
  opts: ProviderFactoryOptions,
  input: {
    readonly apiKeyMode: "required" | "optional";
    readonly normalizeModel?: (
      model: string,
      baseURL: string | undefined,
    ) => string;
    readonly useResponsesApi:
      boolean | ((model: string, baseURL: string | undefined) => boolean);
    readonly providerCtor?: new (config: OpenAIProviderConfig) => LLMProvider;
  },
): LLMProvider {
  const extra = readRuntimeExtra(opts.extra);
  const requestedModel = requireModel(
    provider,
    opts.model,
    defaultModelFor(provider),
  );
  const baseURL = normalizeBaseURL(opts.baseURL) ?? defaultBaseURLFor(provider);
  const model =
    input.normalizeModel?.(requestedModel, baseURL) ?? requestedModel;
  const useResponsesApi =
    typeof input.useResponsesApi === "function"
      ? input.useResponsesApi(model, baseURL)
      : (extra.useResponsesApi ?? input.useResponsesApi);
  const oauthConfig =
    extra.authMode === "oauth" &&
    extra.oauth &&
    typeof extra.oauth.accessToken === "string" &&
    extra.oauth.accessToken.trim().length > 0
      ? (extra.oauth as unknown as OpenAIProviderConfig["oauth"])
      : undefined;
  const apiKey =
    oauthConfig || input.apiKeyMode === "optional"
      ? resolveFactoryApiKey(opts)
      : requireFactoryApiKey(provider, opts);

  const cfg: OpenAIProviderConfig = {
    ...buildCommonConfig(extra),
    ...(apiKey !== undefined ? { apiKey } : {}),
    model,
    providerName: provider,
    tools: opts.tools ? [...opts.tools] : undefined,
    baseURL,
    useResponsesApi,
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
  const providerExtra = readProviderRuntimeExtra({
    ...(cfg as unknown as Record<string, unknown>),
    ...(extra.openAiCompatibility !== undefined
      ? { openAiCompatibility: extra.openAiCompatibility }
      : {}),
    ...(extra.managedCredential === true ? { managedCredential: true } : {}),
  });
  return markFactoryProvider(new ProviderCtor(cfg), {
    provider,
    options: {
      ...(opts.credentialHome !== undefined
        ? { credentialHome: opts.credentialHome }
        : {}),
      ...(apiKey !== undefined ? { apiKey } : {}),
      baseURL: cfg.baseURL,
      model,
      ...(cfg.timeoutMs !== undefined ? { timeoutMs: cfg.timeoutMs } : {}),
      ...(providerExtra ? { extra: providerExtra } : {}),
    },
  });
}

function buildManagedGatewayProvider(
  provider: Exclude<ProviderName, "agenc">,
  opts: ProviderFactoryOptions,
  extra: ProviderRuntimeExtra,
): LLMProvider {
  const apiKey = requireFactoryApiKey(provider, opts);
  const baseURL = normalizeBaseURL(opts.baseURL);
  if (baseURL === undefined) {
    throw new Error(
      `${provider} managed gateway provider requires baseURL from AuthBackend.vendKey()`,
    );
  }
  const model = normalizeManagedGatewayModel(
    provider,
    requireModel(provider, opts.model, defaultModelFor(provider)),
  );
  const cfg: OpenAIProviderConfig = {
    ...buildCommonConfig(extra),
    apiKey,
    baseURL,
    model,
    providerName: provider,
    apiKeyEnvLabel: "AgenC subscription",
    tools: opts.tools ? [...opts.tools] : undefined,
    useResponsesApi: false,
    ...(extra.contextWindowTokens !== undefined
      ? { contextWindowTokens: extra.contextWindowTokens }
      : {}),
    ...(extra.defaultHeaders ? { defaultHeaders: extra.defaultHeaders } : {}),
    ...(extra.fetchImpl ? { fetchImpl: extra.fetchImpl } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  };
  const providerInstance = new OpenAIProvider(cfg);
  return markFactoryProvider(providerInstance, {
    provider,
    options: {
      ...(opts.credentialHome !== undefined
        ? { credentialHome: opts.credentialHome }
        : {}),
      apiKey,
      baseURL,
      model,
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(readProviderRuntimeExtra({
        ...(cfg as unknown as Record<string, unknown>),
        managedGateway: true,
      })
        ? {
            extra: readProviderRuntimeExtra({
              ...(cfg as unknown as Record<string, unknown>),
              managedGateway: true,
            }),
          }
        : {}),
    },
  });
}

export function createProvider(
  name: ProviderName,
  opts: ProviderFactoryOptions,
): LLMProvider {
  // Keep the runtime boundary fail-closed even when JavaScript or an unsafe
  // cast bypasses the canonical ProviderName type.
  normalizeProviderIdentity(String(name), "provider factory");
  if (name === "amazon-bedrock" && firstNonEmpty(opts.apiKey) !== undefined) {
    throw new Error(
      "amazon-bedrock does not accept the generic apiKey factory option; pass accessKeyId in factory options extra",
    );
  }
  if (name !== "anthropic" && firstNonEmpty(opts.authToken) !== undefined) {
    throw new Error(
      `${name} provider does not accept the authToken factory option`,
    );
  }
  const authVendedProvider = createAuthVendedProviderIfNeeded(name, opts);
  if (authVendedProvider !== undefined) return authVendedProvider;
  const extra = readRuntimeExtra(opts.extra);
  if (extra.managedGateway === true && name !== "agenc") {
    return buildManagedGatewayProvider(name, opts, extra);
  }
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
      const model = requireModel("agenc", opts.model, defaultModelFor("agenc"));
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
          ...(opts.timeoutMs !== undefined
            ? { timeoutMs: opts.timeoutMs }
            : {}),
          providerFactory: (concreteProvider, providerOptions) =>
            createProvider(concreteProvider, providerOptions),
          ...(opts.baseURL !== undefined || providerExtra !== undefined
            ? {
                providerOptions: {
                  ...(opts.baseURL !== undefined
                    ? { baseURL: opts.baseURL }
                    : {}),
                  ...(providerExtra !== undefined
                    ? { extra: providerExtra }
                    : {}),
                },
              }
            : {}),
        }),
        {
          provider: "agenc",
          options: {
            ...(opts.credentialHome !== undefined
              ? { credentialHome: opts.credentialHome }
              : {}),
            ...(opts.baseURL !== undefined ? { baseURL: opts.baseURL } : {}),
            model,
            ...(opts.timeoutMs !== undefined
              ? { timeoutMs: opts.timeoutMs }
              : {}),
            ...(providerExtra !== undefined ? { extra: providerExtra } : {}),
          },
        },
      );
      return provider;
    }
    case "grok": {
      const grokRequestedModel = opts.model?.trim() || undefined;
      if (isGrokComposerModel(grokRequestedModel)) {
        // Per xAI: composer models are served ONLY through ACP (the Grok
        // Build CLI), never by direct inference calls. Auth belongs to the
        // CLI (cached `grok` login or XAI_API_KEY) — no factory key needed.
        const sandboxExecutionBroker = readSandboxExecutionBrokerExtra(
          opts.extra,
        );
        const storedExtra = readProviderRuntimeExtra(opts.extra);
        const factoryApiKey = resolveFactoryApiKey(opts);
        const acpEnvironment = extra.grokAcp?.environment;
        if (acpEnvironment === undefined) {
          throw new Error(
            "grok composer provider requires a prepared child environment in factory options extra",
          );
        }
        const acpProvider = new GrokAcpProvider({
          model: grokRequestedModel as string,
          env: acpEnvironment,
          ...(factoryApiKey !== undefined ? { apiKey: factoryApiKey } : {}),
          ...(extra.grokAcp?.binaryPath !== undefined
            ? { binaryPath: extra.grokAcp.binaryPath }
            : {}),
          ...(extra.grokAcp?.allowPermissions !== undefined
            ? { allowPermissions: extra.grokAcp.allowPermissions }
            : {}),
          ...(extra.grokAcp?.path !== undefined
            ? { path: extra.grokAcp.path }
            : {}),
          ...(sandboxExecutionBroker !== undefined
            ? { sandboxExecutionBroker }
            : {}),
          ...(extra.contextWindowTokens !== undefined
            ? { contextWindowTokens: extra.contextWindowTokens }
            : {}),
          ...(opts.timeoutMs !== undefined
            ? { timeoutMs: opts.timeoutMs }
            : {}),
        });
        return markFactoryProvider(acpProvider, {
          provider: "grok",
          options: {
            ...(opts.credentialHome !== undefined
              ? { credentialHome: opts.credentialHome }
              : {}),
            ...(factoryApiKey !== undefined ? { apiKey: factoryApiKey } : {}),
            model: grokRequestedModel as string,
            ...(opts.timeoutMs !== undefined
              ? { timeoutMs: opts.timeoutMs }
              : {}),
            ...(storedExtra !== undefined ? { extra: storedExtra } : {}),
          },
        });
      }
      // /grok-login OAuth ALWAYS wins over env/factory BYOK. Signing in with
      // X means subscription access; leftover XAI_API_KEY must not shadow it.
      // Bearer refreshes via the adapter's I-14 401-recovery hook.
      const factoryApiKey = resolveFactoryApiKey(opts);
      const usesXaiOauth =
        opts.credentialHome !== undefined &&
        isXaiOauthBearer(opts.credentialHome, factoryApiKey);
      const apiKey = factoryApiKey ?? requireFactoryApiKey("grok", opts);
      const model = requireModel("grok", opts.model, defaultModelFor("grok"));
      const cfg: GrokProviderConfig = {
        ...buildCommonConfig(extra),
        ...(opts.credentialHome !== undefined
          ? { credentialHome: opts.credentialHome }
          : {}),
        apiKey,
        model,
        tools: opts.tools ? [...opts.tools] : undefined,
        baseURL: normalizeBaseURL(opts.baseURL) ?? defaultBaseURLFor("grok"),
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        ...(extra.contextWindowTokens !== undefined
          ? { contextWindowTokens: extra.contextWindowTokens }
          : {}),
        ...(extra.parallelToolCalls !== undefined
          ? { parallelToolCalls: extra.parallelToolCalls }
          : {}),
        ...(extra.visionModel ? { visionModel: extra.visionModel } : {}),
        ...(extra.webSearch !== undefined
          ? { webSearch: extra.webSearch }
          : {}),
        ...(extra.searchMode ? { searchMode: extra.searchMode } : {}),
        ...(extra.webSearchOptions
          ? { webSearchOptions: extra.webSearchOptions }
          : {}),
        ...(extra.xSearch !== undefined ? { xSearch: extra.xSearch } : {}),
        ...(extra.xSearchOptions
          ? { xSearchOptions: extra.xSearchOptions }
          : {}),
        ...(extra.codeExecution !== undefined
          ? { codeExecution: extra.codeExecution }
          : {}),
        ...(extra.collectionsSearch
          ? { collectionsSearch: extra.collectionsSearch }
          : {}),
        ...(extra.remoteMcp ? { remoteMcp: extra.remoteMcp } : {}),
      };
      if (usesXaiOauth && !isTrustedXaiOauthInferenceBaseUrl(cfg.baseURL)) {
        throw new Error(
          "grok provider: refusing to send the xAI OAuth bearer to a " +
            `non-xAI base URL (${cfg.baseURL}). Unset the base URL override ` +
            "or set XAI_API_KEY to use an API key with custom gateways.",
        );
      }
      const grokProvider = new GrokProvider(cfg);
      if (usesXaiOauth) {
        // I-14: first real consumer of the adapter's auth-refresh seam.
        // On 401, force a single-flight refresh of the stored OAuth grant,
        // swap the bearer on the live SDK client, and retry.
        grokProvider.withAuthRefreshCallbacks({
          refreshBearer: async () => {
            const refreshed = await forceRefreshXaiOauthCredentials(
              opts.credentialHome!,
            );
            if (refreshed === undefined) {
              // Honesty split: only claim the user is logged out when the
              // stored grant is genuinely dead (quarantined terminal
              // invalid_grant, or gone). A transient network/endpoint
              // failure during refresh must not flap the TUI to
              // "Not logged in" while the grant is still viable — the next
              // 401/pre-flight retries the single-flight refresh.
              if (xaiOauthRequiresRelogin(opts.credentialHome!)) {
                return {
                  kind: "exhausted",
                  reason:
                    "xAI OAuth session expired — run /grok-login to sign in again, " +
                    "or set XAI_API_KEY to use API-key billing",
                };
              }
              return {
                kind: "exhausted",
                reason:
                  "xAI OAuth token refresh temporarily failed (network or " +
                  "provider error). Your sign-in is still valid; retrying — " +
                  "no /grok-login needed",
              };
            }
            grokProvider.applyRefreshedBearer(refreshed.accessToken);
            return { kind: "refreshed", bearer: refreshed.accessToken };
          },
        });
      }
      return markFactoryProvider(grokProvider, {
        provider: "grok",
        options: {
          ...(opts.credentialHome !== undefined
            ? { credentialHome: opts.credentialHome }
            : {}),
          apiKey,
          ...(cfg.baseURL !== undefined ? { baseURL: cfg.baseURL } : {}),
          model,
          ...(cfg.timeoutMs !== undefined ? { timeoutMs: cfg.timeoutMs } : {}),
          ...(readProviderRuntimeExtra(
            cfg as unknown as Record<string, unknown>,
          )
            ? {
                extra: readProviderRuntimeExtra(
                  cfg as unknown as Record<string, unknown>,
                ),
              }
            : {}),
        },
      });
    }
    case "openai": {
      const model = requireModel(
        "openai",
        opts.model,
        defaultModelFor("openai"),
      );
      const oauthConfig =
        extra.authMode === "oauth" &&
        extra.oauth &&
        typeof extra.oauth.accessToken === "string" &&
        extra.oauth.accessToken.trim().length > 0
          ? (extra.oauth as unknown as OpenAIProviderConfig["oauth"])
          : undefined;
      const apiKey = oauthConfig
        ? resolveFactoryApiKey(opts)
        : requireFactoryApiKey("openai", opts);
      const cfg: OpenAIProviderConfig = {
        ...buildCommonConfig(extra),
        ...(apiKey !== undefined ? { apiKey } : {}),
        model,
        providerName: "openai",
        tools: opts.tools ? [...opts.tools] : undefined,
        baseURL: normalizeBaseURL(opts.baseURL) ?? defaultBaseURLFor("openai"),
        useResponsesApi: extra.useResponsesApi ?? true,
        ...(extra.store !== undefined ? { store: extra.store } : {}),
        ...(extra.chatgptBackend !== undefined
          ? { chatgptBackend: extra.chatgptBackend }
          : {}),
        ...(extra.contextWindowTokens !== undefined
          ? { contextWindowTokens: extra.contextWindowTokens }
          : {}),
        ...(extra.authMode ? { authMode: extra.authMode } : {}),
        ...(oauthConfig ? { oauth: oauthConfig } : {}),
        ...(extra.defaultHeaders
          ? { defaultHeaders: extra.defaultHeaders }
          : {}),
        ...(extra.fetchImpl ? { fetchImpl: extra.fetchImpl } : {}),
        ...(extra.organization ? { organization: extra.organization } : {}),
        ...(extra.project ? { project: extra.project } : {}),
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      };
      return markFactoryProvider(new OpenAIProvider(cfg), {
        provider: "openai",
        options: {
          ...(opts.credentialHome !== undefined
            ? { credentialHome: opts.credentialHome }
            : {}),
          ...(apiKey !== undefined ? { apiKey } : {}),
          baseURL: cfg.baseURL,
          model,
          ...(cfg.timeoutMs !== undefined ? { timeoutMs: cfg.timeoutMs } : {}),
          ...(readProviderRuntimeExtra(
            cfg as unknown as Record<string, unknown>,
          )
            ? {
                extra: readProviderRuntimeExtra(
                  cfg as unknown as Record<string, unknown>,
                ),
              }
            : {}),
        },
      });
    }
    case "anthropic": {
      const apiKey = resolveFactoryApiKey(opts);
      const authToken = firstNonEmpty(opts.authToken);
      if (apiKey !== undefined && authToken !== undefined) {
        throw new Error(
          "anthropic provider requires exactly one prepared credential: apiKey or authToken",
        );
      }
      if (apiKey === undefined && authToken === undefined) {
        throw new Error(
          "anthropic provider requires apiKey or authToken in factory options",
        );
      }
      const model = requireModel(
        "anthropic",
        opts.model,
        defaultModelFor("anthropic"),
      );
      const cfg: AnthropicProviderConfig = {
        ...buildCommonConfig(extra),
        ...(apiKey !== undefined ? { apiKey } : {}),
        ...(authToken !== undefined ? { authToken } : {}),
        model,
        tools: opts.tools ? [...opts.tools] : undefined,
        baseURL:
          normalizeBaseURL(opts.baseURL) ?? defaultBaseURLFor("anthropic"),
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        ...(extra.anthropicVersion
          ? { anthropicVersion: extra.anthropicVersion }
          : {}),
        ...(extra.betaHeaders ? { betaHeaders: extra.betaHeaders } : {}),
        ...(extra.contextManagement
          ? { contextManagement: extra.contextManagement }
          : {}),
        ...(extra.defaultHeaders
          ? { defaultHeaders: extra.defaultHeaders }
          : {}),
        ...(extra.fetchImpl ? { fetchImpl: extra.fetchImpl } : {}),
      };
      return markFactoryProvider(new AnthropicProvider(cfg), {
        provider: "anthropic",
        options: {
          ...(opts.credentialHome !== undefined
            ? { credentialHome: opts.credentialHome }
            : {}),
          ...(apiKey !== undefined ? { apiKey } : {}),
          ...(authToken !== undefined ? { authToken } : {}),
          ...(cfg.baseURL !== undefined ? { baseURL: cfg.baseURL } : {}),
          model,
          ...(cfg.timeoutMs !== undefined ? { timeoutMs: cfg.timeoutMs } : {}),
          ...(readProviderRuntimeExtra(
            cfg as unknown as Record<string, unknown>,
          )
            ? {
                extra: readProviderRuntimeExtra(
                  cfg as unknown as Record<string, unknown>,
                ),
              }
            : {}),
        },
      });
    }
    case "ollama": {
      const numCtx = extra.numCtx ?? extra.contextWindowTokens;
      const cfg: OllamaProviderConfig = {
        ...buildCommonConfig(extra),
        model: requireModel("ollama", opts.model, defaultModelFor("ollama")),
        tools: opts.tools ? [...opts.tools] : undefined,
        host:
          normalizeOllamaHost(opts.baseURL) ??
          normalizeOllamaHost(defaultBaseURLFor("ollama")),
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        ...(extra.keepAlive ? { keepAlive: extra.keepAlive } : {}),
        ...(numCtx !== undefined ? { numCtx } : {}),
        ...(extra.numGpu !== undefined ? { numGpu: extra.numGpu } : {}),
      };
      return markFactoryProvider(new OllamaProvider(cfg), {
        provider: "ollama",
        options: {
          ...(opts.credentialHome !== undefined
            ? { credentialHome: opts.credentialHome }
            : {}),
          ...(cfg.host !== undefined ? { baseURL: cfg.host } : {}),
          model: cfg.model,
          ...(cfg.timeoutMs !== undefined ? { timeoutMs: cfg.timeoutMs } : {}),
          ...(readProviderRuntimeExtra(
            cfg as unknown as Record<string, unknown>,
          )
            ? {
                extra: readProviderRuntimeExtra(
                  cfg as unknown as Record<string, unknown>,
                ),
              }
            : {}),
        },
      });
    }
    case "lmstudio":
      return buildOpenAICompatibleProvider("lmstudio", opts, {
        apiKeyMode: "optional",
        useResponsesApi: false,
        providerCtor: LMStudioProvider,
      });
    case "openai-compatible":
      return buildOpenAICompatibleProvider("openai-compatible", opts, {
        apiKeyMode: "optional",
        useResponsesApi: false,
        providerCtor: OpenAICompatibleProvider,
      });
    case "openrouter":
      return buildOpenAICompatibleProvider("openrouter", opts, {
        apiKeyMode: "required",
        useResponsesApi: false,
        providerCtor: OpenRouterProvider,
      });
    case "groq":
      return buildOpenAICompatibleProvider("groq", opts, {
        apiKeyMode: "required",
        useResponsesApi: false,
        providerCtor: GroqProvider,
      });
    case "deepseek":
      return buildOpenAICompatibleProvider("deepseek", opts, {
        apiKeyMode: "required",
        useResponsesApi: false,
        providerCtor: DeepSeekProvider,
      });
    case "mistral":
      return buildOpenAICompatibleProvider("mistral", opts, {
        apiKeyMode: "required",
        useResponsesApi: false,
        providerCtor: MistralProvider,
      });
    case "nvidia-nim":
      return buildOpenAICompatibleProvider("nvidia-nim", opts, {
        apiKeyMode: "required",
        useResponsesApi: false,
        providerCtor: NvidiaNimProvider,
      });
    case "minimax":
      return buildOpenAICompatibleProvider("minimax", opts, {
        apiKeyMode: "required",
        useResponsesApi: false,
        providerCtor: MiniMaxProvider,
      });
    case "github":
      return buildOpenAICompatibleProvider("github", opts, {
        apiKeyMode: "required",
        normalizeModel: (model, baseURL) =>
          normalizeGithubModelForEndpoint(
            model,
            getGithubEndpointType(baseURL),
          ),
        useResponsesApi: shouldUseGithubCopilotResponsesApi,
        providerCtor: GitHubProvider,
      });
    case "gemini": {
      assertNoRetiredGeminiRuntimeFields(opts.extra);
      if (resolveFactoryApiKey(opts) !== undefined) {
        throw new Error(
          "Gemini provider does not accept apiKey after ingress; pass canonical extra.gemini runtime options",
        );
      }
      if (normalizeBaseURL(opts.baseURL) !== undefined) {
        throw new Error(
          "Gemini provider does not accept baseURL after ingress; pass canonical extra.gemini endpointPlan",
        );
      }
      const gemini = extra.gemini;
      if (gemini === undefined) {
        throw new Error(
          "Gemini provider requires canonical extra.gemini runtime options",
        );
      }
      const model = requireModel(
        "gemini",
        opts.model,
        defaultModelFor("gemini"),
      );
      const cfg: GeminiProviderConfig = {
        ...buildCommonConfig(extra),
        credentialPlan: gemini.credentialPlan,
        endpointPlan: gemini.endpointPlan,
        model,
        tools: opts.tools ? [...opts.tools] : undefined,
        ...(gemini.cachedContent
          ? { cachedContent: gemini.cachedContent }
          : {}),
        ...(extra.defaultHeaders
          ? { defaultHeaders: extra.defaultHeaders }
          : {}),
        ...(extra.fetchImpl ? { fetchImpl: extra.fetchImpl } : {}),
        ...(extra.contextWindowTokens !== undefined
          ? { contextWindowTokens: extra.contextWindowTokens }
          : {}),
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      };
      const storedExtra = readProviderRuntimeExtra({
        ...(cfg as unknown as Record<string, unknown>),
        gemini,
      });
      return markFactoryProvider(new GeminiProvider(cfg), {
        provider: "gemini",
        options: {
          ...(opts.credentialHome !== undefined
            ? { credentialHome: opts.credentialHome }
            : {}),
          model,
          ...(cfg.timeoutMs !== undefined ? { timeoutMs: cfg.timeoutMs } : {}),
          ...(storedExtra !== undefined ? { extra: storedExtra } : {}),
        },
      });
    }
    case "amazon-bedrock": {
      const endpoint = resolveBuiltInProviderRegionalEndpoint(
        "amazon-bedrock",
        firstNonEmpty(extra.region),
      );
      if (endpoint === undefined) {
        throw new Error(
          "amazon-bedrock registry metadata is missing a regional endpoint",
        );
      }
      const region = endpoint.region;
      const accessKeyId = firstNonEmpty(extra.accessKeyId);
      if (accessKeyId === undefined) {
        throw new Error(
          "amazon-bedrock provider requires accessKeyId in factory options extra",
        );
      }
      const secretAccessKey = firstNonEmpty(extra.secretAccessKey);
      if (secretAccessKey === undefined) {
        throw new Error(
          "amazon-bedrock provider requires secretAccessKey in factory options extra",
        );
      }
      const sessionToken = firstNonEmpty(extra.sessionToken);
      const model = requireModel(
        "amazon-bedrock",
        opts.model,
        defaultModelFor("amazon-bedrock"),
      );
      const cfg: BedrockProviderConfig = {
        ...buildCommonConfig(extra),
        accessKeyId,
        secretAccessKey,
        ...(sessionToken !== undefined ? { sessionToken } : {}),
        region,
        model,
        tools: opts.tools ? [...opts.tools] : undefined,
        baseURL: normalizeBaseURL(opts.baseURL) ?? endpoint.baseURL,
        ...(extra.fetchImpl ? { fetchImpl: extra.fetchImpl } : {}),
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      };
      const factoryExtra = readProviderRuntimeExtra(
        cfg as unknown as Record<string, unknown>,
      );
      return markFactoryProvider(new BedrockProvider(cfg), {
        provider: "amazon-bedrock",
        options: {
          ...(opts.credentialHome !== undefined
            ? { credentialHome: opts.credentialHome }
            : {}),
          baseURL: cfg.baseURL,
          model,
          ...(cfg.timeoutMs !== undefined ? { timeoutMs: cfg.timeoutMs } : {}),
          ...(factoryExtra ? { extra: factoryExtra } : {}),
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
  const normalizedProvider = resolveBuiltInProviderSlug(provider);
  if (normalizedProvider === undefined) {
    throw new Error(`unknown provider "${provider?.trim() ?? ""}"`);
  }
  const instance = createProvider(normalizedProvider, opts);
  return {
    provider: normalizedProvider,
    model: readPreparedModel(instance, opts.model),
    instance,
  };
}
