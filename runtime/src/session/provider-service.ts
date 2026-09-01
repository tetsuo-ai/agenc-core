/** Session-owned provider authority. */

import {
  createProvider,
  isFactoryProvider,
  resolveBuiltInProviderSlug,
  readProviderFactoryOptions,
  readProviderIdentity,
  type ProviderFactoryOptions,
  type ProviderName,
} from "../llm/provider.js";
import {
  requireProviderRuntimeCredential,
  resolveProviderRuntimeAuthority,
  snapshotProviderEnvironment,
  type ProviderEnvironment,
  type ReadSavedProviderApiKey,
} from "../llm/provider-options.js";
import type { LLMProvider } from "../llm/types.js";
import type { AuthBackend, AuthSubscriptionTier } from "../auth/backend.js";

export type { ReadSavedProviderApiKey } from "../llm/provider-options.js";

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
  readonly managedDefaultOutputCap: boolean;
}

export interface ProviderPreparationRuntime {
  readonly managedKeysEnabled?: boolean;
  readonly freeManagedCredential?: boolean;
  readonly applyManagedDefaultOutputCap?: boolean;
}

export interface ProviderPreparationRequest {
  readonly requested: ProviderFactoryOptions;
  readonly runtime?: ProviderPreparationRuntime;
}

export type ResolveProviderPreparationRequest = (
  selection: ProviderSelection,
) => ProviderPreparationRequest | Promise<ProviderPreparationRequest>;

function firstNonEmpty(
  ...values: Array<string | undefined>
): string | undefined {
  for (const value of values) {
    const normalized = value?.trim();
    if (normalized) return normalized;
  }
  return undefined;
}

