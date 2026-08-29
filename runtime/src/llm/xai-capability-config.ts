/**
 * Provider-scoped Grok capability profile (`[providers.grok]` in config.toml).
 *
 * Pure mapping: AgenCConfig.providers.grok → createProvider() `extra` fields that
 * GrokProvider already understands. Applied only when the session provider is
 * `grok` and the inference host is direct xAI (not OpenRouter / third-party).
 *
 * Defaults (deliberate cost control):
 * - web_search: true (LIVE WebSearch native one-shot path)
 * - x_search / code_execution / image flags / collections / remote_mcp: false
 *
 * @module
 */

import type { GrokCapabilityConfig } from "../config/schema.js";
import { readXaiOauthAccessToken } from "../utils/xaiOauthCredentials.js";
import type { HomeContext } from "../config/home.js";
import { normalizeProviderIdentity } from "../provider-identity.js";
import type { ProviderRuntimeExtra } from "./provider.js";
import { isDynamicSessionCredentialEnvironmentKey } from "../session/environment.js";
import { resolveProviderApiKeyEnvironment } from "./registry/provider-ingress.js";

const DIRECT_XAI_HOST_SUFFIXES = [".x.ai", ".grok.com"] as const;

/**
 * True when baseURL points at first-party xAI / Grok inference.
 * Empty/undefined baseURL uses the built-in default (api.x.ai) → true.
 * OpenRouter and custom gateways → false (no server-tool payloads).
 */
export function isDirectXaiInferenceHost(
  baseURL: string | undefined | null,
): boolean {
  if (baseURL === undefined || baseURL === null) return true;
  const trimmed = String(baseURL).trim();
  if (trimmed.length === 0) return true;
  try {
    const host = new URL(trimmed).hostname.toLowerCase();
    if (host === "api.x.ai" || host === "x.ai" || host === "grok.com") {
      return true;
    }
    return DIRECT_XAI_HOST_SUFFIXES.some(
      (suffix) => host === suffix.slice(1) || host.endsWith(suffix),
    );
  } catch {
    return false;
  }
}

/**
 * Full Grok capability profile. Subscription + BYOK users get the whole
 * surface enabled by default; operators can still turn individual flags off
 * under `[providers.grok]`.
 */
