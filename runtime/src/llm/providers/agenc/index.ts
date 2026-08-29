/**
 * AgenC-native hosted provider scaffold.
 *
 * This provider exposes the same LLMProvider surface as concrete providers
 * while routing model selection and managed key vending through AuthBackend.
 * A-04 owns the full hosted implementation; LP-19 records the provider
 * interface shape and factory integration.
 */

import type {
  AuthBackend,
  AuthSessionId,
  AuthSubscriptionTier,
  AuthVendedCredential,
} from "../../../auth/backend.js";
import type {
  LLMChatOptions,
  LLMMessage,
  LLMProvider,
  LLMProviderConfig,
  LLMProviderExecutionProfile,
  LLMResponse,
  StreamProgressCallback,
} from "../../types.js";
import type { ProviderFactoryOptions, ProviderName } from "../../provider.js";
import { normalizeProviderIdentity } from "../../../provider-identity.js";
import { BUILT_IN_PROVIDER_DEFAULT_MODELS } from "../../registry/provider-info.js";

type ConcreteProviderName = Exclude<ProviderName, "agenc">;

export type AgenCConcreteProviderFactory = (
  provider: ConcreteProviderName,
  options: ProviderFactoryOptions,
) => LLMProvider;

const DEFAULT_DELEGATE_CACHE_TTL_MS = 5 * 60 * 1000;

export interface AgenCProviderConfig extends LLMProviderConfig {
  readonly authBackend: AuthBackend;
  readonly sessionId: AuthSessionId;
  readonly subscriptionTier?: AuthSubscriptionTier;
  readonly providerFactory: AgenCConcreteProviderFactory;
  readonly providerOptions?: Pick<ProviderFactoryOptions, "baseURL" | "extra">;
  readonly delegateCacheTtlMs?: number;
  readonly nowMs?: () => number;
}

interface ResolvedAgenCDelegate {
  readonly provider: ConcreteProviderName;
  readonly model: string;
  readonly instance: LLMProvider;
  readonly expiresAtMs?: number;
}

const CONCRETE_PROVIDER_NAMES = [
  "grok",
  "openai",
  "anthropic",
  "ollama",
  "lmstudio",
  "openrouter",
  "groq",
  "deepseek",
  "gemini",
] as const satisfies readonly ConcreteProviderName[];

export class AgenCProvider implements LLMProvider {
  readonly name = "agenc";

  readonly #config: AgenCProviderConfig;
  readonly #delegates = new Map<string, Promise<ResolvedAgenCDelegate>>();
  readonly #preparedExecutions = new WeakMap<object, ResolvedAgenCDelegate>();

  constructor(config: AgenCProviderConfig) {
    this.#config = config;
  }

  async chat(
    messages: LLMMessage[],
    options?: LLMChatOptions,
  ): Promise<LLMResponse> {
    const { delegate, delegateOptions } = await this.executionFor(options);
    return delegate.instance.chat(messages, {
      ...delegateOptions,
      model: delegate.model,
    });
  }

  async chatStream(
    messages: LLMMessage[],
    onChunk: StreamProgressCallback,
    options?: LLMChatOptions,
  ): Promise<LLMResponse> {
    const { delegate, delegateOptions } = await this.executionFor(options);
    return delegate.instance.chatStream(messages, onChunk, {
      ...delegateOptions,
      model: delegate.model,
    });
  }

  async healthCheck(): Promise<boolean> {
    try {
      const delegate = await this.resolveDelegate();
      return await delegate.instance.healthCheck();
    } catch {
      return false;
    }
  }