function snapshotPreparedValue(
  value: unknown,
  seen: WeakMap<object, unknown>,
): unknown {
  if (value === null || typeof value !== "object") return value;
  const prior = seen.get(value);
  if (prior !== undefined) return prior;
  if (Array.isArray(value)) {
    const snapshot: unknown[] = [];
    seen.set(value, snapshot);
    snapshot.push(...value.map((entry) => snapshotPreparedValue(entry, seen)));
    return Object.freeze(snapshot);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  const snapshot: Record<string, unknown> = Object.create(prototype);
  seen.set(value, snapshot);
  for (const [key, entry] of Object.entries(value)) {
    snapshot[key] = snapshotPreparedValue(entry, seen);
  }
  return Object.freeze(snapshot);
}

function snapshotProviderRuntimeExtra(
  extra: Readonly<Record<string, unknown>> | undefined,
): ProviderFactoryOptions["extra"] {
  return snapshotPreparedValue(
    extra ?? {},
    new WeakMap<object, unknown>(),
  ) as ProviderFactoryOptions["extra"];
}

function cloneOptions(options: ProviderFactoryOptions): ProviderFactoryOptions {
  return Object.freeze({
    ...(options.credentialHome !== undefined
      ? { credentialHome: options.credentialHome }
      : {}),
    ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
    ...(options.authToken !== undefined
      ? { authToken: options.authToken }
      : {}),
    ...(options.baseURL !== undefined ? { baseURL: options.baseURL } : {}),
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(options.tools !== undefined
      ? { tools: Object.freeze([...options.tools]) }
      : {}),
    ...(options.timeoutMs !== undefined
      ? { timeoutMs: options.timeoutMs }
      : {}),
    ...(options.extra !== undefined
      ? { extra: snapshotProviderRuntimeExtra(options.extra) }
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
  const explicitProviderName = firstNonEmpty(params.providerName);
  const explicitProviderIdentity = explicitProviderName === undefined
    ? undefined
    : resolveBuiltInProviderSlug(explicitProviderName);
  const factoryProviderIdentity = isFactoryProvider(params.provider)
    ? readProviderIdentity(params.provider)
    : null;
  if (factoryProviderIdentity !== null && explicitProviderName !== undefined) {
    if (explicitProviderIdentity === undefined) {
      throw new Error(`unknown bound provider "${explicitProviderName}"`);
    }
    if (factoryProviderIdentity !== explicitProviderIdentity) {
      throw new Error(
        `provider binding identity conflict: factory is "${factoryProviderIdentity}" but explicit provider is "${explicitProviderIdentity}"`,
      );
    }
  }
  const providerName =
    factoryProviderIdentity ??
    explicitProviderIdentity ??
    explicitProviderName ??
    readProviderIdentity(params.provider) ??
    firstNonEmpty(params.provider.name);
  if (providerName === undefined) {
    throw new Error("provider binding requires an explicit provider identity");
  }
  const factoryModel = firstNonEmpty(options.model);
  const explicitModel = firstNonEmpty(params.model);
  if (
    factoryModel !== undefined &&
    explicitModel !== undefined &&
    factoryModel !== explicitModel
  ) {
    throw new Error(
      `${providerName} provider binding model conflict: factory is "${factoryModel}" but explicit model is "${explicitModel}"`,
    );
  }
  const model = factoryModel ?? explicitModel;
  if (model === undefined) {
    throw new Error(`${providerName} provider binding requires an explicit model`);
  }
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
  readonly #authBackend: AuthBackend | undefined;
  readonly #sessionId: string | undefined;
  readonly #subscriptionTier: AuthSubscriptionTier | undefined;
  readonly #resolvePreparationRequest:
    | ResolveProviderPreparationRequest
    | undefined;
  #binding: ProviderBinding;

  constructor(params: {
    readonly initialProvider: LLMProvider;
    readonly initialProviderName?: string;
    readonly initialModel?: string;
    readonly environment?: ProviderEnvironment;
    readonly readSavedApiKey?: ReadSavedProviderApiKey;
    readonly authBackend?: AuthBackend;
    readonly sessionId?: string;
    readonly subscriptionTier?: AuthSubscriptionTier;
    readonly resolvePreparationRequest?: ResolveProviderPreparationRequest;
  }) {
    this.#environment = snapshotProviderEnvironment(params.environment ?? {});
    const initialBinding = bindingFromProvider({
      provider: params.initialProvider,
      ...(params.initialProviderName !== undefined
        ? { providerName: params.initialProviderName }
        : {}),
      ...(params.initialModel !== undefined
        ? { model: params.initialModel }
        : {}),
    });
    this.#binding = initialBinding;
    this.#credentialHome = initialBinding.factoryOptions.credentialHome;
    this.#readSavedApiKey = params.readSavedApiKey;
    this.#authBackend = params.authBackend;
    this.#sessionId = params.sessionId;
    this.#subscriptionTier = params.subscriptionTier;
    this.#resolvePreparationRequest = params.resolvePreparationRequest;
  }

  current(): ProviderBinding {
    return this.#binding;
  }

  environment(): ProviderEnvironment {
    return this.#environment;
  }

  async prepare(
    selection: ProviderSelection,
    requested?: ProviderFactoryOptions,
    runtime: ProviderPreparationRuntime = {},
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
    const preparation = requested === undefined
      ? await this.#resolvePreparationRequest?.({ provider, model })
      : { requested, runtime };
    if (preparation === undefined) {
      throw new Error(
        `${provider} provider switch has no canonical preparation request`,
      );
    }
    const requestedOptions = preparation.requested;
    const runtimeOptions = preparation.runtime ?? {};
    const credentialHome = requestedOptions.credentialHome ?? this.#credentialHome;
    const authority = await resolveProviderRuntimeAuthority(
      provider,
      {
        ...requestedOptions,
        ...(credentialHome !== undefined ? { credentialHome } : {}),
        model,
      },
      this.#environment,
      {
        ...(this.#readSavedApiKey !== undefined
          ? { readSavedApiKey: this.#readSavedApiKey }
          : {}),
        ...(this.#authBackend !== undefined
          ? { authBackend: this.#authBackend }
          : {}),
        ...(this.#sessionId !== undefined ? { sessionId: this.#sessionId } : {}),
        ...(this.#subscriptionTier !== undefined
          ? { subscriptionTier: this.#subscriptionTier }
          : {}),
        ...(runtimeOptions.managedKeysEnabled !== undefined
          ? { managedKeysEnabled: runtimeOptions.managedKeysEnabled }
          : {}),
        ...(runtimeOptions.freeManagedCredential !== undefined
          ? { freeManagedCredential: runtimeOptions.freeManagedCredential }
          : {}),
      },
    );
    requireProviderRuntimeCredential(provider, authority);
    const instance = createProvider(provider, authority.factoryOptions);
    return Object.freeze({
      expectedRevision,
      managedDefaultOutputCap:
        authority.managedCredential &&
        runtimeOptions.applyManagedDefaultOutputCap === true,
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
    assertBuiltInProviderBinding(prepared.binding);
    this.#binding = prepared.binding;
    return this.#binding;
  }

  restoreAfterFailedCommit(
    committed: ProviderBinding,
    previous: ProviderBinding,
  ): ProviderBinding {
    if (this.#binding !== committed) {
      throw new Error(
        "provider rollback rejected because the live binding changed after commit",
      );
    }
    if (previous.revision + 1 !== committed.revision) {
      throw new Error(
        "provider rollback rejected because the previous binding does not match the committed revision",
      );
    }
    const restored = Object.freeze({
      ...previous,
      revision: committed.revision + 1,
    });
    this.#binding = restored;
    return restored;
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
