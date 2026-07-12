/**
 * Provider-scoped Grok/xAI capability profile (`[llm.xai]` in config.toml).
 *
 * Pure mapping: AgenCConfig.llm.xai → createProvider() `extra` fields that
 * GrokProvider already understands. Applied only when the session provider is
 * `grok` and the inference host is direct xAI (not OpenRouter / third-party).
 *
 * Defaults (deliberate cost control):
 * - web_search: true (LIVE WebSearch native one-shot path)
 * - x_search / code_execution / image flags / collections / remote_mcp: false
 *
 * @module
 */

import type { LlmXaiConfig } from "../config/schema.js";
import { resolveApiKey } from "../config/env.js";
import { readXaiOauthAccessToken } from "../utils/xaiOauthCredentials.js";
import type { ProviderRuntimeExtra } from "./provider.js";

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
 * under `[llm.xai]`.
 */
export function defaultLlmXaiConfig(): Readonly<LlmXaiConfig> {
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
 * Merge operator `[llm.xai]` over full-surface defaults.
 */
export function resolveLlmXaiConfig(
  raw: LlmXaiConfig | undefined | null,
): Readonly<LlmXaiConfig> {
  const defaults = defaultLlmXaiConfig();
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
  readonly llmXai?: LlmXaiConfig | null;
  /**
   * Env overrides (optional). When set, force flags on regardless of config.
   * Keys match AGENC_XAI_* product env (without prefix): X_SEARCH, CODE_EXECUTION.
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

function envFlagTrue(
  env: Readonly<Record<string, string | undefined>> | undefined,
  key: string,
): boolean {
  if (!env) return false;
  const raw = env[key]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/**
 * Build createProvider() `extra` fields for Grok native capabilities.
 * Returns `{}` when provider is not grok or host is not direct xAI.
 */
export function resolveXaiCapabilityExtra(
  input: ResolveXaiCapabilityExtraInput,
): ProviderRuntimeExtra {
  const provider = (input.provider ?? "").trim().toLowerCase();
  if (provider !== "grok" && provider !== "xai") {
    return {};
  }
  if (!isDirectXaiInferenceHost(input.baseURL)) {
    return {};
  }

  const cfg = resolveLlmXaiConfig(input.llmXai);
  const env = input.env;

  // Search enable flags are consumed by LIVE WebSearch/XSearch (Pattern A),
  // not continuous main-loop injection — see resolveXaiLive* helpers.
  const codeExecution =
    envFlagTrue(env, "AGENC_XAI_CODE_EXECUTION") ||
    cfg.code_execution === true;

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
          servers: remoteMcp.servers.map((server) => ({
            serverUrl: server.server_url,
            serverLabel: server.server_label,
            ...(server.server_description !== undefined
              ? { serverDescription: server.server_description }
              : {}),
            ...(server.allowed_tools !== undefined
              ? { allowedTools: [...server.allowed_tools] }
              : {}),
            ...(server.authorization !== undefined
              ? { authorization: server.authorization }
              : {}),
          })),
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
 * Reads `[llm.xai]` image flags without enabling continuous main-loop search.
 */
export function resolveXaiLiveWebSearchOptions(
  llmXai: LlmXaiConfig | undefined | null,
  env?: Readonly<Record<string, string | undefined>>,
): {
  readonly enableImageSearch?: boolean;
  readonly enableImageUnderstanding?: boolean;
} | undefined {
  const cfg = resolveLlmXaiConfig(llmXai);
  const enableImageSearch =
    envFlagTrue(env, "AGENC_XAI_ENABLE_IMAGE_SEARCH") ||
    cfg.enable_image_search === true;
  const enableImageUnderstanding =
    envFlagTrue(env, "AGENC_XAI_ENABLE_IMAGE_UNDERSTANDING") ||
    cfg.enable_image_understanding === true;
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
  llmXai: LlmXaiConfig | undefined | null,
  env?: Readonly<Record<string, string | undefined>>,
): {
  readonly enableImageUnderstanding?: boolean;
  readonly enableVideoUnderstanding?: boolean;
} | undefined {
  const cfg = resolveLlmXaiConfig(llmXai);
  const enableImageUnderstanding =
    envFlagTrue(env, "AGENC_XAI_ENABLE_IMAGE_UNDERSTANDING") ||
    cfg.enable_image_understanding === true;
  const enableVideoUnderstanding =
    envFlagTrue(env, "AGENC_XAI_ENABLE_VIDEO_UNDERSTANDING") ||
    cfg.enable_video_understanding === true;
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
 * Grok via [llm.xai].web_search).
 */
export function isXaiLiveWebSearchEnabled(
  llmXai: LlmXaiConfig | undefined | null,
  env?: Readonly<Record<string, string | undefined>>,
): boolean {
  if (envFlagTrue(env, "AGENC_XAI_WEB_SEARCH")) return true;
  return resolveLlmXaiConfig(llmXai).web_search === true;
}

/**
 * Whether LIVE XSearch is enabled ([llm.xai].x_search default false).
 */
export function isXaiLiveXSearchEnabled(
  llmXai: LlmXaiConfig | undefined | null,
  env?: Readonly<Record<string, string | undefined>>,
): boolean {
  if (envFlagTrue(env, "AGENC_XAI_X_SEARCH")) return true;
  return resolveLlmXaiConfig(llmXai).x_search === true;
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
  env?: NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>>,
): boolean {
  if (readXaiOauthAccessToken() !== undefined) return true;
  return resolveApiKey(env as NodeJS.ProcessEnv | undefined) !== undefined;
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
 * 3. BYOK env (`XAI_API_KEY` → `GROK_API_KEY` → `AGENC_XAI_API_KEY`)
 */
export function resolveXaiBearerToken(
  env?: NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>>,
  sessionApiKey?: string,
): string | undefined {
  const oauth = readXaiOauthAccessToken();
  if (oauth !== undefined) return oauth;
  const session = sessionApiKey?.trim();
  if (session && session.length > 0) {
    // Prefer session bearer before raw env when it is the OAuth token, but
    // OAuth was already checked. Session key may be BYOK injected by factory.
    // Still prefer OAuth-first: if no oauth, session then BYOK.
    return session;
  }
  return resolveApiKey(env as NodeJS.ProcessEnv | undefined);
}

/**
 * Resolve the Grok provider API key: OAuth login always beats env BYOK.
 * Used by factory + resolve-provider so one rule owns the product.
 */
export function resolveGrokProviderApiKey(
  explicitApiKey: string | undefined,
  env?: NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>>,
): string | undefined {
  const oauth = readXaiOauthAccessToken();
  if (oauth !== undefined) return oauth;
  const explicit = explicitApiKey?.trim();
  if (explicit) return explicit;
  return resolveApiKey(env as NodeJS.ProcessEnv | undefined);
}
