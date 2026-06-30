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
import type {
  ProviderFactoryOptions,
  ProviderName,
} from "../../provider.js";

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

  constructor(config: AgenCProviderConfig) {
    this.#config = config;
  }

  async chat(
    messages: LLMMessage[],
    options?: LLMChatOptions,
  ): Promise<LLMResponse> {
    const delegate = await this.resolveDelegate(options);
    return delegate.instance.chat(messages, {
      ...options,
      model: delegate.model,
    });
  }

  async chatStream(
    messages: LLMMessage[],
    onChunk: StreamProgressCallback,
    options?: LLMChatOptions,
  ): Promise<LLMResponse> {
    const delegate = await this.resolveDelegate(options);
    return delegate.instance.chatStream(messages, onChunk, {
      ...options,
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

  async getExecutionProfile(): Promise<LLMProviderExecutionProfile> {
    const delegate = await this.resolveDelegate();
    return (
      (await delegate.instance.getExecutionProfile?.()) ?? {
        provider: delegate.provider,
        model: delegate.model,
      }
    );
  }

  private async resolveDelegate(
    options?: Pick<LLMChatOptions, "model">,
  ): Promise<ResolvedAgenCDelegate> {
    const requestedModel =
      firstNonEmpty(options?.model, this.#config.model) ?? "agenc";
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
    const apiKey = firstNonEmpty(key.apiKey);
    if (apiKey === undefined) {
      throw new Error("AgenCProvider managed key vending returned an empty key");
    }
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

function concreteProviderName(provider: string): ConcreteProviderName {
  const normalized = provider.trim().toLowerCase() === "xai"
    ? "grok"
    : provider.trim().toLowerCase();
  if (normalized === "agenc") {
    throw new Error("AgenCProvider model inference returned provider agenc");
  }
  if ((CONCRETE_PROVIDER_NAMES as readonly string[]).includes(normalized)) {
    return normalized as ConcreteProviderName;
  }
  throw new Error(
    `AgenCProvider model inference returned unknown provider "${provider}"`,
  );
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function parseExpiresAtMs(expiresAt: string | undefined): number | undefined {
  if (expiresAt === undefined) return undefined;
  const parsed = Date.parse(expiresAt);
  return Number.isFinite(parsed) ? parsed : undefined;
}
