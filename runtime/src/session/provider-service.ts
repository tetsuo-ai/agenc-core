/** Session-owned provider authority. */

import {
  createProvider,
  resolveBuiltInProviderSlug,
  readProviderFactoryOptions,
  readProviderIdentity,
  type ProviderFactoryOptions,
  type ProviderName,
} from "../llm/provider.js";
import {
  resolveProviderFactoryOptions,
  snapshotProviderEnvironment,
  type ProviderEnvironment,
} from "../llm/provider-options.js";
import type { LLMProvider } from "../llm/types.js";

export interface ProviderSelection {
  readonly provider: string;
  readonly model: string;
}

export interface ProviderBinding {
  readonly provider: string;
  readonly model: string;
  readonly instance: LLMProvider;
  readonly factoryOptions: ProviderFactoryOptions;
  readonly revision: number;
}

export interface PreparedProviderBinding {
  readonly binding: ProviderBinding;
  readonly expectedRevision: number;
}

export type ReadSavedProviderApiKey = (
  provider: ProviderName,
) => Promise<string | undefined>;

function firstNonEmpty(
  ...values: Array<string | undefined>
): string | undefined {
  for (const value of values) {
    const normalized = value?.trim();
    if (normalized) return normalized;
  }
  return undefined;
}

function cloneOptions(options: ProviderFactoryOptions): ProviderFactoryOptions {
  return Object.freeze({
    ...(options.credentialHome !== undefined
      ? { credentialHome: options.credentialHome }
      : {}),
    ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
    ...(options.baseURL !== undefined ? { baseURL: options.baseURL } : {}),
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(options.tools !== undefined ? { tools: [...options.tools] } : {}),
    ...(options.timeoutMs !== undefined
      ? { timeoutMs: options.timeoutMs }
      : {}),
    ...(options.extra !== undefined
      ? { extra: Object.freeze({ ...options.extra }) }
      : {}),
  });
}

export function bindingFromProvider(params: {
  readonly provider: LLMProvider;
  readonly providerName?: string;
  readonly model?: string;
  readonly revision?: number;
}): ProviderBinding {
  const options = readProviderFactoryOptions(params.provider);
  const providerName =
    readProviderIdentity(params.provider, params.providerName) ??
    firstNonEmpty(params.providerName, params.provider.name) ??
    "unknown";
  const model =
    firstNonEmpty(options.model, params.model) ??
    firstNonEmpty(
      (params.provider as { config?: { model?: string } }).config?.model,
    ) ??
    "unknown";
  return Object.freeze({
    provider: providerName,
    model,
    instance: params.provider,
    factoryOptions: cloneOptions({ ...options, model }),
    revision: params.revision ?? 0,
  });
}

/**
 * Owns the active provider for exactly one session. Preparing a switch never
 * mutates the active binding; commit rejects a stale preparation instead of
 * allowing two concurrent switch attempts to overwrite one another.
 */
export class SessionProviderService {
  readonly #environment: ProviderEnvironment;
  readonly #credentialHome: ProviderFactoryOptions["credentialHome"];
  readonly #readSavedApiKey: ReadSavedProviderApiKey | undefined;
  readonly #committedFactoryOptionsByProvider = new Map<
    ProviderName,
    ProviderFactoryOptions
  >();
  #binding: ProviderBinding;

  constructor(params: {
    readonly initialProvider: LLMProvider;
    readonly initialProviderName?: string;
    readonly initialModel?: string;
    readonly environment?: ProviderEnvironment;
    readonly readSavedApiKey?: ReadSavedProviderApiKey;
  }) {
    this.#environment = snapshotProviderEnvironment(params.environment ?? {});
    this.#binding = bindingFromProvider({
      provider: params.initialProvider,
      ...(params.initialProviderName !== undefined
        ? { providerName: params.initialProviderName }
        : {}),
      ...(params.initialModel !== undefined
        ? { model: params.initialModel }
        : {}),
    });
    this.#credentialHome = this.#binding.factoryOptions.credentialHome;
    this.#readSavedApiKey = params.readSavedApiKey;
    const initialProvider = resolveBuiltInProviderSlug(this.#binding.provider);
    if (initialProvider !== undefined) {
      this.#committedFactoryOptionsByProvider.set(
        initialProvider,
        cloneOptions(this.#binding.factoryOptions),
      );
    }
  }

  current(): ProviderBinding {
    return this.#binding;
  }

  environment(): ProviderEnvironment {
    return this.#environment;
  }

  committedFactoryOptions(
    provider: string,
  ): ProviderFactoryOptions | undefined {
    const normalized = resolveBuiltInProviderSlug(provider);
    if (normalized === undefined) return undefined;
    const options = this.#committedFactoryOptionsByProvider.get(normalized);
    return options === undefined ? undefined : cloneOptions(options);
  }

  async prepare(
    selection: ProviderSelection,
    requested: ProviderFactoryOptions,
  ): Promise<PreparedProviderBinding> {
    const provider = resolveBuiltInProviderSlug(selection.provider);
    if (provider === undefined) {
      throw new Error(`unknown provider "${selection.provider.trim()}"`);
    }
    const model = selection.model.trim();
    if (model.length === 0) {
      throw new Error(`${provider} provider switch requires an explicit model`);
    }
    const expectedRevision = this.#binding.revision;
    const savedApiKey =
      this.#readSavedApiKey === undefined ||
      this.#committedFactoryOptionsByProvider.has(provider)
        ? undefined
        : await this.#readSavedApiKey(provider);
    const credentialHome = requested.credentialHome ?? this.#credentialHome;
    const resolved = resolveProviderFactoryOptions(
      provider,
      {
        ...requested,
        ...(credentialHome !== undefined ? { credentialHome } : {}),
        model,
      },
      this.#environment,
      savedApiKey === undefined ? {} : { savedApiKey },
    );
    const instance = createProvider(provider, resolved);
    return Object.freeze({
      expectedRevision,
      binding: bindingFromProvider({
        provider: instance,
        providerName: provider,
        model,
        revision: expectedRevision + 1,
      }),
    });
  }

  commit(prepared: PreparedProviderBinding): ProviderBinding {
    if (prepared.expectedRevision !== this.#binding.revision) {
      throw new Error(
        "provider switch rejected because the session provider changed while the switch was being prepared",
      );
    }
    this.#binding = prepared.binding;
    const provider = assertBuiltInProviderBinding(this.#binding);
    this.#committedFactoryOptionsByProvider.set(
      provider,
      cloneOptions(this.#binding.factoryOptions),
    );
    return this.#binding;
  }
}

export function assertBuiltInProviderBinding(
  binding: ProviderBinding,
): ProviderName {
  const normalized = resolveBuiltInProviderSlug(binding.provider);
  if (normalized === undefined) {
    throw new Error(`unknown bound provider "${binding.provider}"`);
  }
  return normalized;
}