export function defaultGrokCapabilityConfig(): Readonly<GrokCapabilityConfig> {
  return Object.freeze({
    web_search: true,
    x_search: true,
    code_execution: true,
    enable_image_search: true,
    enable_image_understanding: true,
    enable_video_understanding: true,
  });
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/**
 * Merge operator `[providers.grok]` over full-surface defaults.
 */
export function resolveGrokCapabilityConfig(
  raw: GrokCapabilityConfig | undefined | null,
): Readonly<GrokCapabilityConfig> {
  const defaults = defaultGrokCapabilityConfig();
  if (!raw || typeof raw !== "object") return defaults;
  return Object.freeze({
    web_search: asBoolean(raw.web_search, defaults.web_search === true),
    x_search: asBoolean(raw.x_search, defaults.x_search === true),
    code_execution: asBoolean(
      raw.code_execution,
      defaults.code_execution === true,
    ),
    enable_image_search: asBoolean(
      raw.enable_image_search,
      defaults.enable_image_search === true,
    ),
    enable_image_understanding: asBoolean(
      raw.enable_image_understanding,
      defaults.enable_image_understanding === true,
    ),
    enable_video_understanding: asBoolean(
      raw.enable_video_understanding,
      defaults.enable_video_understanding === true,
    ),
    ...(raw.collections !== undefined
      ? { collections: raw.collections }
      : {}),
    ...(raw.remote_mcp !== undefined ? { remote_mcp: raw.remote_mcp } : {}),
  });
}

export interface ResolveXaiCapabilityExtraInput {
  readonly provider: string | undefined | null;
  readonly baseURL?: string | null;
  readonly grokCapabilities?: GrokCapabilityConfig | null;
  /** Immutable environment captured at the session bootstrap boundary. */
  readonly env: NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>>;
}

function resolveRemoteMcpAuthorization(
  authorizationEnv: string | undefined,
  env: ResolveXaiCapabilityExtraInput["env"],
  serverLabel: string,
): string | undefined {
  if (authorizationEnv === undefined) return undefined;
  if (!isDynamicSessionCredentialEnvironmentKey(authorizationEnv)) {
    throw new Error(
      `Remote MCP server ${JSON.stringify(serverLabel)} requires an AGENC_CREDENTIAL_* authorization_env name`,
    );
  }
  if (env === undefined) {
    throw new Error(
      `Remote MCP server ${JSON.stringify(serverLabel)} requires the captured environment to resolve authorization_env=${JSON.stringify(authorizationEnv)}`,
    );
  }
  const authorization = env[authorizationEnv];
  if (typeof authorization !== "string" || authorization.trim().length === 0) {
    throw new Error(
      `Remote MCP server ${JSON.stringify(serverLabel)} requires non-empty environment variable ${authorizationEnv}`,
    );
  }
  return authorization;
}

/**
 * Build createProvider() `extra` fields for Grok native capabilities.
 * Returns `{}` when provider is not grok or host is not direct xAI.
 */
export function resolveXaiCapabilityExtra(
  input: ResolveXaiCapabilityExtraInput,
): ProviderRuntimeExtra {
  const provider = normalizeProviderIdentity(
    input.provider ?? undefined,
    "xAI capability provider",
  );
  if (provider !== "grok") {
    return {};
  }
  if (!isDirectXaiInferenceHost(input.baseURL)) {
    return {};
  }

  const cfg = resolveGrokCapabilityConfig(input.grokCapabilities);

  // Search enable flags are consumed by LIVE WebSearch/XSearch (Pattern A),
  // not continuous main-loop injection — see resolveXaiLive* helpers.
  const codeExecution = cfg.code_execution === true;

  const collections = cfg.collections;
  const collectionsSearch =
    collections &&
    collections.enabled === true &&
    Array.isArray(collections.vector_store_ids) &&
    collections.vector_store_ids.length > 0
      ? {
          enabled: true as const,
          vectorStoreIds: [...collections.vector_store_ids],
          ...(typeof collections.max_num_results === "number"
            ? { maxNumResults: collections.max_num_results }
            : {}),
        }
      : undefined;

  const remoteMcp = cfg.remote_mcp;
  const remoteMcpExtra =
    remoteMcp &&
    remoteMcp.enabled === true &&
    Array.isArray(remoteMcp.servers) &&
    remoteMcp.servers.length > 0
      ? {
          enabled: true as const,
          servers: remoteMcp.servers.map((server) => {
            const authorization = resolveRemoteMcpAuthorization(
              server.authorization_env,
              input.env,
              server.server_label,
            );
            return {
              serverUrl: server.server_url,
              serverLabel: server.server_label,
              ...(server.server_description !== undefined
                ? { serverDescription: server.server_description }
                : {}),
              ...(server.allowed_tools !== undefined
                ? { allowedTools: [...server.allowed_tools] }
                : {}),
              ...(authorization !== undefined ? { authorization } : {}),
            };
          }),
        }
      : undefined;

  // Pattern A (G19 dual-bill guard): do NOT continuous-inject web_search /
  // x_search on the main-loop provider — LIVE WebSearch/XSearch one-shots own
  // those. Continuous injection is only for code_execution / collections /
  // remote_mcp. LIVE tools read image/search options via
  // resolveXaiLiveWebSearchOptions / resolveXaiLiveXSearchOptions.
  return {
    ...(codeExecution ? { codeExecution: true as const } : {}),
    ...(collectionsSearch !== undefined
      ? { collectionsSearch }
      : {}),
    ...(remoteMcpExtra !== undefined ? { remoteMcp: remoteMcpExtra } : {}),
  };
}

/**
 * Options for LIVE WebSearch one-shot native `web_search` (Pattern A).
 * Reads `[providers.grok]` image flags without enabling continuous main-loop search.
 */
export function resolveXaiLiveWebSearchOptions(
  grokCapabilities: GrokCapabilityConfig | undefined | null,
): {
  readonly enableImageSearch?: boolean;
  readonly enableImageUnderstanding?: boolean;
} | undefined {
  const cfg = resolveGrokCapabilityConfig(grokCapabilities);
  const enableImageSearch = cfg.enable_image_search === true;
  const enableImageUnderstanding = cfg.enable_image_understanding === true;
  if (!enableImageSearch && !enableImageUnderstanding) return undefined;
  return {
    ...(enableImageSearch ? { enableImageSearch: true as const } : {}),
    ...(enableImageUnderstanding
      ? { enableImageUnderstanding: true as const }
      : {}),
  };
}

/**
 * Options for LIVE XSearch one-shot native `x_search` (Pattern A).
 */
export function resolveXaiLiveXSearchOptions(
  grokCapabilities: GrokCapabilityConfig | undefined | null,
): {
  readonly enableImageUnderstanding?: boolean;
  readonly enableVideoUnderstanding?: boolean;
} | undefined {
  const cfg = resolveGrokCapabilityConfig(grokCapabilities);
  const enableImageUnderstanding = cfg.enable_image_understanding === true;
  const enableVideoUnderstanding = cfg.enable_video_understanding === true;
  if (!enableImageUnderstanding && !enableVideoUnderstanding) return undefined;
  return {
    ...(enableImageUnderstanding
      ? { enableImageUnderstanding: true as const }
      : {}),
    ...(enableVideoUnderstanding
      ? { enableVideoUnderstanding: true as const }
      : {}),
  };
}

/**
 * Whether LIVE WebSearch should prefer native xAI web_search (default on for
 * Grok via [providers.grok].web_search).
 */
export function isXaiLiveWebSearchEnabled(
  grokCapabilities: GrokCapabilityConfig | undefined | null,
): boolean {
  return resolveGrokCapabilityConfig(grokCapabilities).web_search === true;
}

/**
 * Whether LIVE XSearch is enabled ([providers.grok].x_search default true).
 */
export function isXaiLiveXSearchEnabled(
  grokCapabilities: GrokCapabilityConfig | undefined | null,
): boolean {
  return resolveGrokCapabilityConfig(grokCapabilities).x_search === true;
}

/**
 * Hermes-style credential probe for xAI media/tools availability.
 *
 * True when **either** a stored `/grok-login` OAuth token **or** BYOK
 * (`XAI_API_KEY` / aliases) is present.
 *
 * Cheap path only (no network refresh); actual 401 recovery is on the request.
 */
export function hasXaiCredentials(
  home: HomeContext,
  env?: NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>>,
): boolean {
  if (readXaiOauthAccessToken(home) !== undefined) return true;
  return resolveProviderApiKeyEnvironment("grok", env ?? {}) !== undefined;
}

/**
 * Resolve a bearer for direct xAI REST / Grok inference.
 *
 * **Product rule:** `/grok-login` OAuth **always wins** over env BYOK.
 * Signing in with X means the user wants subscription Grok Build access —
 * leftover `XAI_API_KEY` in the shell must not shadow that.
 *
 * Precedence:
 * 1. Stored OAuth access token (`/grok-login`)
 * 2. Session/factory bearer (often the same OAuth token after resolve)
 * 3. BYOK env (`XAI_API_KEY` → `GROK_API_KEY`)
 */
export function resolveXaiBearerToken(
  home: HomeContext,
  env?: NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>>,
  sessionApiKey?: string,
): string | undefined {
  const oauth = readXaiOauthAccessToken(home);
  if (oauth !== undefined) return oauth;
  const session = sessionApiKey?.trim();
  if (session && session.length > 0) {
    // Prefer session bearer before raw env when it is the OAuth token, but
    // OAuth was already checked. Session key may be BYOK injected by factory.
    // Still prefer OAuth-first: if no oauth, session then BYOK.
    return session;
  }
  return resolveProviderApiKeyEnvironment("grok", env ?? {})?.value;
}

export interface ResolvedGrokProviderCredential {
  readonly value?: string;
  /** True only when the selected value came from stored xAI OAuth. */
  readonly isOAuth: boolean;
}

/** Resolve Grok credentials and the only source distinction consumers need. */
export function resolveGrokProviderCredential(
  home: HomeContext,
  explicitApiKey: string | undefined,
  env: NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>> = {},
): ResolvedGrokProviderCredential {
  const oauth = readXaiOauthAccessToken(home);
  if (oauth !== undefined) {
    return Object.freeze({
      value: oauth,
      isOAuth: true,
    });
  }
  const explicit = explicitApiKey?.trim();
  if (explicit && explicit.toLowerCase() !== "undefined") {
    return Object.freeze({
      value: explicit,
      isOAuth: false,
    });
  }
  const environment = resolveProviderApiKeyEnvironment("grok", env);
  return environment === undefined
    ? Object.freeze({ isOAuth: false })
    : Object.freeze({
        value: environment.value,
        isOAuth: false,
      });
}

/**
 * Resolve the Grok provider API key: OAuth login always beats env BYOK.
 * Used by factory + resolve-provider so one rule owns the product.
 */
export function resolveGrokProviderApiKey(
  home: HomeContext,
  explicitApiKey: string | undefined,
  env?: NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>>,
): string | undefined {
  return resolveGrokProviderCredential(home, explicitApiKey, env).value;
}
