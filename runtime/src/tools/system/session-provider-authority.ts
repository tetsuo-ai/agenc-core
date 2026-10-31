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
 *   session, a canonical media key) resolves it from that session's own
 *   environment and credential home, credential and endpoint as one pair.
 *
 * One session's endpoint is never paired with another session's credential,
 * and nothing falls back to the parent's credential.
 *
 * @module
 */

import type { HomeContext } from "../../config/home.js";
import { readProviderFactoryOptions } from "../../llm/provider.js";
import { isTrustedXaiOauthInferenceBaseUrl } from "../../services/xai/oauth.js";
import {
  isXaiOauthBearer,
  readXaiOauthAccessToken,
} from "../../utils/xaiOauthCredentials.js";

/** The parts of a session a tool reads its authority from. */
export interface ToolCallSession {
  readonly services?: {
    readonly provider?: unknown;
    readonly providerEnvironment?: Readonly<Record<string, string | undefined>>;
  };
}

/**
 * The environment a session's separate backends resolve from: the provider
 * environment the session captured (a sub-agent's is the one its parent
 * gave it), else the tool's own captured environment.
 */
export function toolCallEnvironment(
  session: ToolCallSession | null | undefined,
  fallback: NodeJS.ProcessEnv | undefined,
): NodeJS.ProcessEnv {
  return (session?.services?.providerEnvironment as NodeJS.ProcessEnv | undefined) ??
    fallback ??
    process.env;
}

/** The credential home the session's own provider uses, when it names one. */
export function sessionCredentialHome(provider: unknown): HomeContext | undefined {
  if (provider === undefined || provider === null) return undefined;
  return readProviderFactoryOptions(provider as never).credentialHome;
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
