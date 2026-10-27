import { readLocalByokCredential } from "../auth/native-credentials.js";

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
  requireCommandConfigStore,
} from "./config-context.js";

import type { SlashCommandContext } from "./types.js";

export type ProviderCommandRoute =
  | "direct"
  | "local"
  | "deferred"
  | "unavailable";

export type ProviderCommandEffect = "unchanged" | "switch" | "blocked";
export type ProviderCommandAuthState =
  | "ready"
  | "optional"
  | "missing"
  | "error";

export type ProviderCommandRejection =
  | { readonly code: "configuration"; readonly message: string }
  | { readonly code: "credential-required"; readonly missingLabel: string };

export interface ProviderCommandAccess {
  readonly selection: { readonly provider: ProviderSlug; readonly model: string };
  readonly effect: ProviderCommandEffect;
  readonly route: ProviderCommandRoute;
  readonly directCredential?: ProviderCredentialState;
  readonly configurationError?: string;
  readonly endpoint?: { readonly baseURL: string; readonly local: boolean };
  readonly auth: {
    readonly state: ProviderCommandAuthState;
    readonly label: string;
    readonly source: string;
  };
  readonly rejection?: ProviderCommandRejection;
}

export interface ProviderCommandAccessOverlay {
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

export function createProviderCommandAccessOverlay(
  ctx: SlashCommandContext,
): ProviderCommandAccessOverlay {
  const configStore = requireCommandConfigStore(ctx);
  const config = readCommandConfig(ctx) ?? configStore.current();
  const environment = providerEnvironmentFromCommandContext(ctx);
  const current = readBuiltInSessionSelection(ctx.session, {
    includePending: true,
    fallbackConfig: config,
  });
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
    let route: ProviderCommandRoute = "unavailable";
    let rejection: ProviderCommandRejection | undefined;
    if (selection.provider === "agenc") {
      rejection = { code: "configuration", message: "AgenC accounts no longer provide models. Choose a provider with your own credentials or a local server." };
    } else if (directCredential.status !== "missing" || selection.provider === current.provider) {
      route = endpoint.local ? "local" : "direct";
    } else if (directCredential.reason === "absent") {
      route = "deferred";
    } else {
      rejection = { code: "credential-required", missingLabel: directCredential.missingLabel };
    }
    const auth = directAuthProjection(directCredential);
    const access: ProviderCommandAccess = Object.freeze({
      selection: Object.freeze({ ...selection }),
      effect: exactCurrent ? "unchanged" : rejection === undefined ? "switch" : "blocked",
      route,
      directCredential,
      endpoint,
      auth,
      ...(exactCurrent || rejection === undefined ? {} : { rejection }),
    });
    cache.set(cacheKey, access);
    return access;
  };

  return Object.freeze({ inspect });
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
  const missingLabel = rejection.missingLabel ??
    (access.directCredential?.status === "missing"
      ? access.directCredential.missingLabel
      : "provider credentials");
  return `${prefix}: set ${missingLabel}.`;
}
