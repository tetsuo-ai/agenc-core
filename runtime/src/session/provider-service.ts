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
  resolveProviderLocalCredentialAuthority,
  resolveProviderRuntimeAuthority,
  snapshotProviderEnvironment,
  type ProviderEnvironment,
  type ReadSavedProviderApiKey,
} from "../llm/provider-options.js";
import type { LLMProvider } from "../llm/types.js";
import type { AuthBackend, AuthSubscriptionTier } from "../auth/backend.js";
import {
  resolveBuiltInProviderInfo,
  resolveBuiltInProviderRegionalEndpoint,
} from "../llm/registry/provider-info.js";
import { resolveProviderBaseURLEnvironment } from "../llm/registry/provider-ingress.js";
import { readGeminiRuntimeOptions } from "../llm/providers/gemini/runtime-options.js";
import { createPinnedProviderFetch } from "../llm/credential-redirect-fetch.js";
import { isGrokComposerModel } from "../llm/providers/grok/acp-adapter.js";
import { assertSupportedCrossProviderAuth } from "../llm/cross-provider-auth.js";
import { CHATGPT_BACKEND_BASE_URL } from "../llm/providers/openai/chatgpt-backend.js";
import { assertSignInChildModelEligible, type SignInChildModelCapabilities } from "../llm/sign-in-child-models.js";

export type { ReadSavedProviderApiKey } from "../llm/provider-options.js";

const pinnedChildProviders = new WeakSet<LLMProvider>();

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
  readonly billingSource?: "byok" | "sign_in" | "managed" | "local";
  readonly authProfile?: "api_key" | "sign_in" | "managed" | "local" | "aws_sigv4";
  readonly signInModelCapabilities?: SignInChildModelCapabilities;
}

export interface ApprovedChildAuthority {
  readonly endpoint: string;
  readonly authProfile: NonNullable<PreparedProviderBinding["authProfile"]>;
  readonly billingSource: NonNullable<PreparedProviderBinding["billingSource"]>;
}

export interface ProviderPreparationRuntime {
  readonly signal?: AbortSignal;
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
  readonly #crossProviderProvenance: boolean;
  readonly #destinationLock: ProviderSelection | undefined;
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
    readonly crossProviderProvenance?: boolean;
    readonly destinationLock?: ProviderSelection;
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
    this.#crossProviderProvenance = params.crossProviderProvenance === true ||
      pinnedChildProviders.has(params.initialProvider) ||
      initialBinding.factoryOptions.extra?.canonicalEndpointRequired === true;
    this.#destinationLock = params.destinationLock === undefined
      ? undefined : Object.freeze({ ...params.destinationLock });
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

