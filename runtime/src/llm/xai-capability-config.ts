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

export function defaultLlmXaiConfig(): Readonly<LlmXaiConfig> {
  return Object.freeze({
    web_search: true,
    x_search: false,
    code_execution: false,
    enable_image_search: false,
    enable_image_understanding: false,
    enable_video_understanding: false,
  });
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/**
 * Merge operator `[llm.xai]` over deliberate defaults.
 */
export function resolveLlmXaiConfig(
  raw: LlmXaiConfig | undefined | null,
): Readonly<LlmXaiConfig> {
  const defaults = defaultLlmXaiConfig();
  if (!raw || typeof raw !== "object") return defaults;
  return Object.freeze({
    web_search: asBoolean(raw.web_search, defaults.web_search === true),
    x_search: asBoolean(raw.x_search, false),
    code_execution: asBoolean(raw.code_execution, false),
    enable_image_search: asBoolean(raw.enable_image_search, false),
    enable_image_understanding: asBoolean(
      raw.enable_image_understanding,
      false,
    ),
    enable_video_understanding: asBoolean(
      raw.enable_video_understanding,
      false,
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

  const webSearch =
    envFlagTrue(env, "AGENC_XAI_WEB_SEARCH") || cfg.web_search === true;
  const xSearch =
    envFlagTrue(env, "AGENC_XAI_X_SEARCH") || cfg.x_search === true;
  const codeExecution =
    envFlagTrue(env, "AGENC_XAI_CODE_EXECUTION") ||
    cfg.code_execution === true;

  const enableImageSearch =
    envFlagTrue(env, "AGENC_XAI_ENABLE_IMAGE_SEARCH") ||
    cfg.enable_image_search === true;
  const enableImageUnderstanding =
    envFlagTrue(env, "AGENC_XAI_ENABLE_IMAGE_UNDERSTANDING") ||
    cfg.enable_image_understanding === true;
  const enableVideoUnderstanding =
    envFlagTrue(env, "AGENC_XAI_ENABLE_VIDEO_UNDERSTANDING") ||
    cfg.enable_video_understanding === true;

  const webSearchOptions: Record<string, unknown> = {};
  if (enableImageSearch) {
    // G5 will map this onto the wire; include early so config is complete.
    webSearchOptions.enableImageSearch = true;
  }
  if (enableImageUnderstanding) {
    webSearchOptions.enableImageUnderstanding = true;
  }

  const xSearchOptions: Record<string, unknown> = {};
  if (enableImageUnderstanding) {
    xSearchOptions.enableImageUnderstanding = true;
  }
  if (enableVideoUnderstanding) {
    xSearchOptions.enableVideoUnderstanding = true;
  }

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

  // Pattern A (G19 dual-bill guard): web_search / x_search flags enable the
  // LIVE one-shot tools (WebSearch / XSearch). They must NOT continuously
  // inject server search tools on every main-loop turn — that double-bills
  // when the model also calls the LIVE tools. Continuous injection is only
  // for code_execution / collections / remote_mcp (no LIVE wrappers).
  // Options still flow to LIVE one-shots via factory extra when explicitly
  // requested by those tools (they force webSearch/xSearch on the one-shot).
  void webSearch;
  void xSearch;
  void webSearchOptions;
  void xSearchOptions;

  return {
    ...(codeExecution ? { codeExecution: true as const } : {}),
    ...(collectionsSearch !== undefined
      ? { collectionsSearch }
      : {}),
    ...(remoteMcpExtra !== undefined ? { remoteMcp: remoteMcpExtra } : {}),
  };
}
