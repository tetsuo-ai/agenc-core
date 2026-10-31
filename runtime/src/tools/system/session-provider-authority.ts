/**
 * The provider authority one tool call uses, all of it from the session that
 * made the call: a sub-agent runs its parent's tool objects
 * (tools/runtimes/context.ts readInvokingSession), so nothing here may come
 * from the session the tool registry was built for.
 *
 * - A tool that calls the session's own provider (its media route, Grok's
 *   native search, XSearch in a Grok session) uses the credential, endpoint
 *   and auth mode that session's model calls use, read from its provider's
 *   factory options.
 * - A tool that calls a separate backend (xAI or Meta from another provider's
 *   session, a canonical media key, a configured search endpoint) resolves it
 *   from that session's own environment and credential home, credential and
 *   endpoint as one pair.
 * - Every HTTP request the tool makes itself uses the same session's
 *   transport: proxy, client certificate and key, and CA trust from its
 *   environment.
 *
 * A session carries its environment and credential home from creation
 * (session/session-authority.ts). One session's endpoint is never paired
 * with another session's credential, and a session that lacks its own
 * authority fails closed instead of falling back to the parent's.
 *
 * @module
 */

import type { HomeContext } from "../../config/home.js";
import {
  type ConfiguredProviderAuth,
  withConfiguredProviderAuth,
} from "../../llm/provider-auth-selection.js";
import { readProviderFactoryOptions } from "../../llm/provider.js";
import { isTrustedXaiOauthInferenceBaseUrl } from "../../services/xai/oauth.js";
import { getProxyFetchOptions } from "../../utils/proxy.js";
import {
  isXaiOauthBearer,
  readXaiOauthAccessToken,
} from "../../utils/xaiOauthCredentials.js";

type EnvironmentRecord = Readonly<Record<string, string | undefined>>;

/**
 * A session's live provider state: its own provider service, the one its
 * model calls use (session/provider-service.ts). Read at call time, so a key
 * the user added or rotated in the session applies to its tools at once.
 */
export interface LiveProviderState {
  environment(): EnvironmentRecord;
  credentialHome?(): HomeContext | undefined;
}

/** The parts of a session a tool reads its authority from. */
export interface ToolCallSession {
  readonly services?: {
    readonly provider?: unknown;
    readonly providerService?: LiveProviderState;
    readonly providerEnvironment?: EnvironmentRecord;
    readonly configStore?: { current(): unknown };
  };
}

/** Everything a tool call resolves credentials and transport from. */
export interface ToolCallAuthority {
  /**
   * Credential selection: the session's environment with its config's
   * `[providers.<openai|grok>] auth` choices filled in where the environment
   * leaves them unset, as its provider resolution does.
   */
  readonly environment: NodeJS.ProcessEnv;
  /** The session's own environment: proxy, client certificate and key, CA trust. */
  readonly transportEnvironment: EnvironmentRecord;
  /** Where the session's stored sign-ins are read; absent when it has none. */
  readonly credentialHome?: HomeContext;
}

export type ToolCallAuthorityResolution = ToolCallAuthority | { readonly error: string };

function configuredProviderAuth(
  configStore: { current(): unknown } | undefined,
): ConfiguredProviderAuth | undefined {
  try {
    return configStore?.current() as ConfiguredProviderAuth | undefined;
  } catch {
    return undefined;
  }
}

/** A tool call's session and whether it is the one its registry was built for. */
export interface ToolCallSessionRef<S extends ToolCallSession = ToolCallSession> {
  readonly session: S | null;
  readonly registrySession: boolean;
}

/**
 * The session a tool call runs for: the session the runtime attached to the
 * call (`invoking`, a sub-agent's own when it calls its parent's tool), or,
 * for a call without one (direct use, registration), the session the
 * registry was built for. `registrySession` is true only when the call's
 * session is that same session object.
 */
export function toolCallSession<S extends ToolCallSession>(
  invoking: S | null | undefined,
  getRegistrySession: () => S | null,
): ToolCallSessionRef<S> {
  if (invoking === null || invoking === undefined) {
    return { session: getRegistrySession(), registrySession: true };
  }
  return { session: invoking, registrySession: invoking === getRegistrySession() };
}

/**
 * The authority for one call, read from the calling session's own live
 * provider state at call time: its environment (keys added or rotated in the
 * session included) and its credential home. Every runtime Session owns a
 * provider service, the registry's own session included, so no frozen copy
 * and no other session's state is consulted. The tool's captured environment
 * and home serve only a call with no session at all, or a session object
 * without a provider service that stands in for the registry's own (test
 * and embedding doubles, never a runtime Session). Any other session without
 * its own state, or without a credential home when `needsCredentialHome`,
 * fails closed with a clear error.
 */