  /** Give a child an independent binding with the same captured authority sources. */
  forkForChild(provider: LLMProvider, selection: ProviderSelection, destinationLock?: ProviderSelection): SessionProviderService {
    return new SessionProviderService({
      initialProvider: provider,
      initialProviderName: selection.provider,
      initialModel: selection.model,
      environment: this.#environment,
      ...(this.#readSavedApiKey !== undefined ? { readSavedApiKey: this.#readSavedApiKey } : {}),
      ...(this.#authBackend !== undefined ? { authBackend: this.#authBackend } : {}),
      ...(this.#sessionId !== undefined ? { sessionId: this.#sessionId } : {}),
      ...(this.#subscriptionTier !== undefined ? { subscriptionTier: this.#subscriptionTier } : {}),
      ...(this.#resolvePreparationRequest !== undefined
        ? { resolvePreparationRequest: this.#resolvePreparationRequest } : {}),
      crossProviderProvenance: this.#crossProviderProvenance || destinationLock !== undefined || pinnedChildProviders.has(provider) ||
        readProviderFactoryOptions(provider).extra?.canonicalEndpointRequired === true,
      ...(destinationLock !== undefined ? { destinationLock } : {}),
    });
  }

  /** Local-only destination preview for the consent card. No credential is
   * refreshed, vended, or sent to a provider from this method. */
  async previewChildDestination(selection: ProviderSelection, concreteDestination?: ProviderSelection): Promise<{
    readonly endpoint: string;
    readonly authProfile: "api_key" | "sign_in" | "managed" | "local" | "aws_sigv4";
    readonly billingSource: "byok" | "sign_in" | "managed" | "local";
  }> {
    const provider = resolveBuiltInProviderSlug(selection.provider);
    if (provider === undefined) throw new Error(`unknown provider "${selection.provider}"`);
    if (provider === "agenc") {
      if (concreteDestination === undefined) throw new Error("Managed AgenC child needs a concrete destination");
      const info = resolveBuiltInProviderInfo(concreteDestination.provider);
      if (info === undefined) throw new Error("Managed AgenC child resolved an unknown destination");
      const routeInfo = resolveBuiltInProviderInfo("agenc")!;
      const routeBaseURL = resolveProviderBaseURLEnvironment("agenc", this.#environment)?.value;
      if (routeBaseURL !== undefined && new URL(routeBaseURL).href.replace(/\/+$/u, "") !==
          new URL(routeInfo.baseURL).href.replace(/\/+$/u, "")) {
        throw new Error("Cross-provider managed AgenC child requires its default endpoint");
      }
      return { endpoint: info.baseURL, authProfile: "managed", billingSource: "managed" };
    }
    const info = resolveBuiltInProviderInfo(provider)!;
    const preparation = await this.#resolvePreparationRequest?.(selection);
    if (preparation === undefined) throw new Error(`${provider} provider switch has no canonical preparation request`);
    const requested = preparation.requested;
    const credentialHome = requested.credentialHome ?? this.#credentialHome;
    const authority = await resolveProviderLocalCredentialAuthority(provider, {
      ...requested, ...(credentialHome !== undefined ? { credentialHome } : {}), model: selection.model,
    }, this.#environment, {
      ...(this.#readSavedApiKey !== undefined ? { readSavedApiKey: this.#readSavedApiKey } : {}),
      ...(this.#authBackend !== undefined ? { authBackend: this.#authBackend } : {}),
      ...(this.#sessionId !== undefined ? { sessionId: this.#sessionId } : {}),
      ...(this.#subscriptionTier !== undefined ? { subscriptionTier: this.#subscriptionTier } : {}),
      ...(preparation.runtime?.managedKeysEnabled !== undefined
        ? { managedKeysEnabled: preparation.runtime.managedKeysEnabled } : {}),
      ...(preparation.runtime?.freeManagedCredential !== undefined
        ? { freeManagedCredential: preparation.runtime.freeManagedCredential } : {}),
    });
    const authProfile = authority.managedCredential ? "managed" as const
      : authority.factoryOptions.extra?.authMode === "oauth" ? "sign_in" as const
      : provider === "amazon-bedrock" ? "aws_sigv4" as const
      : provider === "ollama" || provider === "lmstudio" ||
        (provider === "openai-compatible" && !authority.factoryOptions.apiKey)
        ? "local" as const : "api_key" as const;
    const endpoint = provider === "openai" && authProfile === "sign_in"
      ? CHATGPT_BACKEND_BASE_URL : info.baseURL;
    const normalize = (value: string): string => {
      try { return new URL(value).href.replace(/\/+$/u, ""); }
      catch { return value.trim(); }
    };
    const configured = firstNonEmpty(requested.baseURL,
      resolveProviderBaseURLEnvironment(provider, this.#environment)?.value,
      authority.factoryOptions.baseURL);
    if (configured !== undefined && normalize(configured) !== normalize(endpoint) &&
        !(provider === "openai" && authProfile === "sign_in" && normalize(configured) === normalize(info.baseURL))) {
      throw new Error(`Sub-agents on ${info.name} use its default endpoint, but a custom base URL is set`);
    }
    if (provider === "gemini") {
      const runtimePlan = readGeminiRuntimeOptions(requested.extra)?.endpointPlan;
      if (runtimePlan !== undefined && (runtimePlan.kind !== "developer" ||
          normalize(runtimePlan.nativeBaseURL) !== normalize(info.baseURL))) {
        throw new Error("Cross-provider Gemini child requires its default endpoint");
      }
    }
    if (provider === "amazon-bedrock") {
      const region = typeof requested.extra?.region === "string" ? requested.extra.region : undefined;
      const regional = resolveBuiltInProviderRegionalEndpoint(provider, region);
      if (regional !== undefined && normalize(regional.baseURL) !== normalize(info.baseURL)) {
        throw new Error("Cross-provider Bedrock child requires its default endpoint");
      }
    }
    assertSupportedCrossProviderAuth(provider, authProfile);
    return { endpoint, authProfile, billingSource: authProfile === "sign_in" ? "sign_in"
      : authProfile === "managed" ? "managed" : authProfile === "local" ? "local" : "byok" };
  }

  async prepare(
    selection: ProviderSelection,
    requested?: ProviderFactoryOptions,
    runtime: ProviderPreparationRuntime = {},
  ): Promise<PreparedProviderBinding> {
    if (this.#destinationLock !== undefined &&
        (selection.provider !== this.#destinationLock.provider ||
         selection.model !== this.#destinationLock.model)) {
      throw new Error(`This child is bound to ${this.#destinationLock.provider}/${this.#destinationLock.model}; a new execution plan is required to switch provider or model.`);
    }
    return this.#prepare(selection, requested, runtime, false);
  }

  async resolveManagedChildDestination(model: string): Promise<ProviderSelection> {
    if (this.#authBackend === undefined || this.#sessionId === undefined) {
      throw new Error("AgenC managed child needs an authenticated session");
    }
    const inferred = await this.#authBackend.inferAgencModel({
      provider: "agenc", requestedModel: model, sessionId: this.#sessionId,
      ...(this.#subscriptionTier !== undefined ? { subscriptionTier: this.#subscriptionTier } : {}),
    });
    const provider = resolveBuiltInProviderSlug(inferred.provider);
    if (provider === undefined || provider === "agenc" || !inferred.model?.trim()) {
      throw new Error("AgenC managed child resolved an invalid concrete destination");
    }
    return Object.freeze({ provider, model: inferred.model.trim() });
  }

  /** Prepare a child, pinning durable cross-provider children to the registry endpoint. */
  async prepareChild(
    selection: ProviderSelection,
    requested?: ProviderFactoryOptions,
    runtime: ProviderPreparationRuntime = {},
    crossProviderProvenance = false,
    approvedConcreteDestination?: ProviderSelection,
    approvedAuthority?: ApprovedChildAuthority,
  ): Promise<PreparedProviderBinding> {
    return this.#prepare(selection, requested, runtime, true, crossProviderProvenance,
      approvedConcreteDestination, approvedAuthority);
  }

  async #prepare(
    selection: ProviderSelection,
    requested: ProviderFactoryOptions | undefined,
    runtime: ProviderPreparationRuntime,
    child: boolean,
    crossProviderProvenance = false,
    approvedConcreteDestination?: ProviderSelection,
    approvedAuthority?: ApprovedChildAuthority,
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
    const canonicalEndpointRequired = this.#crossProviderProvenance ||
      (child && (crossProviderProvenance || provider !== this.#binding.provider));
    if (child && canonicalEndpointRequired && provider === "agenc" &&
        (approvedConcreteDestination === undefined ||
         approvedConcreteDestination.provider === "agenc" ||
         !approvedConcreteDestination.model.trim())) {
      throw new Error("Managed AgenC child requires an approved concrete provider and model execution plan");
    }
    let signInModelCapabilities: SignInChildModelCapabilities | undefined;
    if (canonicalEndpointRequired) {
      const info = resolveBuiltInProviderInfo(provider)!;
      const envBaseURL = resolveProviderBaseURLEnvironment(provider, this.#environment);
      const resolvedBaseURL = firstNonEmpty(requestedOptions.baseURL, envBaseURL?.value) ?? info.baseURL;
      const normalize = (value: string): string => {
        try {
          return new URL(value).href.replace(/\/$/u, "");
        } catch {
          return value.trim();
        }
      };
      if (normalize(resolvedBaseURL) !== normalize(info.baseURL) &&
          !(provider === "openai" && normalize(resolvedBaseURL) === normalize(CHATGPT_BACKEND_BASE_URL))) {
        const source = envBaseURL?.value === resolvedBaseURL
          ? envBaseURL.envVar
          : requested === undefined
            ? `providers.${provider}.base_url or another provider endpoint setting`
            : "a provider factory option";
        throw new Error(
          `Sub-agents on ${info.name} use its default endpoint, but a custom base URL is set (${source}). ` +
          `Remove it, or use ${info.name} as the main session's provider.`,
        );
      }
      const rejectOtherEndpoint = (source: string): never => {
        throw new Error(
          `Sub-agents on ${info.name} use its default endpoint, but another endpoint is configured (${source}). ` +
          `Remove it, or use ${info.name} as the main session's provider.`,
        );
      };
      if (provider === "amazon-bedrock" && info.credentials.kind === "aws-sigv4") {
        const regionEnvVar = info.credentials.regionEnvVars.find((name) =>
          firstNonEmpty(this.#environment[name]) !== undefined
        );
        const explicitRegion = requestedOptions.extra?.region;
        const region = firstNonEmpty(
          typeof explicitRegion === "string" ? explicitRegion : undefined,
          regionEnvVar === undefined ? undefined : this.#environment[regionEnvVar],
        );
        const endpoint = resolveBuiltInProviderRegionalEndpoint(provider, region);
        if (endpoint !== undefined && normalize(endpoint.baseURL) !== normalize(info.baseURL)) {
          rejectOtherEndpoint(typeof explicitRegion === "string" && explicitRegion.trim()
            ? "provider region option"
            : regionEnvVar ?? "provider region");
        }
      }
      if (provider === "gemini") {
        const geminiRuntime = readGeminiRuntimeOptions(requestedOptions.extra);
        if (geminiRuntime !== undefined &&
            (geminiRuntime.endpointPlan.kind !== "developer" ||
              normalize(geminiRuntime.endpointPlan.nativeBaseURL) !== normalize(info.baseURL))) {
          rejectOtherEndpoint("extra.gemini.endpointPlan");
        }
        const authMode = firstNonEmpty(this.#environment.GEMINI_AUTH_MODE)?.toLowerCase();
        if (geminiRuntime === undefined &&
            firstNonEmpty(requestedOptions.baseURL, envBaseURL?.value) === undefined &&
            (authMode === "access-token" || authMode === "adc")) {
          rejectOtherEndpoint("GEMINI_AUTH_MODE");
        }
      }
    }
    const credentialHome = requestedOptions.credentialHome ?? this.#credentialHome;
    const credentialOptions = {
      ...requestedOptions,
      ...(credentialHome !== undefined ? { credentialHome } : {}),
      model,
    };
    const credentialRuntime = {
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
    };
    // Resolve once from local state. Reuse this choice for live preparation so
    // credentials cannot change between the consent check and discovery.
    const localAuthority = await resolveProviderLocalCredentialAuthority(
      provider, credentialOptions, this.#environment, credentialRuntime);
    const authProfile = provider === "agenc" || localAuthority.managedCredential
      ? "managed" as const
      : localAuthority.factoryOptions.extra?.authMode === "oauth"
        ? "sign_in" as const
        : provider === "amazon-bedrock"
          ? "aws_sigv4" as const
          : provider === "ollama" || provider === "lmstudio" ||
            (provider === "openai-compatible" && !localAuthority.factoryOptions.apiKey)
            ? "local" as const : "api_key" as const;
    const billingSource = authProfile === "managed" ? "managed" as const
      : authProfile === "sign_in" ? "sign_in" as const
      : authProfile === "local" ? "local" as const : "byok" as const;
    if (approvedAuthority !== undefined) {
      if (!canonicalEndpointRequired) throw new Error("approved child authority requires a pinned endpoint");
      const locallyResolvedEndpoint = provider === "agenc"
        ? resolveBuiltInProviderInfo(approvedConcreteDestination!.provider)?.baseURL
        : localAuthority.factoryOptions.baseURL ?? resolveBuiltInProviderInfo(provider)?.baseURL;
      const normalize = (value: string | undefined): string | undefined => {
        if (value === undefined) return undefined;
        try { return new URL(value).href.replace(/\/+$/u, ""); }
        catch { return value.trim(); }
      };
      if (normalize(locallyResolvedEndpoint) !== normalize(approvedAuthority.endpoint) ||
          authProfile !== approvedAuthority.authProfile ||
          billingSource !== approvedAuthority.billingSource) {
        throw new Error("resume_blocked: child endpoint or authority differs from approved plan; new consent is required");
      }
    }
    requireProviderRuntimeCredential(provider, localAuthority);
    const authority = await resolveProviderRuntimeAuthority(
      provider, credentialOptions, this.#environment, credentialRuntime, localAuthority);
    if (canonicalEndpointRequired) {
      const info = resolveBuiltInProviderInfo(provider)!;
      const effective = authority.factoryOptions;
      const canonicalBaseURL = provider === "openai" && authProfile === "sign_in"
        ? CHATGPT_BACKEND_BASE_URL : info.baseURL;
      const normalize = (value: string): string | undefined => {
        try {
          return new URL(value).href.replace(/\/+$/u, "");
        } catch {
          return undefined;
        }
      };
      if (effective.baseURL !== undefined &&
          normalize(effective.baseURL) !== normalize(canonicalBaseURL)) {
        throw new Error(`Cross-provider ${info.name} child requires its default endpoint after credential resolution`);
      }
      if (provider === "gemini") {
        const runtimePlan = readGeminiRuntimeOptions(effective.extra);
        const plan = runtimePlan?.endpointPlan;
        if (plan === undefined || plan.kind !== "developer" ||
            normalize(plan.nativeBaseURL) !== normalize(info.baseURL)) {
          throw new Error("Cross-provider Gemini child requires its default endpoint after credential resolution");
        }
        if (runtimePlan?.credentialPlan.kind === "adc") {
          throw new Error("Cross-provider Gemini child cannot use ADC token refresh outside the pinned transport");
        }
      }
      if (provider === "amazon-bedrock") {
        const region = typeof effective.extra?.region === "string" ? effective.extra.region : undefined;
        const endpoint = resolveBuiltInProviderRegionalEndpoint(provider, region);
        if (endpoint !== undefined && normalize(endpoint.baseURL) !== normalize(info.baseURL)) {
          throw new Error("Cross-provider Bedrock child requires its default regional endpoint after credential resolution");
        }
      }
      if (provider === "grok" && isGrokComposerModel(model)) {
        throw new Error("Cross-provider Grok Composer children cannot use the CLI transport");
      }
      assertSupportedCrossProviderAuth(provider, authProfile);
    }
    let factoryOptions = canonicalEndpointRequired
      ? { ...authority.factoryOptions, extra: {
          ...(authority.factoryOptions.extra ?? {}), canonicalEndpointRequired: true,
          ...(provider === "grok" || provider === "openai"
            ? { authMode: authProfile === "sign_in" ? "oauth" : "api_key" } : {}),
          fetchImpl: createPinnedProviderFetch(
            [provider === "openai" && authProfile === "sign_in"
              ? CHATGPT_BACKEND_BASE_URL : resolveBuiltInProviderInfo(provider)!.baseURL],
            typeof authority.factoryOptions.extra?.fetchImpl === "function"
              ? authority.factoryOptions.extra.fetchImpl as typeof fetch
              : fetch,
          ),
          ...(provider === "openai" && authProfile === "sign_in" ? {
            oauth: { ...authority.factoryOptions.extra?.oauth as Record<string, unknown>,
              maxRefreshAttempts: 1 },
          } : {}),
          ...(provider === "agenc" ? {
            ...(approvedConcreteDestination !== undefined
              ? { approvedConcreteDestination: Object.freeze({ ...approvedConcreteDestination }) } : {}),
            agencDelegateFetchFactory: (concreteProvider: ProviderName): typeof fetch =>
              createPinnedProviderFetch(
                [resolveBuiltInProviderInfo(concreteProvider)!.baseURL],
                typeof authority.factoryOptions.extra?.fetchImpl === "function"
                  ? authority.factoryOptions.extra.fetchImpl as typeof fetch
                  : fetch,
              ),
          } : {}),
        } }
      : authority.factoryOptions;
    if (canonicalEndpointRequired && (provider === "grok" || provider === "openai") &&
        factoryOptions.extra?.authMode !== (authProfile === "sign_in" ? "oauth" : "api_key")) {
      throw new Error("resume_blocked: child authority differs from approved plan; new consent is required");
    }
    if (canonicalEndpointRequired && authProfile === "sign_in") {
      if (provider === "grok" || provider === "openai") {
        signInModelCapabilities = await assertSignInChildModelEligible({
          provider, model, options: factoryOptions,
          signal: runtime.signal,
          fetchImpl: typeof factoryOptions.extra?.fetchImpl === "function"
            ? factoryOptions.extra.fetchImpl as typeof fetch : fetch,
          environment: this.#environment,
        });
        // Discovery can rotate the OAuth grant on 401. Read the same credential
        // authority again before constructing the provider, so its first wire
        // request uses the bearer (and ChatGPT account) that discovery used.
        const current = await resolveProviderLocalCredentialAuthority(
          provider, credentialOptions, this.#environment, credentialRuntime);
        requireProviderRuntimeCredential(provider, current);
        if (current.factoryOptions.extra?.authMode !== "oauth" ||
            current.factoryOptions.baseURL !== authority.factoryOptions.baseURL) {
          throw new Error("resume_blocked: child authority changed during model discovery; new consent is required");
        }
        factoryOptions = provider === "openai"
          ? { ...factoryOptions, extra: {
              ...factoryOptions.extra,
              oauth: { ...current.factoryOptions.extra?.oauth as Record<string, unknown>,
                maxRefreshAttempts: 1 },
              defaultHeaders: current.factoryOptions.extra?.defaultHeaders,
            } }
          : { ...factoryOptions, apiKey: current.factoryOptions.apiKey };
      }
    }
    const instance = createProvider(provider, factoryOptions);
    let binding: ProviderBinding;
    try {
      binding = bindingFromProvider({
        provider: instance,
        providerName: provider,
        model,
        revision: expectedRevision + 1,
      });
      if (canonicalEndpointRequired && (provider === "grok" || provider === "openai")) {
        const boundMode = binding.factoryOptions.extra?.authMode;
        if (boundMode !== (authProfile === "sign_in" ? "oauth" : "api_key")) {
          throw new Error("resume_blocked: bound child authority differs from approved plan; new consent is required");
        }
      }
    } catch (error) {
      await instance.dispose?.();
      throw error;
    }
    if (canonicalEndpointRequired) pinnedChildProviders.add(instance);
    return Object.freeze({
      expectedRevision,
      authProfile,
      ...(signInModelCapabilities !== undefined ? { signInModelCapabilities } : {}),
      billingSource,
      managedDefaultOutputCap:
        authority.managedCredential &&
        runtimeOptions.applyManagedDefaultOutputCap === true,
      binding,
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