  /**
   * Create a tool-free provider owned by the editor prediction service.
   *
   * This intentionally does not share delegate instances or provider-side
   * conversation state with the primary Agent session. A concrete override
   * vends its own short-lived credential through the same session-scoped auth
   * backend; the default route remains hosted AgenC model inference.
   */
  async forkForCodePrediction(options: {
    readonly provider?: ProviderName;
    readonly model?: string;
    readonly timeoutMs: number;
    readonly maxOutputTokens: number;
  }): Promise<LLMProvider> {
    if (options.provider === undefined || options.provider === "agenc") {
      return new AgenCProvider({
        ...this.#config,
        model:
          firstNonEmpty(options.model, this.#config.model) ??
          BUILT_IN_PROVIDER_DEFAULT_MODELS.agenc,
        tools: [],
        timeoutMs: options.timeoutMs,
        maxTokens: options.maxOutputTokens,
        maxRetries: 0,
        providerFallback: undefined,
      });
    }
    const provider = concreteProviderName(options.provider);
    const key = await this.#config.authBackend.vendKey(
      provider,
      this.#config.sessionId,
    );
    if (key.provider !== provider || key.sessionId !== this.#config.sessionId) {
      throw new Error(`prediction credential route mismatch for ${provider}`);
    }
    const apiKey = requireVendedApiKey(
      key,
      `prediction credential vending for ${provider}`,
    );
    const baseURL = firstNonEmpty(
      key.baseUrl,
      this.#config.providerOptions?.baseURL,
    );
    return this.#config.providerFactory(provider, {
      apiKey,
      ...(baseURL !== undefined ? { baseURL } : {}),
      ...(options.model !== undefined ? { model: options.model } : {}),
      tools: [],
      timeoutMs: options.timeoutMs,
      extra: {
        ...(this.#config.providerOptions?.extra ?? {}),
        maxTokens: options.maxOutputTokens,
        maxRetries: 0,
        temperature: 0,
        ...(key.baseUrl !== undefined ? { managedGateway: true } : {}),
      },
    });
  }

  async dispose(): Promise<void> {
    const delegates = [...this.#delegates.values()];
    this.#delegates.clear();
    await Promise.allSettled(
      delegates.map(async (delegatePromise) => {
        const delegate = await delegatePromise;
        await delegate.instance.dispose?.();
      }),
    );
  }

  async getExecutionProfile(
    options?: LLMChatOptions,
  ): Promise<LLMProviderExecutionProfile> {
    const delegate = await this.resolveDelegate(options);
    const profile = (await delegate.instance.getExecutionProfile?.({
      ...withoutExecutionHandle(options),
      model: delegate.model,
    })) ?? {
      provider: delegate.provider,
      model: delegate.model,
      usageReporting: "unavailable" as const,
      supportsMaxOutputTokens: false,
    };
    const providerExecutionHandle = Object.freeze({});
    this.#preparedExecutions.set(providerExecutionHandle, delegate);
    return {
      ...profile,
      // The resolved delegate is authoritative. A concrete adapter profile may
      // report constructor defaults, but the managed router controls the actual
      // provider/model selected for this request.
      provider: delegate.provider,
      model: delegate.model,
      providerExecutionHandle,
    };
  }

  private async executionFor(options?: LLMChatOptions): Promise<{
    readonly delegate: ResolvedAgenCDelegate;
    readonly delegateOptions: LLMChatOptions;
  }> {
    const handle = options?.providerExecutionHandle;
    if (handle === undefined) {
      return {
        delegate: await this.resolveDelegate(options),
        delegateOptions: withoutExecutionHandle(options),
      };
    }
    const delegate = this.#preparedExecutions.get(handle);
    if (delegate === undefined) {
      throw new Error(
        "AgenCProvider received an invalid or already-consumed execution handle",
      );
    }
    // One prepared profile authorizes exactly one adapter invocation. Provider
    // adapters are separately constrained to one wire attempt by admission.
    this.#preparedExecutions.delete(handle);
    return {
      delegate,
      delegateOptions: withoutExecutionHandle(options),
    };
  }

  private async resolveDelegate(
    options?: Pick<LLMChatOptions, "model">,
  ): Promise<ResolvedAgenCDelegate> {
    const requestedModel =
      firstNonEmpty(options?.model, this.#config.model) ??
      BUILT_IN_PROVIDER_DEFAULT_MODELS.agenc;
    const cacheKey = `${this.#config.subscriptionTier ?? ""}\0${requestedModel}`;
    const existing = this.#delegates.get(cacheKey);
    if (existing !== undefined) {
      const delegate = await existing;
      if (!this.isDelegateExpired(delegate)) return delegate;
      if (this.#delegates.get(cacheKey) === existing) {
        this.#delegates.delete(cacheKey);
      }
    }

    const resolved = this.createDelegate(requestedModel)
      .then((delegate) => {
        if (
          this.isDelegateExpired(delegate) &&
          this.#delegates.get(cacheKey) === resolved
        ) {
          this.#delegates.delete(cacheKey);
        }
        return delegate;
      })
      .catch((error) => {
        this.#delegates.delete(cacheKey);
        throw error;
      });
    this.#delegates.set(cacheKey, resolved);
    return resolved;
  }

  private async createDelegate(
    requestedModel: string,
  ): Promise<ResolvedAgenCDelegate> {
    const inferred = await this.#config.authBackend.inferAgencModel({
      provider: "agenc",
      requestedModel,
      sessionId: this.#config.sessionId,
      ...(this.#config.subscriptionTier !== undefined
        ? { subscriptionTier: this.#config.subscriptionTier }
        : {}),
    });
    const provider = concreteProviderName(inferred.provider);
    const model = firstNonEmpty(inferred.model);
    if (model === undefined) {
      throw new Error("AgenCProvider model inference returned an empty model");
    }
    const key = await this.#config.authBackend.vendKey(
      provider,
      this.#config.sessionId,
    );
    const apiKey = requireVendedApiKey(
      key,
      "AgenCProvider managed credential vending",
    );
    const baseURL = firstNonEmpty(key.baseUrl);
    const expiresAtMs =
      parseExpiresAtMs(key.expiresAt) ??
      this.nowMs() + this.delegateCacheTtlMs();
    return {
      provider,
      model,
      instance: this.#config.providerFactory(provider, {
        apiKey,
        ...(baseURL !== undefined
          ? { baseURL }
          : this.#config.providerOptions?.baseURL !== undefined
            ? { baseURL: this.#config.providerOptions.baseURL }
            : {}),
        model,
        tools: this.#config.tools ? [...this.#config.tools] : undefined,
        ...(this.#config.timeoutMs !== undefined
          ? { timeoutMs: this.#config.timeoutMs }
          : {}),
        extra: {
          ...(this.#config.providerOptions?.extra ?? {}),
          ...(baseURL !== undefined ? { managedGateway: true } : {}),
        },
      }),
      ...(expiresAtMs !== undefined ? { expiresAtMs } : {}),
    };
  }

  private isDelegateExpired(delegate: ResolvedAgenCDelegate): boolean {
    return (
      delegate.expiresAtMs !== undefined && delegate.expiresAtMs <= this.nowMs()
    );
  }

  private nowMs(): number {
    return this.#config.nowMs?.() ?? Date.now();
  }

  private delegateCacheTtlMs(): number {
    const configured = this.#config.delegateCacheTtlMs;
    return typeof configured === "number" &&
      Number.isFinite(configured) &&
      configured > 0
      ? Math.floor(configured)
      : DEFAULT_DELEGATE_CACHE_TTL_MS;
  }
}