export function resolveToolCallAuthority(
  toolName: string,
  call: ToolCallSessionRef,
  captured: { readonly env?: EnvironmentRecord; readonly home?: HomeContext },
  needsCredentialHome = false,
): ToolCallAuthorityResolution {
  const session = call.session;
  if (session === null) {
    const environment = captured.env ?? process.env;
    return {
      environment: environment as NodeJS.ProcessEnv,
      transportEnvironment: environment,
      ...(captured.home !== undefined ? { credentialHome: captured.home } : {}),
    };
  }
  const services = session.services;
  const live = services?.providerService;
  const standIn = live === undefined && call.registrySession;
  const transportEnvironment = live !== undefined
    ? live.environment()
    : standIn ? captured.env ?? services?.providerEnvironment : undefined;
  if (transportEnvironment === undefined) {
    return {
      error:
        `${toolName} cannot run: this session has no provider state of its own, ` +
        "and a tool never borrows another session's credentials or connection settings.",
    };
  }
  const credentialHome = live !== undefined
    ? live.credentialHome?.()
    : standIn ? captured.home : undefined;
  if (needsCredentialHome && credentialHome === undefined) {
    return {
      error:
        `${toolName} cannot run: this session has no credential home of its own, ` +
        "and a tool never reads another session's stored sign-ins.",
    };
  }
  return {
    environment: withConfiguredProviderAuth(
      transportEnvironment,
      configuredProviderAuth(services?.configStore),
    ) as NodeJS.ProcessEnv,
    transportEnvironment,
    ...(credentialHome !== undefined ? { credentialHome } : {}),
  };
}

/** Fetch options carrying the session's own proxy, client certificate and key, and CA trust. */
export function toolCallFetchOptions(
  authority: ToolCallAuthority,
): ReturnType<typeof getProxyFetchOptions> {
  return getProxyFetchOptions({ environment: authority.transportEnvironment });
}

/** `fetchImpl` sending every request through the session's own transport. */
export function withToolCallTransport(
  fetchImpl: typeof fetch,
  authority: ToolCallAuthority,
): typeof fetch {
  return ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    fetchImpl(input, {
      ...(init ?? {}),
      ...toolCallFetchOptions(authority),
    } as RequestInit)) as typeof fetch;
}

function trimmed(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function withoutTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, "");
}

function validUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/** A managed AgenC route lends no credential to tools. */
export function isManagedProviderRoute(provider: unknown): boolean {
  if (provider === undefined || provider === null) return false;
  const extra = readProviderFactoryOptions(provider as never).extra;
  return extra?.managedGateway === true || extra?.managedCredential === true;
}

/**
 * The API key and endpoint a session's own model calls use, when its
 * provider credential is an API key: the factory's resolved key with the
 * factory's base URL, or the provider's default URL when the factory names
 * none. Undefined for an OAuth grant (a ChatGPT sign-in does not authorize
 * media routes), a managed route, or a provider without a key.
 */
export function sessionApiKeyRoute(
  provider: unknown,
  defaultBaseURL: string,
): { readonly bearer: string; readonly baseURL: string } | undefined {
  if (provider === undefined || provider === null || isManagedProviderRoute(provider)) {
    return undefined;
  }
  const factory = readProviderFactoryOptions(provider as never);
  const extra = factory.extra;
  if (
    extra?.authMode === "oauth" ||
    extra?.chatgptBackend === true ||
    extra?.oauth !== undefined
  ) {
    return undefined;
  }
  const bearer = trimmed(factory.apiKey);
  if (bearer === undefined) return undefined;
  const baseURL = withoutTrailingSlash(trimmed(factory.baseURL) ?? defaultBaseURL);
  return validUrl(baseURL) ? { bearer, baseURL } : undefined;
}

export type SessionXaiRoute =
  | {
      readonly bearer: string;
      readonly baseURL: string;
      /** Which credential this is, so a rebuilt provider cannot reinterpret it. */
      readonly authMode: "oauth" | "api_key";
      readonly credentialHome?: HomeContext;
    }
  | { readonly error: string };

/**
 * The xAI bearer and endpoint a Grok session's own model calls use, as the
 * grok provider factory resolves them (llm/provider.ts, case "grok"): the
 * sign-in stored in the session's own credential home, unless its captured
 * selection is API-key billing, else its factory key. A sign-in bearer is
 * only ever paired with the first-party xAI endpoint. Undefined when the
 * session has no usable xAI credential.
 */
export function sessionXaiRoute(
  provider: unknown,
  defaultBaseURL: string,
): SessionXaiRoute | undefined {
  if (provider === undefined || provider === null) return undefined;
  const factory = readProviderFactoryOptions(provider as never);
  const baseURL = withoutTrailingSlash(trimmed(factory.baseURL) ?? defaultBaseURL);
  if (!validUrl(baseURL)) return undefined;
  const home = factory.credentialHome;
  const authMode = factory.extra?.authMode;
  const signIn = authMode !== "api_key" && home !== undefined
    ? readXaiOauthAccessToken(home)
    : undefined;
  if (signIn !== undefined) {
    if (!isTrustedXaiOauthInferenceBaseUrl(baseURL)) {
      return {
        error:
          "xAI sign-in credentials are bound to the first-party xAI API endpoint. " +
          "Select API-key mode to use a custom Grok base URL, or unset the base URL override.",
      };
    }
    return { bearer: signIn, baseURL, authMode: "oauth", credentialHome: home };
  }
  if (authMode === "oauth") return undefined;
  const key = trimmed(factory.apiKey);
  if (key === undefined) return undefined;
  // A recorded sign-in snapshot is never sent as an API key (the factory
  // refuses it the same way).
  if (home !== undefined && isXaiOauthBearer(home, key)) return undefined;
  return {
    bearer: key,
    baseURL,
    authMode: "api_key",
    ...(home !== undefined ? { credentialHome: home } : {}),
  };
}
