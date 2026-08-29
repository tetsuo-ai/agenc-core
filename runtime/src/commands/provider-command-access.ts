import {
  hasEntitledRemoteAuthSessionSync,
  hasRemoteAuthSessionSync,
  remoteAuthSessionSubscriptionTierSync,
} from "../auth/session-state.js";
import { readLocalByokCredential } from "../auth/native-credentials.js";
import type { AuthSubscriptionTier } from "../auth/backend.js";
import type { ProviderSlug } from "../config/provider-model-authority.js";
import type { ProviderFactoryOptions } from "../llm/provider.js";
import {
  resolveProviderCredentialAuthority,
  type ProviderCredentialState,
} from "../llm/provider-options.js";
import { resolveProviderRuntimeRequest } from "../llm/provider-request.js";
import {
  resolveBuiltInProviderInfo,
  resolveBuiltInProviderRegionalEndpoint,
} from "../llm/registry/provider-info.js";
import { geminiEndpointFor } from "../llm/providers/gemini/endpoint-plan.js";
import { readGeminiRuntimeOptions } from "../llm/providers/gemini/runtime-options.js";
import { readBuiltInSessionSelection } from "../session/provider-model-selection.js";
import {
  providerEnvironmentFromCommandContext,
  readCommandConfig,
  remoteAuthContextFromCommandContext,
  requireCommandConfigStore,
} from "./config-context.js";
import {
  isFreeSubscriptionManagedModel,
  isSubscriptionManagedModel,
  providerHasLiveSubscriptionRoute,
  subscriptionManagedDefaultModelForTier,
  subscriptionManagedModelsForTier,
  visibleSubscriptionManagedModelsForTier,
} from "./subscription-managed-models.js";
import type { SlashCommandContext } from "./types.js";

export type ProviderCommandRoute =
  | "direct"
  | "local"
  | "deferred"
  | "subscription"
  | "provider-managed"
  | "unavailable";

export type ProviderCommandEffect = "unchanged" | "switch" | "blocked";
export type ProviderCommandAuthState =
  | "ready"
  | "optional"
  | "managed"
  | "missing"
  | "error";

export type ProviderCommandRejection =
  | { readonly code: "configuration"; readonly message: string }
  | { readonly code: "credential-required"; readonly missingLabel: string }
  | { readonly code: "login-required"; readonly missingLabel?: string }
  | { readonly code: "upgrade-required"; readonly missingLabel?: string }
  | { readonly code: "model-not-managed"; readonly suggestedModel?: string }
  | { readonly code: "provider-managed-auth-required" };

export interface ProviderCommandAccess {
  readonly selection: { readonly provider: ProviderSlug; readonly model: string };
  readonly effect: ProviderCommandEffect;
  readonly route: ProviderCommandRoute;
  readonly directCredential?: ProviderCredentialState;
  readonly configurationError?: string;
  readonly endpoint?: { readonly baseURL: string; readonly local: boolean };
  readonly managed: {
    readonly enabled: boolean;
    readonly signedIn: boolean;
    readonly tier?: AuthSubscriptionTier;
    readonly models: readonly string[];
    readonly visibleModels: readonly string[];
    readonly defaultModel?: string;
  };
  readonly auth: {
    readonly state: ProviderCommandAuthState;
    readonly label: string;
    readonly source: string;
  };
  readonly rejection?: ProviderCommandRejection;
}

export interface ProviderCommandAccessOverlay {
  readonly managedKeysEnabled: boolean;
  inspect(selection: {
    readonly provider: ProviderSlug;
    readonly model: string;
  }): ProviderCommandAccess;
}