function withoutExecutionHandle(
  options: LLMChatOptions | undefined,
): LLMChatOptions {
  if (options === undefined) return {};
  const {
    providerExecutionHandle: _providerExecutionHandle,
    ...delegateOptions
  } = options;
  return delegateOptions;
}

function concreteProviderName(provider: string): ConcreteProviderName {
  const normalized = normalizeProviderIdentity(
    provider,
    "AgenC managed provider inference",
  );
  if (normalized === "agenc") {
    throw new Error("AgenCProvider model inference returned provider agenc");
  }
  if (normalized === undefined) {
    throw new Error(
      `AgenCProvider model inference returned an empty provider`,
    );
  }
  if ((CONCRETE_PROVIDER_NAMES as readonly string[]).includes(normalized)) {
    return normalized as ConcreteProviderName;
  }
  throw new Error(
    `AgenCProvider model inference returned unknown provider "${provider}"`,
  );
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

function requireVendedApiKey(
  credential: AuthVendedCredential,
  operation: string,
): string {
  if (credential.kind !== "api-key") {
    throw new Error(`${operation} returned non-API-key credentials`);
  }
  const apiKey = firstNonEmpty(credential.apiKey);
  if (apiKey === undefined) {
    throw new Error(`${operation} returned an empty API key`);
  }
  return apiKey;
}

function parseExpiresAtMs(expiresAt: string | undefined): number | undefined {
  if (expiresAt === undefined) return undefined;
  const parsed = Date.parse(expiresAt);
  return Number.isFinite(parsed) ? parsed : undefined;
}