function isLocalEndpoint(baseURL: string): boolean {
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

function directAuthProjection(credential: ProviderCredentialState): {
  readonly state: ProviderCommandAuthState;
  readonly label: string;
  readonly source: string;
} {
  if (credential.status === "ready") {
    const environmentSource = credential.provenance?.kind === "environment"
      ? `env ${credential.provenance.fields.map(field => field.envVar).join(" + ")}`
      : `env ${credential.label}`;
    const source = credential.source === "environment"
      ? environmentSource
      : credential.source === "saved-byok"
        ? "native secure storage"
        : credential.source === "native-sign-in"
          ? "native sign-in"
          : credential.source === "application-default"
            ? credential.label
            : "current session";
    return { state: "ready", label: credential.label, source };
  }
  if (
    credential.status === "optional" ||
    credential.status === "not-required"
  ) {
    return {
      state: "optional",
      label: credential.label,
      source: "no provider key required",
    };
  }
  if (credential.status === "missing") {
    return {
      state: "missing",
      label: credential.label,
      source: `set ${credential.missingLabel}`,
    };
  }
  throw new Error(`Unsupported provider credential state ${credential.status}`);
}

function endpointFor(
  provider: ProviderSlug,
  factoryOptions: ProviderFactoryOptions,
  fallbackBaseURL: string,
): { readonly baseURL: string; readonly local: boolean } {
  const geminiRuntime = readGeminiRuntimeOptions(factoryOptions.extra);
  const region = typeof factoryOptions.extra?.region === "string"
    ? factoryOptions.extra.region.trim()
    : undefined;
  const regional = resolveBuiltInProviderRegionalEndpoint(provider, region);
  const baseURL = geminiRuntime === undefined
    ? factoryOptions.baseURL ?? regional?.baseURL ?? fallbackBaseURL
    : geminiEndpointFor(geminiRuntime.endpointPlan);
  return Object.freeze({ baseURL, local: isLocalEndpoint(baseURL) });
}

function managedRouteAuthorized(
  provider: ProviderSlug,
  model: string,
  tier: AuthSubscriptionTier | undefined,
  entitled: boolean,
): boolean {
  if (tier === "free") {
    return isFreeSubscriptionManagedModel(provider, model);
  }
  return entitled && isSubscriptionManagedModel(provider, model);
}

export function createProviderCommandAccessOverlay(
  ctx: SlashCommandContext,
): ProviderCommandAccessOverlay {
  const configStore = requireCommandConfigStore(ctx);
  const config = readCommandConfig(ctx) ?? configStore.current();
  const environment = providerEnvironmentFromCommandContext(ctx);
  const authContext = remoteAuthContextFromCommandContext(ctx);
  const current = readBuiltInSessionSelection(ctx.session, {
    includePending: true,
    fallbackConfig: config,
  });
  const managedKeysEnabled = config?.auth?.managedKeys?.enabled === true;
  const signedIn = hasRemoteAuthSessionSync(authContext);
  const entitled = hasEntitledRemoteAuthSessionSync(authContext);
  const tier = remoteAuthSessionSubscriptionTierSync(authContext);
  const cache = new Map<string, ProviderCommandAccess>();

  const inspect = (selection: {
    readonly provider: ProviderSlug;
    readonly model: string;
  }): ProviderCommandAccess => {
    const cacheKey = `${selection.provider}\0${selection.model}`;
    const cached = cache.get(cacheKey);
    if (cached !== undefined) return cached;
    const info = resolveBuiltInProviderInfo(selection.provider);
    if (info === undefined) {
      throw new Error(`Unknown provider ${JSON.stringify(selection.provider)}`);
    }
    const exactCurrent =
      selection.provider === current.provider && selection.model === current.model;
    const requested = resolveProviderRuntimeRequest({
      provider: selection.provider,
      model: selection.model,
      config,
      environment,
      credentialHome: configStore.homeContext,
    }).requested;
    const managedModels = subscriptionManagedModelsForTier(
      selection.provider,
      tier,
    );
    const visibleManagedModels = visibleSubscriptionManagedModelsForTier(
      selection.provider,
      tier,
    );
    const managed = Object.freeze({
      enabled: managedKeysEnabled,
      signedIn,
      ...(tier === undefined ? {} : { tier }),
      models: managedModels,
      visibleModels: visibleManagedModels,
      ...(subscriptionManagedDefaultModelForTier(selection.provider, tier) ===
      undefined
        ? {}
        : {
            defaultModel: subscriptionManagedDefaultModelForTier(
              selection.provider,
              tier,
            ),
          }),
    });

    let authority;
    try {
      authority = resolveProviderCredentialAuthority(
        selection.provider,
        requested,
        environment,
        {
          savedApiKey: readLocalByokCredential(
            configStore.homeContext,
            selection.provider,
          )?.apiKey,
        },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const access: ProviderCommandAccess = Object.freeze({
        selection: Object.freeze({ ...selection }),
        effect: exactCurrent ? "unchanged" : "blocked",
        route: "unavailable",
        configurationError: message,
        managed,
        auth: Object.freeze({
          state: "error",
          label: "configuration error",
          source: message,
        }),
        ...(exactCurrent
          ? {}
          : { rejection: { code: "configuration", message } as const }),
      });
      cache.set(cacheKey, access);
      return access;
    }

    const directCredential = authority.credential;
    const endpoint = endpointFor(
      selection.provider,
      authority.factoryOptions,
      info.baseURL,
    );
    const directAvailable =
      info.requiresManagedAuth !== true &&
      (directCredential.status !== "missing" ||
        (selection.provider === current.provider &&
          (!managedKeysEnabled ||
            !providerHasLiveSubscriptionRoute(selection.provider))));
    let route: ProviderCommandRoute = "unavailable";
    let rejection: ProviderCommandRejection | undefined;
    if (directAvailable) {
      route = endpoint.local ? "local" : "direct";
    } else if (info.requiresManagedAuth) {
      if (entitled) {
        route = "provider-managed";
      } else {
        rejection = signedIn
          ? { code: "upgrade-required" }
          : { code: "provider-managed-auth-required" };
      }
    } else if (
      !managedKeysEnabled &&
      directCredential.status === "missing" &&
      directCredential.reason === "absent"
    ) {
      route = "deferred";
    } else if (
      managedKeysEnabled &&
      signedIn &&
      providerHasLiveSubscriptionRoute(selection.provider) &&
      managedRouteAuthorized(
        selection.provider,
        selection.model,
        tier,
        entitled,
      )
    ) {
      route = "subscription";
    } else if (
      managedKeysEnabled &&
      signedIn &&
      providerHasLiveSubscriptionRoute(selection.provider)
    ) {
      rejection = isSubscriptionManagedModel(
        selection.provider,
        selection.model,
      )
        ? {
            code: "upgrade-required",
            missingLabel: directCredential.status === "missing"
              ? directCredential.missingLabel
              : undefined,
          }
        : {
            code: "model-not-managed",
            suggestedModel: managed.defaultModel,
          };
    } else if (
      managedKeysEnabled &&
      providerHasLiveSubscriptionRoute(selection.provider)
    ) {
      rejection = {
        code: "login-required",
        missingLabel: directCredential.status === "missing"
          ? directCredential.missingLabel
          : undefined,
      };
    } else {
      rejection = {
        code: "credential-required",
        missingLabel: directCredential.status === "missing"
          ? directCredential.missingLabel
          : "provider credentials",
      };
    }
    const auth = route === "subscription" || route === "provider-managed"
      ? Object.freeze({
          state: "managed" as const,
          label: route === "subscription" ? "subscription" : "AgenC sign-in",
          source: "authenticated AgenC account",
        })
      : directAuthProjection(directCredential);
    const access: ProviderCommandAccess = Object.freeze({
      selection: Object.freeze({ ...selection }),
      effect: exactCurrent ? "unchanged" : rejection === undefined ? "switch" : "blocked",
      route,
      directCredential,
      endpoint,
      managed,
      auth,
      ...(exactCurrent || rejection === undefined ? {} : { rejection }),
    });
    cache.set(cacheKey, access);
    return access;
  };

  return Object.freeze({ managedKeysEnabled, inspect });
}

function rejectionPrefix(
  access: ProviderCommandAccess,
  intent: "model" | "provider",
): string {
  return intent === "model"
    ? "Model switch blocked"
    : `Provider switch to "${access.selection.provider}" blocked`;
}

export function formatProviderCommandRejection(
  access: ProviderCommandAccess,
  intent: "model" | "provider",
): string | undefined {
  if (access.effect !== "blocked" || access.rejection === undefined) {
    return undefined;
  }
  const prefix = rejectionPrefix(access, intent);
  const rejection = access.rejection;
  if (rejection.code === "configuration") {
    return `${prefix}: ${rejection.message}`;
  }
  if (rejection.code === "provider-managed-auth-required") {
    return `${prefix}: sign in with AgenC using /login.`;
  }
  if (rejection.code === "model-not-managed") {
    const hint = rejection.suggestedModel === undefined
      ? "Open /model to pick a hosted route."
      : `Try /model ${access.selection.provider}:${rejection.suggestedModel}, or open /model to pick a hosted route.`;
    return (
      `Model "${access.selection.model}" is not enabled for ` +
      `subscription-managed ${access.selection.provider}. ${hint}`
    );
  }
  const missingLabel = rejection.missingLabel ??
    (access.directCredential?.status === "missing"
      ? access.directCredential.missingLabel
      : "provider credentials");
  if (rejection.code === "upgrade-required") {
    const info = resolveBuiltInProviderInfo(access.selection.provider);
    if (info?.requiresManagedAuth === true) {
      return `${prefix}: upgrade the signed-in AgenC account.`;
    }
    return (
      `${prefix}: upgrade the signed-in AgenC account for this hosted model, ` +
      `or set ${missingLabel} for BYOK.`
    );
  }
  if (rejection.code === "login-required") {
    return (
      `${prefix}: sign in with AgenC using /login for free hosted models, ` +
      `upgrade for paid hosted models, or set ${missingLabel} for BYOK.`
    );
  }
  const info = resolveBuiltInProviderInfo(access.selection.provider);
  if (
    access.managed.enabled !== true ||
    info?.onboarding.access === "environment"
  ) {
    return `${prefix}: set ${missingLabel}.`;
  }
  return (
    `${prefix}: hosted subscription access is available through OpenRouter. ` +
    `Run /provider openrouter, or set ${missingLabel} for BYOK.`
  );
}
